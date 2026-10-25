/*
 * typd-mic -- Typd's microphone helper (0.2.12). One C file; miniaudio (miniaudio.h beside it, public
 * domain / MIT-0, see miniaudio-LICENSE.txt) does the capture: WASAPI on Windows, Core Audio on macOS.
 *
 * Why: Typd used to open the microphone in the pill's web page (getUserMedia + an AudioContext). On a
 * busy Windows laptop Chromium took 1-8 s to hand over the first sample; a plain WASAPI open of the same
 * microphone delivers it in 0.15-0.2 s. Typd's main process (src/main/mic.js) starts this helper once,
 * at launch, with the microphone CLOSED, and drives it over stdin. The device opens only when a
 * dictation starts.
 *
 * In:  one JSON object per line on stdin (flat; strings, numbers):
 *        {"cmd":"list"}                                     the capture devices -> status "devices"
 *        {"cmd":"open","gen":N,"id":"...","name":"..."}     deliver audio as capture N; opens the device
 *                                                           (id, then the same name, then the default;
 *                                                           neither given: the system default)
 *        {"cmd":"sync","gen":N}                             status "synced" once every sample captured so
 *                                                           far has been written
 *        {"cmd":"hold","ms":N}                              stop delivering; keep the device open N ms with
 *                                                           its audio dropped as it arrives, then close it
 *        {"cmd":"close"}                                    close the device now
 *        {"cmd":"quit"}                                     close and exit (stdin closing means the same)
 * Out: frames on stdout, so audio and status can never run into each other:
 *        0xA5 'A' <u32 LE n> <u32 LE gen> <float32 LE samples>   n = 4 + 4 * samples; mono, 16 kHz
 *        0xA5 'S' <u32 LE n> <UTF-8 JSON, n bytes>               {"ev": "hello" | "devices" | "opened" |
 *                                                                 "first-audio" | "synced" | "held" |
 *                                                                 "closed" | "error" | "stopped" |
 *                                                                 "device-changed" | "overflow", ...}
 *
 * Privacy: samples reach stdout only between "open" and "hold"/"close". While held (Typd's short warm
 * window after a dictation) the audio callback returns at once: nothing is copied, stored or written.
 *
 * Priority: the process runs above normal priority (it uses no processor time while idle: every thread
 * waits on stdin, a pipe or the device); miniaudio's capture thread is registered with MMCSS as
 * "Pro Audio" on Windows and is Core Audio's real-time I/O thread on macOS; the writer thread is
 * high priority (Windows) / user-interactive QoS (macOS). A busy PC cannot starve it.
 *
 * Build: node scripts/build-mic.js win | mac arm64 x64.
 */

#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MA_ENABLE_COREAUDIO
#if defined(__APPLE__)
#define MA_NO_RUNTIME_LINKING   /* link CoreAudio/AudioToolbox directly: nothing loaded at run time */
#endif
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#if defined(_WIN32)
#include <io.h>
#include <fcntl.h>
#else
#include <pthread.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <time.h>
#include <dispatch/dispatch.h>
#include <pthread/qos.h>
#endif

#define TYPD_MIC_VERSION "1.0.0"
#define RATE 16000
#define RING_BYTES (4u * 1024u * 1024u)        /* ~65 s of 16 kHz float: main never falls that far behind */
#define FRAME_MAX 4096                          /* samples per audio frame written */
#define MAGIC 0xA5

/* ------------------------------------------------------------------ platform */

#if defined(_WIN32)
typedef volatile LONG atom32;
typedef volatile LONG64 atom64;
#define A32_GET(p) InterlockedCompareExchange((p), 0, 0)
#define A32_SET(p, v) InterlockedExchange((p), (LONG)(v))
#define A64_GET(p) InterlockedCompareExchange64((p), 0, 0)
#define A64_SET(p, v) InterlockedExchange64((p), (LONG64)(v))
static CRITICAL_SECTION q_lock, dev_lock;
static HANDLE wake_ev;
static void lock_init(void) { InitializeCriticalSection(&q_lock); InitializeCriticalSection(&dev_lock); wake_ev = CreateEventW(NULL, FALSE, FALSE, NULL); }
#define Q_LOCK() EnterCriticalSection(&q_lock)
#define Q_UNLOCK() LeaveCriticalSection(&q_lock)
#define DEV_LOCK() EnterCriticalSection(&dev_lock)
#define DEV_UNLOCK() LeaveCriticalSection(&dev_lock)
static void wake(void) { SetEvent(wake_ev); }
static void wait_wake(double ms) { WaitForSingleObject(wake_ev, ms < 0 ? INFINITE : (DWORD)(ms + 0.5)); }
static double now_ms(void) {
  static LARGE_INTEGER f; LARGE_INTEGER c;
  if (!f.QuadPart) QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}
static int out_write(const void *p, size_t n) {
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  const char *b = (const char *)p;
  while (n) {
    DWORD w = 0;
    if (!WriteFile(h, b, (DWORD)(n > 65536 ? 65536 : n), &w, NULL) || !w) return -1;
    b += w; n -= w;
  }
  return 0;
}
static void priority_process(void) { SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS); }
static void priority_thread(void) { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST); }
typedef HANDLE thread_t;
static DWORD WINAPI writer_main_w(LPVOID p);
static void start_writer(thread_t *t) { *t = CreateThread(NULL, 0, writer_main_w, NULL, 0, NULL); }
#else
typedef volatile int atom32;
typedef volatile int64_t atom64;
#define A32_GET(p) __atomic_load_n((p), __ATOMIC_SEQ_CST)
#define A32_SET(p, v) __atomic_store_n((p), (v), __ATOMIC_SEQ_CST)
#define A64_GET(p) __atomic_load_n((p), __ATOMIC_SEQ_CST)
#define A64_SET(p, v) __atomic_store_n((p), (v), __ATOMIC_SEQ_CST)
static pthread_mutex_t q_lock = PTHREAD_MUTEX_INITIALIZER, dev_lock = PTHREAD_MUTEX_INITIALIZER;
static dispatch_semaphore_t wake_sem;
static void lock_init(void) { wake_sem = dispatch_semaphore_create(0); }
#define Q_LOCK() pthread_mutex_lock(&q_lock)
#define Q_UNLOCK() pthread_mutex_unlock(&q_lock)
#define DEV_LOCK() pthread_mutex_lock(&dev_lock)
#define DEV_UNLOCK() pthread_mutex_unlock(&dev_lock)
static void wake(void) { dispatch_semaphore_signal(wake_sem); }   /* never blocks: safe on the I/O thread */
static void wait_wake(double ms) {
  dispatch_semaphore_wait(wake_sem, ms < 0 ? DISPATCH_TIME_FOREVER : dispatch_time(DISPATCH_TIME_NOW, (int64_t)(ms * 1e6)));
}
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000.0 + t.tv_nsec / 1e6; }
static int out_write(const void *p, size_t n) {
  const char *b = (const char *)p;
  while (n) {
    ssize_t w = write(1, b, n);
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) return -1;
    b += w; n -= (size_t)w;
  }
  return 0;
}
static void priority_process(void) { /* raising a process above normal needs root on macOS: the threads ask instead */ }
static void priority_thread(void) { pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0); }
typedef pthread_t thread_t;
static void *writer_main_p(void *p);
static void start_writer(thread_t *t) { pthread_create(t, NULL, writer_main_p, NULL); }
#endif

/* ------------------------------------------------------------------ state */

static ma_context ctx;
static ma_device dev;
static int dev_open = 0;                 /* dev_lock */
static char dev_key[600] = "";           /* what was asked for: "id\nname" ("" = default); dev_lock */
static char dev_name[300] = "";

static atom32 streaming = 0;             /* the callback copies samples only while this is 1 */
static atom32 cur_gen = 0;               /* the capture being delivered */
static atom32 first_gen = 0;             /* the capture whose first callback has been seen */
static volatile double first_at = 0, open_at = 0;
static atom32 stopping = 0;              /* our own stop: its "stopped" notification is not news */
static atom32 lost = 0;                  /* the device stopped by itself (unplugged, ...) */
static atom32 quitting = 0;
static atom32 overflowed = 0;
static atom64 hold_until = 0;            /* ms (now_ms) when a held device closes; 0 = not held */

/* SPSC byte ring: the audio callback writes records {u32 gen, u32 n, n floats}; the writer reads them. */
static unsigned char *ring;
static atom64 ring_w = 0, ring_r = 0;

static void ring_copy_in(uint64_t at, const void *src, size_t n) {
  size_t o = (size_t)(at & (RING_BYTES - 1)), first = RING_BYTES - o;
  if (first >= n) memcpy(ring + o, src, n);
  else { memcpy(ring + o, src, first); memcpy(ring, (const char *)src + first, n - first); }
}
static void ring_copy_out(uint64_t at, void *dst, size_t n) {
  size_t o = (size_t)(at & (RING_BYTES - 1)), first = RING_BYTES - o;
  if (first >= n) memcpy(dst, ring + o, n);
  else { memcpy(dst, ring + o, first); memcpy((char *)dst + first, ring, n - first); }
}

/* Status lines, queued by any thread, written by the writer after the audio before them. */
#define QMAX 64
static char *queue[QMAX];
static int q_n = 0;

static void status(const char *json) {
  size_t n = strlen(json);
  char *c = (char *)malloc(n + 1);
  if (!c) return;
  memcpy(c, json, n + 1);
  Q_LOCK();
  if (q_n < QMAX) queue[q_n++] = c; else free(c);
  Q_UNLOCK();
  wake();
}

/* JSON string escaping into dst (always terminated). */
static void jesc(char *dst, size_t cap, const char *s) {
  size_t o = 0;
  for (; *s && o + 7 < cap; s++) {
    unsigned char ch = (unsigned char)*s;
    if (ch == '"' || ch == '\\') { dst[o++] = '\\'; dst[o++] = (char)ch; }
    else if (ch < 0x20) o += (size_t)snprintf(dst + o, cap - o, "\\u%04x", ch);
    else dst[o++] = (char)ch;
  }
  dst[o] = 0;
}

static void status_error(int gen, const char *stage, ma_result r, const char *msg) {
  char b[512], m[256];
  jesc(m, sizeof m, msg ? msg : ma_result_description(r));
  snprintf(b, sizeof b, "{\"ev\":\"error\",\"gen\":%d,\"stage\":\"%s\",\"code\":%d,\"msg\":\"%s\"}", gen, stage, (int)r, m);
  status(b);
}

/* ------------------------------------------------------------------ device ids */

static void id_to_utf8(const ma_device_id *id, char *out, size_t cap) {
#if defined(_WIN32)
  if (!WideCharToMultiByte(CP_UTF8, 0, (const wchar_t *)id->wasapi, -1, out, (int)cap, NULL, NULL)) out[0] = 0;
#else
  snprintf(out, cap, "%s", id->coreaudio);
#endif
}

static int id_from_utf8(const char *s, ma_device_id *id) {
  memset(id, 0, sizeof *id);
  if (!s || !*s) return 0;
#if defined(_WIN32)
  return MultiByteToWideChar(CP_UTF8, 0, s, -1, (wchar_t *)id->wasapi, (int)(sizeof id->wasapi / sizeof id->wasapi[0]) - 1) > 0;
#else
  if (strlen(s) >= sizeof id->coreaudio) return 0;
  snprintf(id->coreaudio, sizeof id->coreaudio, "%s", s);
  return 1;
#endif
}

static void list_devices(void) {
  ma_device_info *caps = NULL;
  ma_uint32 n = 0, i;
  ma_result r = ma_context_get_devices(&ctx, NULL, NULL, &caps, &n);
  if (r != MA_SUCCESS) { status_error(0, "list", r, NULL); return; }
  size_t cap = 64 + (size_t)n * 1300, o = 0;
  char *b = (char *)malloc(cap);
  if (!b) return;
  o += (size_t)snprintf(b + o, cap - o, "{\"ev\":\"devices\",\"list\":[");
  for (i = 0; i < n; i++) {
    char id[520], ide[600], name[600];
    id_to_utf8(&caps[i].id, id, sizeof id);
    jesc(ide, sizeof ide, id);
    jesc(name, sizeof name, caps[i].name);
    o += (size_t)snprintf(b + o, cap - o, "%s{\"id\":\"%s\",\"name\":\"%s\",\"default\":%s}", i ? "," : "", ide, name, caps[i].isDefault ? "true" : "false");
    if (o >= cap - 8) { o = cap - 8; break; }                 /* never past the buffer (cannot happen: 1,300 B a device) */
  }
  snprintf(b + o, cap - o, "]}");
  status(b);
  free(b);
}

/* ------------------------------------------------------------------ the device */

static void on_data(ma_device *d, void *out, const void *in, ma_uint32 frames) {
  (void)d; (void)out;
  if (!in || !frames || !A32_GET(&streaming)) return;   /* held or closed: dropped here, never stored */
  uint32_t gen = (uint32_t)A32_GET(&cur_gen);
  if ((uint32_t)A32_GET(&first_gen) != gen) { first_at = now_ms(); A32_SET(&first_gen, (int)gen); }
  size_t bytes = 8 + (size_t)frames * 4;
  uint64_t w = (uint64_t)A64_GET(&ring_w), r = (uint64_t)A64_GET(&ring_r);
  if (RING_BYTES - (w - r) < bytes) { A32_SET(&overflowed, 1); wake(); return; }
  uint32_t hdr[2] = { gen, frames };
  ring_copy_in(w, hdr, 8);
  ring_copy_in(w + 8, in, (size_t)frames * 4);
  A64_SET(&ring_w, (int64_t)(w + bytes));
  wake();
}

static void on_note(const ma_device_notification *n) {
  if (n->type == ma_device_notification_type_stopped) {
    if (A32_GET(&stopping)) return;                    /* ours */
    A32_SET(&streaming, 0);
    A32_SET(&lost, 1);
    status("{\"ev\":\"stopped\"}");
  } else if (n->type == ma_device_notification_type_rerouted) {
    status("{\"ev\":\"device-changed\"}");
  }
}

/* dev_lock held. */
static void close_device(const char *why) {
  if (!dev_open) return;
  A32_SET(&streaming, 0);
  A32_SET(&stopping, 1);
  ma_device_uninit(&dev);
  A32_SET(&stopping, 0);
  dev_open = 0;
  dev_key[0] = 0;
  A64_SET(&hold_until, 0);
  A32_SET(&lost, 0);
  char b[200];
  snprintf(b, sizeof b, "{\"ev\":\"closed\",\"why\":\"%s\"}", why);
  status(b);
}

/* dev_lock held. Opens and starts; 0 on success. */
static ma_result init_device(const ma_device_id *id) {
  ma_device_config c = ma_device_config_init(ma_device_type_capture);
  c.capture.pDeviceID = id;
  c.capture.format = ma_format_f32;
  c.capture.channels = 1;
  c.capture.shareMode = ma_share_mode_shared;
  c.sampleRate = RATE;
  c.dataCallback = on_data;
  c.notificationCallback = on_note;
  c.performanceProfile = ma_performance_profile_low_latency;
  c.periodSizeInMilliseconds = 10;
  c.resampling.algorithm = ma_resample_algorithm_linear;
  c.resampling.linear.lpfOrder = MA_MAX_FILTER_ORDER;   /* when miniaudio resamples (macOS): its steepest low-pass */
  c.wasapi.usage = ma_wasapi_usage_pro_audio;           /* MMCSS "Pro Audio" for the capture thread */
  ma_result r = ma_device_init(&ctx, &c, &dev);
  if (r != MA_SUCCESS) return r;
  r = ma_device_start(&dev);
  if (r != MA_SUCCESS) { A32_SET(&stopping, 1); ma_device_uninit(&dev); A32_SET(&stopping, 0); }
  return r;
}

/* Exactly the name, among the capture devices: its id into *out. */
static int find_by_name(const char *name, ma_device_id *out) {
  ma_device_info *caps = NULL;
  ma_uint32 n = 0, i;
  if (!name || !*name || ma_context_get_devices(&ctx, NULL, NULL, &caps, &n) != MA_SUCCESS) return 0;
  for (i = 0; i < n; i++) if (strcmp(caps[i].name, name) == 0) { *out = caps[i].id; return 1; }
  return 0;
}

static void cmd_open(int gen, const char *id, const char *name) {
  char key[600], b[1400], ne[600];
  double t0 = now_ms();
  snprintf(key, sizeof key, "%s\n%s", id ? id : "", name ? name : "");
  DEV_LOCK();
  A64_SET(&hold_until, 0);
  if (dev_open && A32_GET(&lost)) close_device("stopped");
  int warm = dev_open && strcmp(key, dev_key) == 0;
  if (dev_open && !warm) close_device("another device");
  open_at = t0;
  A32_SET(&cur_gen, gen);
  A32_SET(&streaming, 1);                               /* the first callback counts from here */
  const char *how = "warm";
  if (!warm) {
    ma_device_id did;
    ma_result r = MA_DEVICE_NOT_INITIALIZED;
    how = "default";
    if (id && *id && id_from_utf8(id, &did)) { r = init_device(&did); if (r == MA_SUCCESS) how = "id"; }
    if (r != MA_SUCCESS && name && *name && find_by_name(name, &did)) { r = init_device(&did); if (r == MA_SUCCESS) how = "name"; }
    if (r != MA_SUCCESS) { r = init_device(NULL); how = (id && *id) || (name && *name) ? "default (asked-for device not found)" : "default"; }
    if (r != MA_SUCCESS) {
      A32_SET(&streaming, 0);
      DEV_UNLOCK();
      status_error(gen, "open", r, NULL);
      return;
    }
    dev_open = 1;
    snprintf(dev_key, sizeof dev_key, "%s", key);
    snprintf(dev_name, sizeof dev_name, "%s", dev.capture.name);
    priority_process();
  }
  jesc(ne, sizeof ne, dev_name);
  snprintf(b, sizeof b, "{\"ev\":\"opened\",\"gen\":%d,\"how\":\"%s\",\"name\":\"%s\",\"backend\":\"%s\",\"rate\":%u,\"channels\":%u,\"deviceRate\":%u,\"deviceChannels\":%u,\"ms\":%.1f}",
    gen, how, ne, ma_get_backend_name(ctx.backend), dev.sampleRate, dev.capture.channels,
    dev.capture.internalSampleRate, dev.capture.internalChannels, now_ms() - t0);
  DEV_UNLOCK();
  status(b);
}

static void cmd_hold(double ms) {
  DEV_LOCK();
  A32_SET(&streaming, 0);
  if (dev_open) {
    if (ms <= 0) close_device("closed");
    else { A64_SET(&hold_until, (int64_t)(now_ms() + ms)); }
  }
  int open = dev_open;
  DEV_UNLOCK();
  char b[120];
  snprintf(b, sizeof b, "{\"ev\":\"held\",\"open\":%s,\"ms\":%.0f}", open ? "true" : "false", ms);
  status(b);
  wake();
}

/* ------------------------------------------------------------------ the writer */

static unsigned char outbuf[10 + 4 + FRAME_MAX * 4];

static int write_frame(char type, const void *payload, uint32_t n, uint32_t gen, int with_gen) {
  unsigned char h[10];
  uint32_t len = n + (with_gen ? 4 : 0);
  h[0] = MAGIC; h[1] = (unsigned char)type;
  h[2] = (unsigned char)(len & 255); h[3] = (unsigned char)((len >> 8) & 255);
  h[4] = (unsigned char)((len >> 16) & 255); h[5] = (unsigned char)((len >> 24) & 255);
  if (out_write(h, 6)) return -1;
  if (with_gen) {
    unsigned char g[4] = { (unsigned char)(gen & 255), (unsigned char)((gen >> 8) & 255), (unsigned char)((gen >> 16) & 255), (unsigned char)((gen >> 24) & 255) };
    if (out_write(g, 4)) return -1;
  }
  return n ? out_write(payload, n) : 0;
}

static uint32_t last_written_gen = 0;

/* Every record in the ring, coalesced per capture into frames of up to FRAME_MAX samples. */
static int drain(void) {
  float *acc = (float *)outbuf;
  uint32_t acc_n = 0, acc_gen = 0;
  for (;;) {
    uint64_t r = (uint64_t)A64_GET(&ring_r), w = (uint64_t)A64_GET(&ring_w);
    if (w - r < 8) break;
    uint32_t hdr[2];
    ring_copy_out(r, hdr, 8);
    uint32_t gen = hdr[0], n = hdr[1];
    if (acc_n && (gen != acc_gen || acc_n + n > FRAME_MAX)) {
      if (write_frame('A', acc, acc_n * 4, acc_gen, 1)) return -1;
      acc_n = 0;
    }
    if (gen != last_written_gen) {
      char b[160];
      snprintf(b, sizeof b, "{\"ev\":\"first-audio\",\"gen\":%u,\"ms\":%.1f}", gen, (double)first_at - (double)open_at);
      if (write_frame('S', b, (uint32_t)strlen(b), 0, 0)) return -1;
      last_written_gen = gen;
    }
    if (n > FRAME_MAX) {                                 /* a huge device period: pass it through in pieces */
      uint32_t done = 0;
      while (done < n) {
        uint32_t k = n - done > FRAME_MAX ? FRAME_MAX : n - done;
        ring_copy_out(r + 8 + (uint64_t)done * 4, acc, (size_t)k * 4);
        if (write_frame('A', acc, k * 4, gen, 1)) return -1;
        done += k;
      }
    } else {
      ring_copy_out(r + 8, acc + acc_n, (size_t)n * 4);
      acc_n += n;
      acc_gen = gen;
    }
    A64_SET(&ring_r, (int64_t)(r + 8 + (uint64_t)n * 4));
  }
  if (acc_n && write_frame('A', acc, acc_n * 4, acc_gen, 1)) return -1;
  return 0;
}

static int flush_status(void) {
  char *mine[QMAX];
  int n, i, bad = 0;
  Q_LOCK();
  n = q_n;
  memcpy(mine, queue, sizeof(char *) * (size_t)n);
  q_n = 0;
  Q_UNLOCK();
  for (i = 0; i < n; i++) {
    if (!bad && write_frame('S', mine[i], (uint32_t)strlen(mine[i]), 0, 0)) bad = 1;
    free(mine[i]);
  }
  return bad ? -1 : 0;
}

static void writer_loop(void) {
  priority_thread();
  for (;;) {
    double until = (double)A64_GET(&hold_until), wait = -1;
    if (until > 0) { wait = until - now_ms(); if (wait < 0) wait = 0; }
    if (A32_GET(&lost) && wait < 0) wait = 50;
    wait_wake(wait);
    /* Audio first, then the status lines queued meanwhile: "synced" follows every sample before it. */
    if (drain() || flush_status()) { A32_SET(&quitting, 1); break; }
    if (A32_GET(&overflowed)) { A32_SET(&overflowed, 0); status("{\"ev\":\"overflow\"}"); }
    until = (double)A64_GET(&hold_until);
    if ((until > 0 && now_ms() >= until) || A32_GET(&lost)) {
      DEV_LOCK();
      if (dev_open && A32_GET(&lost)) close_device("stopped");
      else if (dev_open && (double)A64_GET(&hold_until) > 0 && now_ms() >= (double)A64_GET(&hold_until)) close_device("warm window over");
      else A32_SET(&lost, 0);
      DEV_UNLOCK();
      if (flush_status()) { A32_SET(&quitting, 1); break; }
    }
    if (A32_GET(&quitting)) { drain(); flush_status(); break; }
  }
}
#if defined(_WIN32)
static DWORD WINAPI writer_main_w(LPVOID p) { (void)p; writer_loop(); return 0; }
#else
static void *writer_main_p(void *p) { (void)p; writer_loop(); return NULL; }
#endif

/* ------------------------------------------------------------------ commands (flat JSON) */

typedef struct { char cmd[32]; char id[520]; char name[520]; double gen, ms; } command;

static const char *ws(const char *p) { while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++; return p; }

static void put_utf8(char *dst, size_t cap, size_t *o, unsigned cp) {
  char b[4]; int n;
  if (cp < 0x80) { b[0] = (char)cp; n = 1; }
  else if (cp < 0x800) { b[0] = (char)(0xC0 | (cp >> 6)); b[1] = (char)(0x80 | (cp & 63)); n = 2; }
  else if (cp < 0x10000) { b[0] = (char)(0xE0 | (cp >> 12)); b[1] = (char)(0x80 | ((cp >> 6) & 63)); b[2] = (char)(0x80 | (cp & 63)); n = 3; }
  else { b[0] = (char)(0xF0 | (cp >> 18)); b[1] = (char)(0x80 | ((cp >> 12) & 63)); b[2] = (char)(0x80 | ((cp >> 6) & 63)); b[3] = (char)(0x80 | (cp & 63)); n = 4; }
  if (*o + (size_t)n < cap) { memcpy(dst + *o, b, (size_t)n); *o += (size_t)n; }
}

static unsigned hex4(const char *p, int *ok) {
  unsigned v = 0; int i;
  for (i = 0; i < 4; i++) {
    char c = p[i]; v <<= 4;
    if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
    else { *ok = 0; return 0; }
  }
  return v;
}

/* A JSON string at p (on its opening quote) into dst; returns the character after it, or NULL. */
static const char *jstr(const char *p, char *dst, size_t cap) {
  size_t o = 0;
  if (*p != '"') return NULL;
  for (p++; *p && *p != '"'; p++) {
    if (*p != '\\') { if (o + 1 < cap) dst[o++] = *p; continue; }
    p++;
    switch (*p) {
      case '"': case '\\': case '/': if (o + 1 < cap) dst[o++] = *p; break;
      case 'b': if (o + 1 < cap) dst[o++] = '\b'; break;
      case 'f': if (o + 1 < cap) dst[o++] = '\f'; break;
      case 'n': if (o + 1 < cap) dst[o++] = '\n'; break;
      case 'r': if (o + 1 < cap) dst[o++] = '\r'; break;
      case 't': if (o + 1 < cap) dst[o++] = '\t'; break;
      case 'u': {
        int ok = 1; unsigned cp = hex4(p + 1, &ok);
        if (!ok) return NULL;
        p += 4;
        if (cp >= 0xD800 && cp < 0xDC00 && p[1] == '\\' && p[2] == 'u') {
          unsigned lo = hex4(p + 3, &ok);
          if (ok && lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); p += 6; }
        }
        put_utf8(dst, cap, &o, cp);
        break;
      }
      default: return NULL;
    }
  }
  if (*p != '"') return NULL;
  dst[o] = 0;
  return p + 1;
}

static int parse(const char *p, command *c) {
  memset(c, 0, sizeof *c);
  p = ws(p);
  if (*p++ != '{') return 0;
  for (;;) {
    char key[32], sval[520];
    p = ws(p);
    if (*p == '}') return c->cmd[0] != 0;
    if (!(p = jstr(p, key, sizeof key))) return 0;
    p = ws(p);
    if (*p++ != ':') return 0;
    p = ws(p);
    if (*p == '"') {
      if (!(p = jstr(p, sval, sizeof sval))) return 0;
      if (!strcmp(key, "cmd")) snprintf(c->cmd, sizeof c->cmd, "%s", sval);
      else if (!strcmp(key, "id")) snprintf(c->id, sizeof c->id, "%s", sval);
      else if (!strcmp(key, "name")) snprintf(c->name, sizeof c->name, "%s", sval);
    } else {
      char *end;
      double v = strtod(p, &end);
      if (end == p) {                                    /* true / false / null */
        if (!strncmp(p, "true", 4)) end = (char *)p + 4;
        else if (!strncmp(p, "false", 5) || !strncmp(p, "null", 4)) end = (char *)p + (p[0] == 'f' ? 5 : 4);
        else return 0;
        v = 0;
      }
      if (!strcmp(key, "gen")) c->gen = v;
      else if (!strcmp(key, "ms")) c->ms = v;
      p = end;
    }
    p = ws(p);
    if (*p == ',') { p++; continue; }
    if (*p == '}') return c->cmd[0] != 0;
    return 0;
  }
}

/* ------------------------------------------------------------------ main */

static int ctx_init(void) {
  ma_context_config cc = ma_context_config_init();
  cc.threadPriority = ma_thread_priority_realtime;
#if defined(_WIN32)
  ma_backend b[] = { ma_backend_wasapi };
#else
  ma_backend b[] = { ma_backend_coreaudio };
#endif
  return ma_context_init(b, 1, &cc, &ctx) == MA_SUCCESS;
}

/* A one-off look for people and CI: typd-mic --version | --list | --probe [ms] */
static int cli(int argc, char **argv) {
  if (!strcmp(argv[1], "--version")) { printf("typd-mic %s (miniaudio %s)\n", TYPD_MIC_VERSION, MA_VERSION_STRING); return 0; }
  if (!ctx_init()) { fprintf(stderr, "typd-mic: no audio backend\n"); return 2; }
  if (!strcmp(argv[1], "--list")) {
    ma_device_info *caps = NULL; ma_uint32 n = 0, i;
    if (ma_context_get_devices(&ctx, NULL, NULL, &caps, &n) != MA_SUCCESS) return 2;
    printf("backend %s, %u capture device(s)\n", ma_get_backend_name(ctx.backend), n);
    for (i = 0; i < n; i++) printf("%s %s\n", caps[i].isDefault ? "*" : " ", caps[i].name);
    return 0;
  }
  if (!strcmp(argv[1], "--probe")) {
    double ms = argc > 2 ? atof(argv[2]) : 1000, t0 = now_ms();
    A32_SET(&cur_gen, 1); A32_SET(&streaming, 1); open_at = t0;
    ring = (unsigned char *)malloc(RING_BYTES);
    if (!ring) return 2;
    ma_result r = init_device(NULL);
    if (r != MA_SUCCESS) { printf("open failed: %s\n", ma_result_description(r)); return 3; }
    double opened = now_ms() - t0;
    while (now_ms() - t0 < ms) {
#if defined(_WIN32)
      Sleep(5);
#else
      usleep(5000);
#endif
    }
    uint64_t bytes = (uint64_t)A64_GET(&ring_w);
    char name[300];
    snprintf(name, sizeof name, "%s", dev.capture.name);
    A32_SET(&stopping, 1);
    ma_device_uninit(&dev);
    printf("device %s: opened in %.1f ms, first audio %.1f ms after the open, %.0f ms of audio in %.0f ms\n",
      name, opened, A32_GET(&first_gen) ? first_at - t0 : -1.0, (double)bytes / 4.0 / RATE * 1000.0, ms);
    return 0;
  }
  fprintf(stderr, "usage: typd-mic [--version | --list | --probe [ms]]  (no argument: Typd's protocol on stdin/stdout)\n");
  return 1;
}

int main(int argc, char **argv) {
  static char line[4096];
  thread_t writer;
  lock_init();
  if (argc > 1) return cli(argc, argv);
#if defined(_WIN32)
  _setmode(_fileno(stdin), _O_BINARY);
#else
  signal(SIGPIPE, SIG_IGN);                              /* Typd gone: write fails, the helper ends */
#endif
  ring = (unsigned char *)malloc(RING_BYTES);
  if (!ring) return 2;
  priority_process();
  start_writer(&writer);
  if (!ctx_init()) {
    status("{\"ev\":\"error\",\"gen\":0,\"stage\":\"context\",\"code\":-1,\"msg\":\"no audio backend\"}");
  } else {
    char b[300];
    snprintf(b, sizeof b, "{\"ev\":\"hello\",\"version\":\"%s\",\"miniaudio\":\"%s\",\"backend\":\"%s\",\"rate\":%d}",
      TYPD_MIC_VERSION, MA_VERSION_STRING, ma_get_backend_name(ctx.backend), RATE);
    status(b);
  }
  while (!A32_GET(&quitting) && fgets(line, sizeof line, stdin)) {
    command c;
    size_t n = strlen(line);
    if (n == sizeof line - 1 && line[n - 1] != '\n') {   /* an over-long line: skip the rest of it */
      int ch; while ((ch = fgetc(stdin)) != EOF && ch != '\n') {}
      status_error(0, "command", MA_INVALID_ARGS, "line too long");
      continue;
    }
    if (!parse(line, &c)) { if (*ws(line)) status_error(0, "command", MA_INVALID_ARGS, "not a command"); continue; }
    if (!strcmp(c.cmd, "list")) list_devices();
    else if (!strcmp(c.cmd, "open")) cmd_open((int)c.gen, c.id, c.name);
    else if (!strcmp(c.cmd, "sync")) { char b[80]; snprintf(b, sizeof b, "{\"ev\":\"synced\",\"gen\":%d}", (int)c.gen); status(b); }
    else if (!strcmp(c.cmd, "hold")) cmd_hold(c.ms);
    else if (!strcmp(c.cmd, "close")) { DEV_LOCK(); A64_SET(&hold_until, 0); if (dev_open) close_device("closed"); else status("{\"ev\":\"closed\",\"why\":\"not open\"}"); DEV_UNLOCK(); }
    else if (!strcmp(c.cmd, "quit")) break;
    else status_error(0, "command", MA_INVALID_ARGS, "unknown command");
  }
  /* quit, or stdin closed (Typd gone): the device closes, then the process ends. */
  DEV_LOCK();
  if (dev_open) close_device("quit");
  DEV_UNLOCK();
  A32_SET(&quitting, 1);
  wake();
#if defined(_WIN32)
  WaitForSingleObject(writer, 2000);
#else
  pthread_join(writer, NULL);
#endif
  ma_context_uninit(&ctx);
  return 0;
}

'use strict';

const asr = require('./asr');
const cleanup = require('./cleanup');
const local = require('./local');
const context = require('./context');
const guards = require('./guards');
const { runStub } = require('./stub');

/**
 * Captured audio in, finished text out. One path.
 *
 *   { type: 'thinking' }
 *   { type: 'partial', text }   cumulative, streamed
 *   { type: 'done',    text }
 *
 * `--stub` still selects the fake, which matters: tuning the overlay should
 * never require a model load or an API call.
 */

/*
 * Events, in the order they occur:
 *   { type: 'thinking' }              capture closed, work started
 *   { type: 'expect', chars }         how much output to expect, once known
 *   { type: 'partial', text }         streamed text, cumulative
 *   { type: 'done',    text }         final text; a local revision adds reviseAdapter, the
 *                                     adapter file it ran with, or false (none loaded)
 *   { type: 'refused', reason, message, text, copy }
 *                                     a revision that must not be pasted (guards.js): nothing
 *                                     changed, the instruction came back, part of the text was
 *                                     dropped, nothing came back, or it ran out of room. The
 *                                     selection stays; `message` is for the pill; `copy` says the
 *                                     result (`text`) may still be wanted, on the clipboard.
 *
 * `expect` exists so the overlay can show real progress rather than a sweep on
 * a timer. It is an estimate and it is honest about being one: dictation is
 * correction rather than rewriting, so the finished text lands within a few
 * percent of the transcript; revision is bounded the same way by the span it
 * replaces. The overlay treats it as a target to approach, never to reach.
 */

/**
 * Which engine turns speech into writing.
 *
 *   single   (default) one local model hears the audio and writes the finished
 *            text. Nothing leaves the machine for dictation.
 *   cascade  Parakeet transcribes locally, Laguna cleans up in the cloud -- the
 *            original pipeline, kept for comparison.
 *
 * Revision always needs a text model to apply the spoken instruction to the
 * highlighted span, so it still calls Laguna; with the single engine the
 * instruction itself is heard by the local model instead of Parakeet.
 */
const ENGINE = (process.env.TYPD_ENGINE || 'single').toLowerCase() === 'cascade' ? 'cascade' : 'single';

/** 30 ms frames whose loudness (RMS) passes 0.006 -- a quiet laptop mic speaking still clears it. */
function voicedFrames(audio) {
  const n = Math.round(0.03 * (audio.sampleRate || 16000));
  const s = audio.samples;
  let count = 0;
  for (let i = 0; i + n <= s.length; i += n) {
    let sum = 0;
    for (let k = i; k < i + n; k++) sum += s[k] * s[k];
    if (Math.sqrt(sum / n) > 0.006) count++;
  }
  return count;
}

/** Output that is nothing but terms from the user's dictionary is the vocabulary echoed back. */
function onlyDictionary(text) {
  const vocab = context.vocabulary();
  if (!vocab) return false;
  const terms = new Set(vocab.split(',').map((t) => t.trim().toLowerCase()));
  const pieces = text.replace(/[.!?]+$/, '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  return pieces.length >= 2 && pieces.every((p) => terms.has(p));
}

/** Roughly how much text a recording turns into: speech runs ~14 characters a second. */
function expectedChars(audio) {
  return Math.round((audio.samples.length / (audio.sampleRate || 16000)) * 14);
}

/**
 * A span's leading and trailing whitespace is not content, and asking a model
 * to reproduce it exactly is asking it to fail eventually. Peel it off, revise
 * the middle, put it back. Deterministic, and it removes a whole class of "the
 * paste ate my newline" defect from a path that overwrites the user's text.
 */
function peel(span) {
  const lead = (span.match(/^\s*/) || [''])[0];
  const tail = (span.match(/\s*$/) || [''])[0];
  return { lead, tail, core: span.slice(lead.length, span.length - tail.length) };
}

/**
 * Models echo their delimiters. The prompt forbids it and mercury-2 did it
 * anyway in half the probe runs, so guard it here too -- but narrowly. Only an
 * output that is wholly wrapped in the tag we sent is unwrapped; a document
 * that legitimately contains one is left alone.
 */
function unwrap(text) {
  const m = text.match(/^\s*<span>\n?([\s\S]*?)\n?<\/span>\s*$/);
  return stripPromptEcho(m ? m[1] : text);
}

/*
 * Given an instruction unlike any it was trained on (a 92 s dictation spoken over a
 * highlighted draft), the model once wrote the first line of its own revise prompt before the
 * text. Never paste the prompt: drop its sentences and any <highlighted_text> wrapper it echoes.
 */
function stripPromptEcho(text) {
  return text
    .replace(/^\s*(?:Revise the highlighted text by following the spoken instruction\.?\s*)?(?:Output only the replacement text\.?\s*)?/i, '')
    .replace(/<\/?highlighted_text>\s*/g, '');
}

/*
 * Spoken revise instructions are short: at most 7.5 s in training, 5.4 s in the test set. Talking
 * for longer over a selection is a dictation meant to replace it, which the revise prompt turns
 * into nonsense. Past this length the speech is transcribed as dictation and pasted over the
 * selection (the paste replaces it either way).
 */
const REVISE_MAX_SECONDS = 20;

/**
 * @param {{mode?: 'dictate'|'revise',
 *          audio: {samples: Float32Array, sampleRate: number}|null,
 *          contextBlock: string|null,
 *          span: string|null,
 *          signal: AbortSignal}} opts
 */
/*
 * The most a revision through the cloud model takes. It is what that path effectively
 * allowed before -- the selection used to be read 8,000 characters at most -- except
 * that a longer one is now refused instead of being cut, rewritten, and pasted over the
 * whole, which lost everything past the cut. (The local model's limit is lower; below.)
 */
const MAX_CLOUD_SPAN = 8000;

// The local model's: what fits its 4,096-token window with the instruction and the rewrite
// (local.js CONTEXT). 3,000 characters / ~450 words in a 2,048-token window until 0.2.3; the
// user's revisions are mostly whole dictations of 500-700 characters. Past ~1,000 words the model
// is unreliable anyway (results/revise_long_check.log, 2026-10-17). In low-memory mode (0.2.6) the
// window is 1,280 tokens: ~1,400 characters / ~250 words (local.reviseLimit()).
const MAX_LOCAL_SPAN = 6000;
const tooMuchLocal = (words = 1000) => `Too much selected — up to ~${words.toLocaleString('en-US')} words`;
const TOO_MUCH_LOCAL = tooMuchLocal(1000);

/*
 * Guard log: every refused revision, one JSON line in <userData>/revise-guards.jsonl -- which guard,
 * what kind of instruction, its words (when they were transcribed), sizes and the numbers it was
 * judged on. Never the selection or the result: those are in the recording, when recordings are
 * kept. Local only, like the recordings; the file is restarted past 512 KB.
 */
function guardLog() {
  if (process.env.TYPD_GUARD_LOG) return process.env.TYPD_GUARD_LOG;
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return require('path').join(electron.app.getPath('userData'), 'revise-guards.jsonl');
    }
  } catch {
    // not running under Electron
  }
  return null;
}

function logGuard(entry) {
  const file = guardLog();
  if (!file) return;
  try {
    const fs = require('fs');
    try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.1'); } catch { /* none yet */ }
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    if (process.env.TYPD_DEBUG) console.log('[typd:guard] could not log', err && err.message);
  }
}

/**
 * Should this revision be refused? The 'refused' event's fields, or null to paste it.
 * `instruction` is called only when the result alone cannot decide (guards.check).
 */
async function judge(span, revised, ranOut, instruction, signal) {
  let verdict;
  let heard = null;
  if (ranOut) {
    // Stopped by the token budget or the window, not by the model: the end of the text is missing.
    const m = guards.measure(span, revised);
    verdict = { refuse: true, reason: 'truncated', kind: null, metrics: { spanWords: m.spanWords, outWords: m.outWords } };
  } else {
    const first = guards.check(span, revised);
    if (first.verdict === 'ask') {
      try {
        heard = String((await instruction()) || '').trim() || null;
      } catch (err) {
        // Not heard (the server is busy, the session was cancelled): judge on the result alone.
        if (process.env.TYPD_DEBUG) console.log('[typd:guard] instruction not transcribed:', err && err.message);
      }
      if (signal && signal.aborted) return null;
    }
    verdict = guards.verdict(span, revised, heard);
  }
  if (process.env.TYPD_DEBUG) console.log('[typd:guard]', verdict.refuse ? 'refused: ' + verdict.reason : 'passed', verdict.kind || '', JSON.stringify(verdict.metrics));
  if (!verdict.refuse) return null;
  logGuard({
    reason: verdict.reason, kind: verdict.kind, instruction: heard,
    spanChars: span.length, outChars: revised.length, metrics: verdict.metrics,
    model: safe(() => local.modelVersion()), adapter: safe(() => (local.REVISE_ADAPTER ? require('path').basename(local.REVISE_ADAPTER) : false))
  });
  return {
    type: 'refused',
    reason: verdict.reason,
    message: guards.MESSAGES[verdict.reason] || guards.MESSAGES.noop,
    // A deletion's result may be what was wanted after all ("keep only the list"): on the clipboard.
    copy: verdict.reason === 'deleted'
  };
}

const safe = (fn) => { try { return fn(); } catch { return null; } };

async function* run(opts = {}) {
  const { audio, contextBlock, span, signal, stream, spanTruncated } = opts;
  let mode = opts.mode || 'dictate';
  if (mode === 'revise' && audio && audio.samples && audio.samples.length / audio.sampleRate > REVISE_MAX_SECONDS) {
    mode = 'dictate';
  }

  yield { type: 'thinking' };

  if (!audio || !audio.samples || !audio.samples.length) {
    throw new Error('No audio captured — check the microphone');
  }
  // A quick tap with nothing said used to paste the dictionary line: given silence, the model
  // echoed the vocabulary it was shown. Measured on 74 real recordings: silent ones had 0-1
  // voiced 30 ms frames, the quietest real word ("Hey.") had 5. Below 3, nothing was said.
  if (voicedFrames(audio) < 3) throw new Error("Didn't catch that");

  if (ENGINE === 'single' && mode !== 'revise') {
    // One model, audio in, finished text out. Screen context goes in its prompt
    // only if model.json says it was trained to read it.
    yield { type: 'expect', chars: expectedChars(audio) };

    let text = '';
    const system = local.contextPrompt(contextBlock);
    const budget = local.dictationBudget(audio.samples, audio.sampleRate);  // dictation only; revise is unbounded
    const source = stream
      ? stream.finish(audio.samples, audio.sampleRate, signal, system, budget)
      : local.dictate(audio.samples, audio.sampleRate, signal, system, budget);
    for await (const partial of source) {
      if (signal && signal.aborted) return;
      text = partial;
      yield { type: 'partial', text };
    }

    const finished = text.trim();
    if (!finished || onlyDictionary(finished)) throw new Error("Didn't catch that");

    yield { type: 'done', text: finished };
    return;
  }

  if (ENGINE === 'single' && mode === 'revise' && local.canRevise()) {
    // The same model hears the instruction and edits the span itself: nothing
    // leaves the machine for revision either.
    if (!span) throw new Error('Nothing selected — highlight some text first');
    // The span is both prompt and answer inside the server's 4,096-token window (see local.js):
    // ~6,000 characters is the most that fits with a spoken instruction and room for the
    // rewrite. Say so instead of failing; local.revise also refuses a span whose tokens do not
    // fit (Turkish or code runs more tokens per character than English prose).
    await local.warm();   // the window is the running server's (low-memory mode: 1,280 tokens)
    const limit = local.reviseLimit ? local.reviseLimit() : { chars: MAX_LOCAL_SPAN, words: 1000 };
    if (spanTruncated || span.length > Math.min(MAX_LOCAL_SPAN, limit.chars)) throw new Error(tooMuchLocal(limit.words));
    const { lead, tail, core } = peel(span);
    yield { type: 'expect', chars: core.length };

    let text = '';
    const info = {};
    // local.revise, not local.dictate with the revise prompt: it is what switches the model's
    // revise adapter on for this one request (model.json "revise_lora").
    for await (const partial of local.revise(audio.samples, audio.sampleRate, signal, core, info)) {
      if (signal && signal.aborted) return;
      text = partial;
      yield { type: 'partial', text };
    }
    if (signal && signal.aborted) return;
    if (info.tooLong) throw new Error(tooMuchLocal(limit.words));

    const revised = unwrap(text).trim();
    // Which revise adapter this request ran with (its file name), or false: a shared item records it.
    const adapter = local.REVISE_ADAPTER;
    const reviseAdapter = adapter ? require('path').basename(adapter) : false;
    // The instruction's words, only if the result alone cannot settle it (guards.js): one short
    // dictation of the instruction audio, on the base model.
    const refusal = await judge(core, revised, info.finish === 'length', () => local.transcribe(audio.samples, audio.sampleRate, signal), signal);
    if (signal && signal.aborted) return;
    if (refusal) {
      yield { ...refusal, text: lead + revised + tail, reviseAdapter };
      return;
    }
    yield { type: 'done', text: lead + revised + tail, reviseAdapter };
    return;
  }

  const transcript = ENGINE === 'single'
    ? await local.transcribe(audio.samples, audio.sampleRate, signal)
    : await asr.transcribe(audio.samples, audio.sampleRate);
  if (signal && signal.aborted) return;

  if (!transcript) throw new Error("Didn't catch that");

  if (mode === 'revise') {
    if (!span) throw new Error('Nothing selected — highlight some text first');
    if (spanTruncated || span.length > MAX_CLOUD_SPAN) throw new Error('Too much selected — up to ~1,200 words');

    const { lead, tail, core } = peel(span);

    yield { type: 'expect', chars: core.length };

    let text = '';
    for await (const partial of cleanup.revise(transcript, core, signal)) {
      if (signal && signal.aborted) return;
      text = partial;
      // Partials are for the overlay only -- nothing is pasted until 'done' --
      // so they can be shown raw without the whitespace dance.
      yield { type: 'partial', text };
    }

    if (signal && signal.aborted) return;
    const revised = unwrap(text).trim();
    const refusal = await judge(core, revised, false, () => Promise.resolve(transcript), signal);
    if (refusal) {
      yield { ...refusal, text: lead + revised + tail };
      return;
    }

    yield { type: 'done', text: lead + revised + tail };
    return;
  }

  yield { type: 'expect', chars: transcript.length };

  let text = '';
  for await (const partial of cleanup.complete(transcript, contextBlock, signal)) {
    if (signal && signal.aborted) return;
    text = partial;
    yield { type: 'partial', text };
  }

  const finished = text.trim();
  if (!finished) throw new Error('The model returned nothing');

  yield { type: 'done', text: finished };
}

/**
 * A feed for audio that arrives while the user talks. A model trained on short pieces
 * (model.json "stream") has them primed as they come (local.openStream); any other has a long
 * dictation's 45-70 s pieces written while the user is still talking (local.openLong), and the
 * full model also the rest of it from 20 s on, so that on release only the last words are left
 * (0.2.10, "work while you talk"). Shorter dictations are untouched. TYPD_EARLY_DECODE=0 turns all
 * of it off. `contextBlock` is a getter: the screen read finishes a beat after the session opens.
 */
function openStream(signal, contextBlock) {
  if (ENGINE !== 'single') return null;
  const system = () => local.contextPrompt(contextBlock());
  if (local.streams()) return local.openStream(signal, system);
  if (process.env.TYPD_EARLY_DECODE === '0') return null;
  return local.openLong(signal, system);
}

/** A session has begun: wake the model while the user talks (and cache the session's prompt). */
function wake(contextBlock) {
  if (ENGINE === 'single') local.ping(contextBlock ? local.contextPrompt(contextBlock) : '');
}

/** Load what can be loaded ahead of time so the first dictation is not slower. */
function warm() {
  return ENGINE === 'single' ? local.warm() : asr.warm();
}

function stop() {
  local.stop();
}

/** A model update landed (modelUpdate.js): restart the server on it, self-test included. */
function switchModel() {
  return ENGINE === 'single' ? local.switchModel() : Promise.resolve();
}

module.exports = {
  run,
  runStub,
  openStream,
  wake,
  warm,
  stop,
  switchModel,
  ENGINE,
  buildContext: context.current,
  buildContextFrom: context.build,

  // Exported for bench/revise.js. Scoring the raw model output would score
  // something the user never sees -- these two are what stands between the
  // completion and the document.
  peel,
  unwrap
};

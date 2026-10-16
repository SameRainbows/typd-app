# Typd injection helper.
#
# Long-lived companion process. Reads one command per line on stdin and answers
# with exactly one line of JSON on stdout. Started once during app launch, so
# the ~350 ms of assembly loading below is never on the user's critical path.
#
# This has to be a script file rather than commands piped into `powershell -`:
# in that mode PowerShell evaluates stdin line by line and never completes a
# multi-line here-string or function definition, so the process just hangs.

$ErrorActionPreference = 'Stop'

# Without this the console encodes stdout as the OEM codepage and every
# non-ASCII character becomes "?" -- which would quietly destroy Turkish context
# and any accented text the speaker is dictating around.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static string Title() {
    var sb = new StringBuilder(512);
    GetWindowTextW(GetForegroundWindow(), sb, 512);
    return sb.ToString();
  }

  public static int Pid() {
    int pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid;
  }

  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();

  // Press and release an unassigned virtual key (0xE8). Sent while Alt is
  // held, it stops Windows treating the Alt as a lone tap that opens menus.
  public static void MaskAlt() {
    keybd_event(0xE8, 0, 0, UIntPtr.Zero);
    keybd_event(0xE8, 0, 2, UIntPtr.Zero);
  }
}
"@

# Node reads line-delimited JSON, so every response must be one line and must be
# flushed immediately -- the default buffering would hold answers indefinitely.
# Mouse side buttons as the Typd key. uiohook only listens, so a side button heard
# there would still be Back in the browser underneath -- and leave a half-written form.
# This hook swallows the one button Typd is bound to and reports it instead, on its own
# thread with its own message loop (a low-level hook needs one). It is installed only
# while a side button is the key ("buttons 4" / "buttons 5"; "buttons 0" removes it),
# so with any other key nothing here runs -- not even the compile, which happens on the
# first "buttons" command rather than at launch. Guarded: if it ever fails to build,
# pasting is untouched and Settings' "press it again" check refuses the button.
$script:Buttons = $null
$script:ButtonsSource = @"
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class TypdButtons {
  delegate IntPtr Proc(int code, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, Proc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  const int WH_MOUSE_LL = 14, WM_XBUTTONDOWN = 0x020B, WM_XBUTTONUP = 0x020C;
  static volatile int armed;           // 0, or the button Typd is bound to: 4 (back), 5 (forward)
  static Proc keep;                    // the delegate must outlive the hook
  static IntPtr hook;
  static uint loopThread;
  static Thread thread;

  static void Say(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }

  static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
    int msg = wParam.ToInt32();
    if (code >= 0 && armed != 0 && (msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP)) {
      MSLL s = (MSLL)Marshal.PtrToStructure(lParam, typeof(MSLL));
      int x = (int)(s.mouseData >> 16);           // XBUTTON1 = 1 (back), XBUTTON2 = 2 (forward)
      int b = x == 1 ? 4 : x == 2 ? 5 : 0;
      if (b == armed) {
        Say("{\"ev\":\"button\",\"b\":" + b + ",\"down\":" + (msg == WM_XBUTTONDOWN ? "true" : "false") + "}");
        return (IntPtr)1;                         // swallowed: the app underneath never sees it
      }
    }
    return CallNextHookEx(hook, code, wParam, lParam);
  }

  public static void Arm(int button) {
    armed = (button == 4 || button == 5) ? button : 0;
    if (armed != 0 && thread == null) {
      var ready = new ManualResetEvent(false);
      bool ok = false;
      thread = new Thread(() => {
        keep = OnMouse;
        hook = SetWindowsHookEx(WH_MOUSE_LL, keep, GetModuleHandle(null), 0);
        loopThread = GetCurrentThreadId();
        ok = hook != IntPtr.Zero;
        ready.Set();
        if (!ok) return;
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
        UnhookWindowsHookEx(hook);
        hook = IntPtr.Zero;
      });
      thread.IsBackground = true;
      thread.Start();
      ready.WaitOne(2000);
      if (!ok) thread = null;
      Say("{\"ev\":\"buttons\",\"armed\":" + armed + ",\"ok\":" + (ok ? "true" : "false") + "}");
      return;
    }
    if (armed == 0 && thread != null) {
      PostThreadMessage(loopThread, 0x0012, IntPtr.Zero, IntPtr.Zero);   // WM_QUIT: unhook and end
      thread = null;
    }
    Say("{\"ev\":\"buttons\",\"armed\":" + armed + ",\"ok\":true}");
  }
}
"@

function Use-Buttons {
  if ($null -eq $script:Buttons) {
    try { Add-Type $script:ButtonsSource; $script:Buttons = $true } catch { $script:Buttons = $false }
  }
  return $script:Buttons
}

function Emit([string] $json) {
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# The clipboard dance, done here rather than through Electron's clipboard because
# Electron can only write text, HTML, RTF and images -- not the formats that keep
# a write private, and not whatever else the user had copied.
#
# Saved: the formats people actually paste back. Every format would be more
# faithful, but asking an app like Excel for all twenty of its delay-rendered
# formats can take long enough to be felt on every paste.
$script:Keep = @('UnicodeText', 'Text', 'OEMText', 'Locale', 'HTML Format', 'Rich Text Format',
                 'PNG', 'Bitmap', 'DeviceIndependentBitmap', 'FileDrop', 'FileNameW', 'Preferred DropEffect')
$script:Saved = $null
$script:OurSeq = 0

# Documented clipboard formats (learn.microsoft.com, "Clipboard Formats"): a
# dictation stays out of Win+V history, cloud clipboard sync and clipboard managers.
function Add-Private($o) {
  foreach ($f in 'ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard') {
    $o.SetData($f, $false, (New-Object System.IO.MemoryStream (, [byte[]](0, 0, 0, 0))))
  }
}

function Save-Clipboard {
  $script:Saved = New-Object System.Windows.Forms.DataObject
  try {
    $cur = [System.Windows.Forms.Clipboard]::GetDataObject()
    if ($null -eq $cur) { return }
    $have = $cur.GetFormats($false)
    foreach ($f in $script:Keep) {
      if ($have -notcontains $f) { continue }
      try {
        $d = $cur.GetData($f, $false)
        if ($null -ne $d) { $script:Saved.SetData($f, $false, $d) }
      } catch { }
    }
  } catch { }
}

# copy = $true: the data is rendered onto the clipboard now. This thread sits in
# ReadLine and pumps no messages, so it could never answer a delayed render.
function Set-Private([string] $text) {
  $o = New-Object System.Windows.Forms.DataObject
  $o.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $false, $text)
  Add-Private $o
  [System.Windows.Forms.Clipboard]::SetDataObject($o, $true, 5, 20)
}

function From-Base64([string] $b64) {
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

# put <base64 text>: save the user's clipboard, write ours privately, Ctrl+V.
# If anything fails the text is left on the clipboard: a dictation is never lost.
function Send-Paste([string] $b64) {
  try {
    $text = From-Base64 $b64
    Save-Clipboard
    Set-Private $text
    $script:OurSeq = [Fg]::GetClipboardSequenceNumber()
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Emit '{"ok":true}'
  } catch {
    Emit (@{ ok = $false; error = "$_" } | ConvertTo-Json -Compress)
  }
}

# copy <base64 text>: leave text on the clipboard for the user to paste themselves.
function Set-Copy([string] $b64) {
  try {
    Set-Private (From-Base64 $b64)
    $script:Saved = $null
    Emit '{"ok":true}'
  } catch {
    Emit (@{ ok = $false; error = "$_" } | ConvertTo-Json -Compress)
  }
}

# Put the user's clipboard back -- unless something has written to it since our
# paste (they copied something), which the sequence number tells us exactly.
function Restore-Clipboard {
  $done = $false
  try {
    if ($null -ne $script:Saved -and [Fg]::GetClipboardSequenceNumber() -eq $script:OurSeq) {
      if ($script:Saved.GetFormats($false).Length -gt 0) {
        Add-Private $script:Saved   # already in their history once; don't add it again
        [System.Windows.Forms.Clipboard]::SetDataObject($script:Saved, $true, 5, 20)
      } else {
        [System.Windows.Forms.Clipboard]::Clear()
      }
      $done = $true
    }
  } catch { }
  $script:Saved = $null
  Emit (@{ ok = $true; restored = $done } | ConvertTo-Json -Compress)
}

function Get-Focus {
  try {
    $target = [Fg]::Pid()
    $name = ''
    try { $name = (Get-Process -Id $target -ErrorAction Stop).ProcessName } catch { }
    Emit (([ordered]@{ ok = $true; process = $name; title = [Fg]::Title() }) | ConvertTo-Json -Compress)
  } catch {
    Emit (@{ ok = $false; error = "$_" } | ConvertTo-Json -Compress)
  }
}

# How much of the focused control to read. RESULTS.md measured the useful
# ceiling at roughly 4K tokens of context; 8000 characters sits comfortably
# under that, and relevance beats volume well before the limit bites.
$script:ContextLimit = 8000

# How much of a highlighted span to read. Far more than any revision accepts (the
# pipeline refuses past a few thousand characters), so "too much selected" is always
# known rather than silently cut; JSON on one line carries this comfortably.
$script:SelectionLimit = 100000

function Get-FocusText {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) { return '' }

    # TextPattern is what editors, browsers and document apps expose.
    $tp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref] $tp)) {
      $text = $tp.DocumentRange.GetText($script:ContextLimit)

      # The top of a long file is the least relevant part of it. If there is a
      # caret, take the window immediately before it instead -- that is what the
      # speaker is actually looking at and dictating into.
      try {
        $sel = $tp.GetSelection()
        if ($sel -and $sel.Length -gt 0) {
          $range = $sel[0].Clone()
          [void] $range.MoveEndpointByUnit(
            [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
            [System.Windows.Automation.Text.TextUnit]::Character,
            - $script:ContextLimit)
          $near = $range.GetText($script:ContextLimit)
          if ($near -and $near.Length -gt 40) { $text = $near }
        }
      } catch { }

      return $text
    }

    # ValuePattern covers single-line inputs: search boxes, address bars, forms.
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref] $vp)) {
      return $vp.Current.Value
    }
  } catch { }
  return ''
}

# What the user has actually highlighted, as opposed to the whole control.
#
# This is the pointer for revision: you select a span with the mouse and speak
# an instruction about it. Everything else in the revise turn is already proven
# -- the clipboard paste overwrites a selection for free -- so whether this
# returns real text in real applications is the load-bearing question.
#
# TextPattern is the only pattern that models a selection. ValuePattern exposes
# a control's whole value and has no concept of one, so single-line inputs are
# reported as unsupported rather than silently returning everything: replacing
# a whole search box when the user highlighted three words would be wrong.
function Get-Selection {
  $out = [ordered]@{
    ok = $true
    process = ''
    title = ''
    method = 'none'
    text = ''
    length = 0
    docLength = 0
    truncated = $false
  }

  try {
    $target = [Fg]::Pid()
    try { $out.process = (Get-Process -Id $target -ErrorAction Stop).ProcessName } catch { }
    $out.title = [Fg]::Title()

    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) {
      $out.method = 'no-focused-element'
      Emit ($out | ConvertTo-Json -Compress)
      return
    }

    $tp = $null
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref] $tp)) {
      $sel = $null
      # Controls that advertise TextPattern may still refuse GetSelection when
      # SupportedTextSelection is None -- that throws rather than returning empty.
      try { $sel = $tp.GetSelection() } catch { $out.method = 'selection-unsupported' }

      if ($sel -and $sel.Length -gt 0) {
        # Read one character past the limit, so a longer selection is known to be longer.
        # It used to be read at ContextLimit (8,000) like the context, and a longer
        # selection came back cut short -- then revised and pasted over the WHOLE of it,
        # losing everything past the cut. Now it is marked, and the pipeline refuses it.
        $text = $sel[0].GetText($script:SelectionLimit + 1)
        if ($null -eq $text) { $text = '' }
        if ($text.Length -gt $script:SelectionLimit) {
          $text = $text.Substring(0, $script:SelectionLimit)
          $out.truncated = $true
        }

        # Chromium's accessibility tree -- so every browser, and every Electron
        # application -- hands back the WHOLE DOCUMENT as the selection when the
        # real selection does not map cleanly onto its range model. Trusting
        # that meant highlighting one sentence and having the entire page
        # rewritten and pasted over it: the single worst thing this feature can
        # do, because the original is gone by the time it is visible.
        #
        # A selection identical to the document is therefore not usable as one.
        # It is either genuine select-all or a control telling us nothing, and
        # the two are indistinguishable from here -- so defer to Ctrl+C, which
        # asks the application directly and happens to be right either way.
        # Just enough of the document to tell "the same text" from "longer than it".
        $doc = ''
        try { $doc = $tp.DocumentRange.GetText($text.Length + 1) } catch { }
        if ($null -eq $doc) { $doc = '' }
        $out.docLength = $doc.Length

        if ($text.Length -gt 0 -and $doc.Length -gt 0 -and $text -eq $doc) {
          $out.method = 'selection-is-whole-document'
        } elseif ($text.Length -gt 0) {
          $out.text = $text
          $out.length = $text.Length
          $out.method = 'text-pattern'
        } else {
          # A caret with nothing highlighted is a degenerate range: the pattern
          # is there and working, there is simply nothing selected.
          $out.method = 'caret-only'
        }
      } elseif ($out.method -eq 'none') {
        $out.method = 'no-selection-range'
      }
    } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref] $vp)) {
      $out.method = 'value-pattern-no-selection'
    } else {
      $out.method = 'no-text-pattern'
    }
  } catch {
    $out.ok = $false
    $out.method = "error: $_"
  }

  Emit ($out | ConvertTo-Json -Compress)
}

# The selection, taken the universal way: copy it and read the clipboard.
#
# UI Automation is the elegant path -- silent, ~8 ms, and it disturbs nothing --
# but bench/selection.js measured it failing outright in Electron chat apps and
# in any control that exposes only ValuePattern. Ctrl+C has no such gaps. It
# works wherever copying works, which is everywhere, because it asks the
# application to do the one thing it already knows how to do.
#
# The hazard is that Ctrl+C with nothing selected leaves the clipboard alone, so
# a naive read returns whatever the user copied an hour ago and calls it a
# selection. A sentinel closes that: write a marker, copy, and if the marker
# survived then nothing was highlighted.
#
# The user's clipboard is put back either way. paste already does this dance, so
# the cost is understood -- what is new here is that we are reading rather than
# writing, and the receiving application needs a moment to answer.
function Get-CopiedSelection {
  $out = [ordered]@{
    ok = $true
    process = ''
    title = ''
    method = 'none'
    text = ''
    length = 0
    ms = 0
  }

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $saved = $null
  $hadText = $false

  try {
    $target = [Fg]::Pid()
    try { $out.process = (Get-Process -Id $target -ErrorAction Stop).ProcessName } catch { }
    $out.title = [Fg]::Title()

    # Text only. Restoring an image or a file list faithfully is a much larger
    # problem, and the clipboard is the user's -- losing its contents to a probe
    # would be a real cost, so anything non-text means we decline to run.
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
      $saved = [System.Windows.Forms.Clipboard]::GetText()
      $hadText = $true
    } elseif ([System.Windows.Forms.Clipboard]::ContainsImage() -or
              [System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      $out.method = 'clipboard-not-text'
      $out.ms = $sw.ElapsedMilliseconds
      Emit ($out | ConvertTo-Json -Compress)
      return
    }

    $marker = 'typd-probe-' + [guid]::NewGuid().ToString('N')
    [System.Windows.Forms.Clipboard]::SetText($marker)

    [System.Windows.Forms.SendKeys]::SendWait('^c')

    # The copy is asynchronous: the keystroke returns long before the target
    # application has serviced it and written to the clipboard. Poll rather than
    # sleep a fixed amount, so a fast app costs 15 ms instead of a flat 150.
    $copied = $marker
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 15
      if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $copied = [System.Windows.Forms.Clipboard]::GetText()
        if ($copied -ne $marker) { break }
      }
    }

    if ($copied -eq $marker) {
      $out.method = 'no-selection'
    } else {
      $out.text = $copied
      $out.length = $copied.Length
      $out.method = 'clipboard'
    }
  } catch {
    $out.ok = $false
    $out.method = "error: $_"
  } finally {
    try {
      if ($hadText) { [System.Windows.Forms.Clipboard]::SetText($saved) }
      else { [System.Windows.Forms.Clipboard]::Clear() }
    } catch { }
  }

  $out.ms = $sw.ElapsedMilliseconds
  Emit ($out | ConvertTo-Json -Compress)
}

function Get-Context {
  try {
    $target = [Fg]::Pid()
    $name = ''
    try { $name = (Get-Process -Id $target -ErrorAction Stop).ProcessName } catch { }

    $text = Get-FocusText
    if ($null -eq $text) { $text = '' }
    if ($text.Length -gt $script:ContextLimit) {
      $text = $text.Substring($text.Length - $script:ContextLimit)
    }

    Emit (([ordered]@{
      ok = $true
      process = $name
      title = [Fg]::Title()
      text = $text
    }) | ConvertTo-Json -Compress)
  } catch {
    Emit (@{ ok = $false; error = "$_" } | ConvertTo-Json -Compress)
  }
}

# Touch both interop paths once here so their setup cost is paid during launch
# rather than on the first real query: ~120 ms for the P/Invoke JIT, ~220 ms for
# UI Automation's COM plumbing. Warm, they answer in single-digit milliseconds.
$null = [Fg]::Title()
try { $null = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { }
Save-Clipboard; $script:Saved = $null   # a read only; ~25 ms of clipboard JIT off the first paste

Emit '{"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }   # stdin closed: the app is going away

  $line = $line.Trim()
  if ($line.StartsWith('put ')) { Send-Paste $line.Substring(4); continue }
  if ($line.StartsWith('copy ')) { Set-Copy $line.Substring(5); continue }
  # No reply in the command queue: it answers with an {"ev":...} line, which inject.js routes
  # to its button listeners rather than to a waiting command.
  if ($line.StartsWith('buttons ')) {
    $n = 0; [void][int]::TryParse($line.Substring(8), [ref]$n)
    if ($n -eq 0 -and $null -eq $script:Buttons) { Emit '{"ev":"buttons","armed":0,"ok":true}' }   # never armed: nothing to remove
    elseif (Use-Buttons) { try { [TypdButtons]::Arm($n) } catch { Emit '{"ev":"buttons","armed":0,"ok":false}' } }
    else { Emit '{"ev":"buttons","armed":0,"ok":false}' }
    continue
  }

  switch ($line) {
    'restore'   { Restore-Clipboard }
    'focus'     { Get-Focus }
    'context'   { Get-Context }
    'selection' { Get-Selection }
    'copysel'   { Get-CopiedSelection }
    'mask'      { [Fg]::MaskAlt() }   # fire and forget: no reply, so it never takes another command's answer
    default   { Emit '{"ok":false,"error":"unknown command"}' }
  }
}

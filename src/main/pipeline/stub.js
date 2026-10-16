'use strict';

/**
 * The pipeline seam.
 *
 * Everything downstream of the hotkey talks to this interface and nothing else.
 * The real implementation (Parakeet -> Laguna -> paste) fills in the same shape;
 * the overlay never learns which one it is talking to.
 *
 *   runStub({ signal }) -> AsyncIterable<Event>
 *
 * Events, in the order they occur:
 *   { type: 'thinking' }                     capture closed, work started
 *   { type: 'partial', text }                streamed text, cumulative
 *   { type: 'done',    text }                final text
 *   { type: 'error',   message }
 *
 * Streaming is not a nicety here. The overlay reveals text as it arrives, so
 * time-to-first-token is the number the user feels -- see bench/latency.py.
 * A pipeline that resolves once with a finished string cannot be animated well,
 * and retrofitting streaming into it later is miserable.
 */

const SAMPLE =
  "I think we should move the retry logic out of the transport layer and into " +
  "the queue consumer. Right now, if the socket drops we lose the whole batch, " +
  "and that's not acceptable. We also need a dead-letter queue for anything " +
  "that fails more than three times.";

// What a revision of SAMPLE looks like coming back: shorter than the original,
// because most spoken revision instructions are about tightening. The overlay
// has to look right revealing a replacement as well as an insertion, and those
// are different shapes -- one grows into empty space, the other is measured
// against text already on screen.
const REVISED =
  "Move the retry logic out of the transport layer and into the queue consumer. " +
  "If the socket drops we lose the whole batch. Anything that fails more than " +
  "three times needs a dead-letter queue.";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(id);
          reject(new Error('aborted'));
        },
        { once: true }
      );
    }
  });

/**
 * Stand-in for the real pipeline.
 *
 * Timings are the measured ones, not invented: 375 ms to first token and ~1.1 s
 * to complete, for Laguna XS 2.1 with thinking off and ~4K of screen context,
 * over a warm connection. See bench/RESULTS.md. Tuning the motion against real
 * latency is the entire reason this stub exists.
 */
async function* runStub({ mode = 'dictate', signal } = {}) {
  const text = mode === 'revise' ? REVISED : SAMPLE;

  yield { type: 'thinking' };
  yield { type: 'expect', chars: text.length };
  await sleep(375, signal);

  // Reveal in word groups, the way a token stream actually arrives.
  const words = text.split(' ');
  let shown = '';
  for (let i = 0; i < words.length; i += 2) {
    shown += (shown ? ' ' : '') + words.slice(i, i + 2).join(' ');
    yield { type: 'partial', text: shown };
    await sleep(36, signal);
  }

  yield { type: 'done', text };
}

module.exports = { runStub, SAMPLE, REVISED };

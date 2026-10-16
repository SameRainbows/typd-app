'use strict';

const https = require('https');

/**
 * Laguna XS 2.1, streaming, thinking off.
 *
 * The transport only. The prompt lives in ./prompts.js because bench/pipeline.py
 * reads them from there too -- a benchmark that scores a copy of the prompt is
 * a benchmark that eventually reports on something you are not shipping.
 */

const HOST = 'inference.poolside.ai';
const PATH = '/v1/chat/completions';
const MODEL = 'poolside/laguna-xs-2.1';

const PROMPTS = require('./prompts');


function apiKey() {
  return process.env.POOLSIDE_API_KEY || '';
}

/**
 * An HTTP failure, said in a sentence.
 *
 * These land in a pill about 216 px wide, in front of someone who is mid-thought
 * and was not expecting to debug anything. `Laguna returned 403: {"error":"plea`
 * -- truncated exactly there, because that is all the room -- tells them nothing
 * and looks broken. The status code is the useful part; the response body almost
 * never is, and it is the part that does not fit.
 *
 * The body is still carried to the console under TYPD_DEBUG, because the person
 * who has to fix a novel failure does want it.
 */
function explain(status, body) {
  if (process.env.TYPD_DEBUG) {
    console.log('[typd:model]', status, String(body || '').slice(0, 400));
  }

  if (status === 401 || status === 403) return 'API key rejected — check POOLSIDE_API_KEY';
  if (status === 404) return 'Model not found — check the model name';
  if (status === 429) return 'Rate limited — try again in a moment';
  if (status === 402) return 'Out of credit on this API key';
  if (status >= 500) return 'The model service is having trouble';
  return 'The model refused the request (' + status + ')';
}

/**
 * Streams a completion. Yields cumulative text so the overlay can render
 * whatever has arrived without reassembling deltas itself.
 *
 * Both modes share this: the SSE framing, the abort wiring and the error
 * handling are transport concerns, and having two copies of them would mean
 * fixing every streaming bug twice.
 *
 * @param {{system: string, user: string, maxTokens?: number, signal?: AbortSignal}} opts
 * @returns {AsyncGenerator<string>}
 */
async function* stream({ system, user, maxTokens = 700, signal }) {
  const key = apiKey();
  if (!key) throw new Error('No API key — set POOLSIDE_API_KEY');

  const payload = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    stream: true,
    // Correction has one right answer. Sampling only buys instability -- the
    // same clip scored 0% and 44% on consecutive runs at 0.2.
    temperature: 0,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false }
  });

  const queue = [];
  let done = false;
  let failure = null;
  let wake = null;

  const push = (item) => {
    queue.push(item);
    if (wake) { wake(); wake = null; }
  };

  const req = https.request(
    {
      host: HOST,
      path: PATH,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': Buffer.byteLength(payload)
      }
    },
    (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          failure = new Error(explain(res.statusCode, body));
          done = true;
          if (wake) { wake(); wake = null; }
        });
        return;
      }

      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const body = line.slice(5).trim();
          if (body === '[DONE]') continue;
          try {
            const event = JSON.parse(body);
            const delta = event.choices && event.choices[0] && event.choices[0].delta;
            if (delta && delta.content) push(delta.content);
          } catch {
            // partial frame; the next chunk completes it
          }
        }
      });
      res.on('end', () => {
        done = true;
        if (wake) { wake(); wake = null; }
      });
    }
  );

  req.on('error', (err) => {
    // Connection-level failures arrive as errno strings -- ENOTFOUND, ECONNRESET
    // -- which are no more use in a pill than a raw status body was.
    const code = err && err.code;
    if (process.env.TYPD_DEBUG) console.log('[typd:model] network', code, err && err.message);

    failure = new Error(
      code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'No connection to the model service'
        : code === 'ETIMEDOUT' || code === 'ECONNRESET' ? 'The model service timed out'
        : 'Could not reach the model service'
    );
    done = true;
    if (wake) { wake(); wake = null; }
  });

  if (signal) {
    signal.addEventListener('abort', () => req.destroy(), { once: true });
  }

  req.end(payload);

  let text = '';
  while (true) {
    if (queue.length) {
      text += queue.shift();
      yield text;
      continue;
    }
    if (failure) throw failure;
    if (done) return;
    await new Promise((resolve) => { wake = resolve; });
  }
}

/** Dictation: raw transcript in, finished writing out. */
function complete(transcript, context, signal) {
  return stream({
    system: PROMPTS.dictate,
    user: (context ? context + '\n\n' : '') +
      '<raw_transcript>\n' + transcript + '\n</raw_transcript>',
    signal
  });
}

/**
 * Revision: a spoken instruction applied to a highlighted span.
 *
 * The span is the user's own writing rather than the untrusted screen text the
 * dictation path fences off, but it is still fenced -- a document can contain
 * anything, including a sentence that reads like an order, and the prompt is
 * explicit that only <instruction> is addressed to the model.
 *
 * The token budget scales with the span: replacing a page means emitting a
 * page, and a fixed 700 would truncate mid-sentence over something the user is
 * about to have overwritten. Four characters to the token is the usual rough
 * ratio, doubled for headroom, and floored so short spans can still grow.
 */
function revise(instruction, span, signal) {
  const budget = Math.min(4000, Math.max(700, Math.ceil(span.length / 4) * 2));

  return stream({
    system: PROMPTS.revise,
    user:
      '<instruction>\n' + instruction + '\n</instruction>\n\n' +
      '<span>\n' + span + '\n</span>',
    maxTokens: budget,
    signal
  });
}

module.exports = { complete, revise, apiKey, MODEL };

'use strict';

const https = require('https');
const tools = require('./tools');
const prompts = require('./prompts');

/**
 * Ask and the agent are the same feature.
 *
 * "How tall is Everest", "what's the latest on the Nvidia earnings" and "play
 * Clair de Lune" all arrive the same way: you hold a key and talk. Splitting
 * them across two hotkeys would push a classification job onto the user that
 * the model does better — and searching the web to answer a question is already
 * an agentic act, so the line was never real.
 *
 * One tool-calling loop handles all of it. The model either calls a tool or
 * answers; if it calls one, the result goes back and it decides again. Routing
 * costs nothing extra because it happens inside a request that was going to be
 * made anyway.
 *
 * Yields progress so the pill can say what it is doing:
 *   { type: 'status', label }   'Searching the web', 'Opening Spotify'
 *   { type: 'action', label }   something happened in the world
 *   { type: 'answer', text }
 */

const HOST = 'inference.poolside.ai';
const PATH = '/v1/chat/completions';
const MODEL = 'poolside/laguna-s-2.1';   // the agentic sibling; see RESULTS.md

const MAX_ROUNDS = 4;   // enough for search → answer, or two actions

function post(payload, key, timeout = 45000) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        path: PATH,
        method: 'POST',
        timeout,
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('Laguna returned ' + res.statusCode + ': ' + text.slice(0, 200)));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error('bad JSON from Laguna: ' + err.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Laguna timed out')); });
    req.end(body);
  });
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {string} transcript   what was said
 * @param {string|null} context screen context block
 * @param {object} host         { launch }
 * @param {AbortSignal} signal
 */
async function* run(transcript, context, host, signal) {
  const key = process.env.POOLSIDE_API_KEY;
  if (!key) throw new Error('POOLSIDE_API_KEY is not set');

  const messages = [
    { role: 'system', content: prompts.agent },
    {
      role: 'user',
      content:
        (context ? context + '\n\n' : '') +
        '<raw_transcript>\n' + transcript + '\n</raw_transcript>'
    }
  ];

  let didAct = false;
  let lastAction = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal && signal.aborted) return;

    const reply = await post(
      {
        model: MODEL,
        messages,
        tools: tools.DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 900,
        chat_template_kwargs: { enable_thinking: false }
      },
      key
    );

    const choice = (reply.choices && reply.choices[0]) || {};
    const message = choice.message || {};
    const calls = message.tool_calls || [];

    if (!calls.length) {
      const text = (message.content || '').trim();

      // If something happened in the world, the world is the confirmation. You
      // hear Clair de Lune start; you see WhatsApp open. Putting a panel over
      // the screen to also *say* it played is a second thing to dismiss for no
      // information. Actions close on the pill, never the panel.
      if (didAct) {
        yield { type: 'acted', label: lastAction || 'Done' };
        return;
      }

      yield { type: 'answer', text: text || "I didn't catch that." };
      return;
    }

    messages.push(message);

    for (const call of calls) {
      if (signal && signal.aborted) return;

      const name = call.function && call.function.name;
      const args = parseArgs(call.function && call.function.arguments);

      // Announce before running: a web search takes seconds and the pill should
      // say why it is still going.
      const pending = name === 'search_web' ? 'Searching the web'
        : name === 'open_app' ? 'Opening ' + (args.app || 'app')
        : name === 'play_music' ? 'Playing ' + (args.query || 'music')
        : name === 'write_text' ? 'Writing in ' + (args.app || 'app')
        : null;
      if (pending) yield { type: 'status', label: pending };

      const outcome = await tools.execute(name, args, host);

      if (tools.ACTIONS.has(name) && outcome.ok) {
        didAct = true;
        lastAction = outcome.action || outcome.result;
        yield { type: 'action', label: lastAction };
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(outcome.result || (outcome.ok ? 'done' : 'failed'))
      });
    }
  }

  yield { type: 'answer', text: "I couldn't finish that." };
}

module.exports = { run, MODEL, MAX_ROUNDS };

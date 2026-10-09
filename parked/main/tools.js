'use strict';

const https = require('https');

/**
 * What the agent is allowed to do.
 *
 * The constraint that shapes everything here: this is driven by voice, with no
 * confirmation step. The user says "play Clair de Lune" and it happens. There is
 * no dialog, no "are you sure", and no undo — so the action surface has to be
 * one where being wrong is survivable.
 *
 * Every tool below is READ-ONLY or LAUNCH-ONLY. Nothing writes a file, deletes
 * anything, sends anything, or spends money. A misheard command opens the wrong
 * app, which costs a keystroke to close. That is the whole safety model, and it
 * only holds while the list stays this boring.
 *
 * `open_app` takes an enum rather than a free string: the model picks from a
 * fixed list and cannot name an arbitrary executable. `open_url` and
 * `play_music` build their URLs here rather than accepting one, so a transcript
 * can supply a search query but never a destination.
 */

// Launch targets. Values are what Windows' shell resolves, not paths -- these
// go to Start-Process, which will not run shell syntax embedded in a name.
const APPS = {
  browser: 'https://www.google.com',
  'youtube music': 'https://music.youtube.com',
  youtube: 'https://www.youtube.com',
  spotify: 'spotify:',
  notepad: 'notepad',
  calculator: 'calc',
  explorer: 'explorer',
  terminal: 'wt',
  settings: 'ms-settings:',
  'task manager': 'taskmgr',
  vscode: 'code',
  discord: 'discord:',
  mail: 'outlookmail:'
};

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'open_app',
      description:
        'Open an application or site on the user\'s computer. Use for "open X", ' +
        '"launch X", "bring up X".',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', enum: Object.keys(APPS), description: 'Which application to open.' }
        },
        required: ['app']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'play_music',
      description:
        'Play MUSIC — a song, album or artist. Only for actual music: "play ' +
        'Clair de Lune", "put on some jazz". Never use this to write, open, ' +
        'search or handle a list; if the request is not about listening to ' +
        'music, this is the wrong tool.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Song, album or artist, as spoken.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Look something up online. Use whenever the answer depends on current ' +
        'facts — news, prices, releases, scores, anything after your training ' +
        'cutoff. Returns snippets to answer from.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_text',
      description:
        'Open an application and type text into it. Use for "write X in ' +
        'Notepad", "make a note of X", "put this in a document". This is the ' +
        'tool for producing text somewhere — never play_music.',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', enum: Object.keys(APPS), description: 'Where to write.' },
          text: { type: 'string', description: 'The text to type, formatted and ready.' }
        },
        required: ['app', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: "The user's current local date and time. Use for anything relative to now.",
      parameters: { type: 'object', properties: {} }
    }
  }
];

/** Tools that change the world rather than report on it. */
const ACTIONS = new Set(['open_app', 'play_music', 'write_text']);

/*
 * A general "click anything by name" tool lived here briefly and has been taken
 * out. It worked -- it could enumerate a window and press buttons -- but it made
 * every request a gamble on the model picking the right control, and a wrong
 * guess clicks something real with no confirmation step in front of it. The
 * failure mode was bad enough to outweigh what it bought.
 *
 * Clicking play is still done, but as one hard-coded step inside play_music
 * where the target is known, rather than as a capability the model can point
 * anywhere. See inject.clickControl.
 */

/* ------------------------------------------------------------------ search */

function duckduckgo(query) {
  return new Promise((resolve) => {
    const url =
      'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' +
      encodeURIComponent(query);

    https
      .get(url, { timeout: 6000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const bits = [];
            if (data.AbstractText) bits.push(data.AbstractText);
            if (data.Answer) bits.push(String(data.Answer));
            for (const topic of (data.RelatedTopics || []).slice(0, 4)) {
              if (topic && topic.Text) bits.push(topic.Text);
            }
            resolve(bits.join('\n').slice(0, 1500));
          } catch {
            resolve('');
          }
        });
      })
      .on('error', () => resolve(''))
      .on('timeout', function () { this.destroy(); resolve(''); });
  });
}

function brave(query, key) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: 'api.search.brave.com',
        path: '/res/v1/web/search?count=5&q=' + encodeURIComponent(query),
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        timeout: 6000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const results = (data.web && data.web.results) || [];
            resolve(
              results
                .slice(0, 5)
                .map((r) => '- ' + r.title + ': ' + (r.description || '').replace(/<[^>]+>/g, ''))
                .join('\n')
                .slice(0, 2000)
            );
          } catch {
            resolve('');
          }
        });
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

async function searchWeb(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  const text = key ? await brave(query, key) : await duckduckgo(query);

  if (text) return text;

  // Saying so beats a silent empty result, which the model would fill in from
  // its own priors while sounding just as confident.
  return key
    ? 'The search returned nothing usable. Say you could not find it.'
    : 'No search backend is configured (set BRAVE_SEARCH_API_KEY for full web ' +
      'results). Answer from your own knowledge and say so if it might be out of date.';
}

/* ------------------------------------------------------------------- music */

/**
 * Turn "clair de lune" into a YouTube video id.
 *
 * `music.youtube.com/search?q=…` opens a results page and sits there — which is
 * what "it opened the page but didn't play" was. `music.youtube.com/watch?v=ID`
 * starts immediately, so the query has to become an id first.
 *
 * The results page embeds its data as JSON in the HTML, and the first videoId in
 * document order is the top result. No key, no quota. Best-effort: if the markup
 * shifts this returns null and the caller falls back to opening the search.
 *
 * The id sits about 750 KB into a 1.25 MB page, well past the chrome and the
 * inline scripts -- so this scans as chunks arrive and hangs up the moment it
 * matches rather than buffering the whole document.
 */
const VIDEO_ID = /"videoId":"([A-Za-z0-9_-]{11})"/;
const MAX_SCAN = 2 * 1024 * 1024;

function resolveTrack(query) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (id) => {
      if (settled) return;
      settled = true;
      resolve(id);
    };

    const req = https.get(
      {
        host: 'www.youtube.com',
        path: '/results?search_query=' + encodeURIComponent(query + ' audio'),
        headers: {
          // Without a browser-ish UA the consent interstitial comes back instead.
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 8000
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          const hit = body.match(VIDEO_ID);
          if (hit) {
            done(hit[1]);
            res.destroy();
            return;
          }
          if (body.length > MAX_SCAN) {
            done(null);
            res.destroy();
          }
        });
        const finish = () => {
          const hit = body.match(VIDEO_ID);
          done(hit ? hit[1] : null);
        };
        res.on('end', finish);
        res.on('close', finish);
      }
    );
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
  });
}

/* ----------------------------------------------------------------- execute */

/**
 * @param {string} name
 * @param {object} args
 * @param {{launch: (target: string) => Promise<any>}} host  the injector
 * @returns {Promise<{ok: boolean, result: string, action?: string}>}
 */
async function execute(name, args, host) {
  try {
    switch (name) {
      case 'open_app': {
        const target = APPS[String(args.app || '').toLowerCase()];
        if (!target) return { ok: false, result: 'No such application: ' + args.app };
        await host.launch(target);
        return { ok: true, result: 'Opened ' + args.app, action: 'Opening ' + args.app };
      }

      case 'play_music': {
        const query = String(args.query || '').trim();
        if (!query) return { ok: false, result: 'No song given' };

        // A search URL opens results and waits for a click -- it never plays.
        // Resolving to a video id first gives a /watch URL, which autoplays.
        const id = await resolveTrack(query);
        await host.launch(
          id
            ? 'https://music.youtube.com/watch?v=' + id
            : 'https://music.youtube.com/search?q=' + encodeURIComponent(query)
        );

        // The page loads paused -- browsers refuse to autoplay audio without a
        // user gesture, whatever the URL says. The media key was the first
        // attempt and it went to whichever app already owned the media session
        // rather than to the new tab. Clicking the actual play button is what
        // works, so wait for the page and press it. YouTube names it "Play (k)",
        // which the starts-with pass reaches from "Play".
        if (id && host.clickControl) {
          for (const wait of [2800, 1800, 1800]) {
            await new Promise((r) => setTimeout(r, wait));
            try {
              await host.clickControl('Play');
              break;
            } catch {
              // page still loading; try again
            }
          }
        }

        return id
          ? { ok: true, result: 'Playing ' + query, action: 'Playing ' + query }
          : {
              ok: true,
              result: 'Could not resolve a track; opened a search for ' + query,
              action: 'Searching for ' + query
            };
      }

      case 'write_text': {
        const target = APPS[String(args.app || '').toLowerCase()];
        const text = String(args.text || '');
        if (!target) return { ok: false, result: 'No such application: ' + args.app };
        if (!text) return { ok: false, result: 'Nothing to write' };
        if (!host.typeText) return { ok: false, result: 'Typing is unavailable' };

        await host.launch(target);
        // The app has to be up and focused before a paste lands anywhere useful.
        await new Promise((r) => setTimeout(r, 1600));
        await host.typeText(text);

        return { ok: true, result: 'Wrote it into ' + args.app, action: 'Writing in ' + args.app };
      }

      case 'search_web': {
        const query = String(args.query || '').trim();
        if (!query) return { ok: false, result: 'No query given' };
        return { ok: true, result: await searchWeb(query), action: 'Searching the web' };
      }

      case 'get_time': {
        const now = new Date();
        return {
          ok: true,
          result: now.toLocaleString(undefined, {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
          })
        };
      }

      default:
        return { ok: false, result: 'Unknown tool: ' + name };
    }
  } catch (err) {
    return { ok: false, result: 'Failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

module.exports = { DEFINITIONS, ACTIONS, APPS, execute, searchWeb };

/**
 * The embeddable widget (master prompt §22).
 *
 * THE ARCHITECTURAL DECISION, AND WHY
 *
 * The widget is split in two: a ~4 KB LOADER that runs on the customer's page,
 * and a FRAME that runs on ours. The loader draws a launcher button and an
 * iframe, and does nothing else. Every message, every piece of model output,
 * and the visitor token all live inside the frame.
 *
 * The alternative — injecting the chat UI directly into the customer's DOM —
 * is smaller and simpler, and it is wrong. It would mean rendering
 * model-authored text, influenced by retrieved documents we did not write,
 * inside our customer's origin. Any escaping mistake in our renderer would
 * become a cross-site scripting hole on their site, with their cookies and
 * their session. Putting that rendering behind an origin boundary means the
 * worst case of a rendering bug is confined to a chat frame that holds one
 * conversation token and nothing else.
 *
 * Two further consequences fall out of it for free:
 *   - `frame-ancestors` becomes available as a real, browser-enforced control
 *     over which sites may embed the chatbot (see origin.ts).
 *   - The customer's page CSS cannot break our layout and ours cannot break
 *     theirs, without either side writing defensive rules.
 *
 * Both scripts are plain ES5-compatible JavaScript held as strings. They are
 * not built, bundled or transpiled: a widget that runs on other people's sites
 * should be auditable by reading it, and a build step between the source and
 * what ships is one more place for something to get in.
 */

/** Content-Security-Policy for the chat frame, minus frame-ancestors. */
export function frameCsp(styleNonce: string): string {
  return [
    // Nothing loads unless a directive below names it.
    "default-src 'none'",
    // Our own frame.js only. No inline script, no CDN, no eval.
    "script-src 'self'",
    // One nonced <style> block. Inline styles are otherwise refused.
    `style-src 'nonce-${styleNonce}'`,
    // XHR back to the API origin that served this frame, and nowhere else.
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The loader, served at /public/widget/v1/moka-chat.js.
 *
 * Deliberately learns its own API origin from `document.currentScript.src`
 * rather than taking it from configuration or from an attribute. There is
 * therefore no way to point an embed at a different backend by editing the
 * snippet, and no build-time origin to get wrong between environments.
 */
export const WIDGET_LOADER_JS = `(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) { return; }

  var publicKey = script.getAttribute('data-moka-key');
  if (!publicKey) {
    console.error('[moka] data-moka-key is missing from the embed snippet.');
    return;
  }

  /*
   * The API origin is derived from where THIS SCRIPT was loaded from. It is
   * not configurable, so an embed cannot be repointed at another backend by
   * editing the snippet on the page.
   */
  var apiOrigin;
  try {
    apiOrigin = new URL(script.src, window.location.href).origin;
  } catch (e) {
    return;
  }

  var position = script.getAttribute('data-moka-position') === 'left' ? 'left' : 'right';
  var launcherLabel = script.getAttribute('data-moka-label') || 'Chat';
  var opened = false;

  /*
   * A closed shadow root. This is about CSS, not security — the host page owns
   * this document and could reach in if it wanted. It means our styles cannot
   * leak onto the customer's site and their reset cannot flatten our button.
   */
  var host = document.createElement('div');
  host.setAttribute('data-moka-chat', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '.wrap { position: fixed; bottom: 20px; ' + position + ': 20px; z-index: 2147483000;',
    '  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '.launcher { display: inline-flex; align-items: center; gap: 8px; height: 48px;',
    '  padding: 0 20px; border: 0; border-radius: 24px; cursor: pointer;',
    '  background: #111827; color: #fff; font-size: 14px; font-weight: 500;',
    '  box-shadow: 0 4px 16px rgba(0,0,0,.18); }',
    '.launcher:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }',
    '.panel { display: none; width: 380px; height: 560px; max-width: calc(100vw - 32px);',
    '  max-height: calc(100vh - 96px); border: 0; border-radius: 16px; overflow: hidden;',
    '  background: #fff; box-shadow: 0 12px 48px rgba(0,0,0,.24); }',
    '.panel.open { display: block; }',
    '.wrap.open .launcher { display: none; }',
  ].join('\\n');

  var wrap = document.createElement('div');
  wrap.className = 'wrap';

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  // textContent, never innerHTML: the label comes from an attribute on the
  // customer's own page, but treating it as markup would be a habit we do not
  // want anywhere in this file.
  launcher.textContent = launcherLabel;
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.setAttribute('aria-expanded', 'false');

  var frame = document.createElement('iframe');
  frame.className = 'panel';
  frame.title = 'Chat';
  /*
   * No sandbox attribute, on purpose. The frame is already cross-origin to
   * this page, so the same-origin policy isolates it completely. Adding
   * allow-scripts WITHOUT allow-same-origin would additionally give it an
   * opaque origin, which would break its own storage and make its API calls
   * arrive with Origin: null — unattributable, and refused by the server.
   */
  frame.setAttribute('referrerpolicy', 'origin');
  frame.setAttribute('loading', 'lazy');

  function open() {
    if (!frame.src) {
      var url = apiOrigin + '/public/widget/v1/frame?k=' + encodeURIComponent(publicKey);
      // The parent origin is passed so the frame can address its control
      // messages precisely instead of broadcasting them with '*'.
      url += '&o=' + encodeURIComponent(window.location.origin);
      frame.src = url;
    }
    opened = true;
    frame.classList.add('open');
    wrap.classList.add('open');
    launcher.setAttribute('aria-expanded', 'true');
  }

  function close() {
    opened = false;
    frame.classList.remove('open');
    wrap.classList.remove('open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  launcher.addEventListener('click', function () { if (!opened) { open(); } });

  window.addEventListener('message', function (event) {
    /*
     * Both checks are required. Comparing origins alone would accept a message
     * from any other frame that happens to be on our origin; comparing source
     * alone would accept one from a frame that was navigated elsewhere.
     */
    if (event.origin !== apiOrigin) { return; }
    if (event.source !== frame.contentWindow) { return; }
    var data = event.data;
    if (!data || data.source !== 'moka-chat') { return; }
    if (data.type === 'close') { close(); }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && opened) { close(); }
  });

  wrap.appendChild(launcher);
  wrap.appendChild(frame);
  root.appendChild(style);
  root.appendChild(wrap);

  function mount() { (document.body || document.documentElement).appendChild(host); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
`;

/**
 * The frame script, served at /public/widget/v1/frame.js and running on OUR
 * origin under the strict CSP above.
 *
 * Every piece of text that came from a model, a document or a visitor is
 * placed with `textContent`. There is no `innerHTML` in this file and no
 * Markdown renderer: rendering model output as markup is how a poisoned
 * knowledge document turns into script execution, and the feature it buys is
 * bold text.
 */
export const WIDGET_FRAME_JS = `(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var publicKey = params.get('k') || '';

  // Where control messages are sent. Validated as an origin, and never used
  // for anything but postMessage targeting.
  var parentOrigin = null;
  try {
    var candidate = params.get('o');
    if (candidate) {
      var parsed = new URL(candidate);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        parentOrigin = parsed.origin;
      }
    }
  } catch (e) { parentOrigin = null; }

  var STORAGE_KEY = 'moka.chat.' + publicKey;
  var state = { token: null, sending: false, closed: false, handoff: false };

  var el = {
    title: document.getElementById('title'),
    log: document.getElementById('log'),
    form: document.getElementById('composer'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    handoff: document.getElementById('handoff'),
    close: document.getElementById('close'),
    status: document.getElementById('status')
  };

  /*
   * sessionStorage rather than localStorage: the conversation belongs to this
   * tab and this visit. A stranger's transcript should not still be sitting in
   * a shared browser tomorrow, and a token that outlives the visit is a token
   * that can be stolen later. Wrapped because storage throws outright in some
   * privacy configurations.
   */
  function loadToken() {
    try { return window.sessionStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function saveToken(token) {
    try { window.sessionStorage.setItem(STORAGE_KEY, token); } catch (e) { /* not fatal */ }
  }

  function setStatus(text) {
    el.status.textContent = text || '';
    el.status.style.display = text ? 'block' : 'none';
  }

  function addMessage(role, text, citations) {
    var row = document.createElement('div');
    row.className = 'msg ' + (role === 'visitor' ? 'me' : role === 'notice' ? 'notice' : 'bot');

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    // textContent. Model output and retrieved document text are never markup.
    bubble.textContent = text;
    row.appendChild(bubble);

    if (citations && citations.length) {
      var list = document.createElement('div');
      list.className = 'cites';
      var label = document.createElement('span');
      label.textContent = 'Based on: ';
      list.appendChild(label);
      for (var i = 0; i < citations.length; i++) {
        var cite = citations[i];
        var chip = document.createElement('span');
        chip.className = 'cite';
        chip.textContent = cite.documentTitle + (cite.page ? ' p.' + cite.page : '');
        list.appendChild(chip);
      }
      row.appendChild(list);
    }

    el.log.appendChild(row);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function api(path, body, method) {
    var headers = { 'content-type': 'application/json' };
    // The public key names the deployment, and therefore the tenant, on every
    // request. The visitor token names one conversation WITHIN it. The server
    // resolves them in that order, so a token is only ever looked up inside
    // the organization its key resolved to.
    headers['x-moka-key'] = publicKey;
    if (state.token) { headers['x-moka-visitor'] = state.token; }
    return fetch(path, {
      method: method || 'POST',
      headers: headers,
      // No cookies. The conversation is identified by the visitor token in a
      // header, which means there is no ambient authority to be abused across
      // origins and nothing for a CSRF to ride on.
      credentials: 'omit',
      body: body ? JSON.stringify(body) : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var message = payload && payload.error && payload.error.message;
          throw new Error(message || 'Something went wrong.');
        }
        return payload;
      });
    });
  }

  function start() {
    var existing = loadToken();
    return api('/public/chat/session', { publicKey: publicKey, resume: existing || null })
      .then(function (result) {
        state.token = result.visitorToken;
        saveToken(result.visitorToken);
        el.title.textContent = result.chatbot.name;
        document.title = result.chatbot.name;

        if (result.messages && result.messages.length) {
          for (var i = 0; i < result.messages.length; i++) {
            addMessage(result.messages[i].role, result.messages[i].content, result.messages[i].citations);
          }
        } else {
          addMessage('assistant', result.chatbot.greeting, null);
        }

        if (result.conversation && result.conversation.status === 'awaiting_human') {
          markHandoff();
        }
        el.input.disabled = false;
        el.input.focus();
      })
      .catch(function (error) {
        setStatus(error.message);
        el.input.disabled = true;
        el.send.disabled = true;
        el.handoff.disabled = true;
      });
  }

  function markHandoff() {
    state.handoff = true;
    el.handoff.disabled = true;
    el.handoff.textContent = 'A person has been asked';
  }

  el.form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (state.sending) { return; }

    var text = el.input.value.trim();
    if (!text) { return; }

    state.sending = true;
    el.send.disabled = true;
    el.input.value = '';
    addMessage('visitor', text, null);
    setStatus('');

    var thinking = document.createElement('div');
    thinking.className = 'msg bot';
    var thinkingBubble = document.createElement('div');
    thinkingBubble.className = 'bubble thinking';
    thinkingBubble.textContent = '…';
    thinking.appendChild(thinkingBubble);
    el.log.appendChild(thinking);
    el.log.scrollTop = el.log.scrollHeight;

    api('/public/chat/messages', { message: text })
      .then(function (result) {
        el.log.removeChild(thinking);
        addMessage('assistant', result.reply, result.citations);
        if (result.suggestHandoff && !state.handoff) {
          el.handoff.classList.add('nudge');
        }
      })
      .catch(function (error) {
        el.log.removeChild(thinking);
        setStatus(error.message);
      })
      .then(function () {
        state.sending = false;
        el.send.disabled = false;
        el.input.focus();
      });
  });

  /*
   * Handoff is a BUTTON, not something the assistant decides to call.
   *
   * A person asking for a person is the one request that must not depend on a
   * model agreeing, and it is the request most likely to be made by someone
   * the bot has just failed. It is also why the customer tool set can stay
   * strictly read-only: nothing the model can do writes anything.
   */
  el.handoff.addEventListener('click', function () {
    if (state.handoff) { return; }
    el.handoff.disabled = true;
    api('/public/chat/handoff', {})
      .then(function () {
        markHandoff();
        addMessage('notice', 'Your conversation has been passed to a person. They will see everything above.', null);
      })
      .catch(function (error) {
        el.handoff.disabled = false;
        setStatus(error.message);
      });
  });

  el.close.addEventListener('click', function () {
    if (parentOrigin) {
      window.parent.postMessage({ source: 'moka-chat', type: 'close' }, parentOrigin);
    }
  });

  start();
})();
`;

/**
 * The frame document.
 *
 * Assembled here rather than kept as a file so that the nonce is bound to one
 * response: a nonce reused across responses is not a nonce, and a CSP that
 * names a predictable one buys nothing.
 */
export function widgetFrameHtml(params: { styleNonce: string; scriptPath: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Chat</title>
<style nonce="${params.styleNonce}">
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #fff; color: #111827;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 8px; padding: 14px 16px;
    border-bottom: 1px solid #e5e7eb; }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; }
  header button { margin-left: auto; border: 0; background: none; cursor: pointer;
    color: #6b7280; font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
  header button:hover { background: #f3f4f6; }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { display: flex; flex-direction: column; gap: 4px; max-width: 88%; }
  .msg.me { align-self: flex-end; align-items: flex-end; }
  .msg.notice { align-self: center; max-width: 100%; }
  .bubble { padding: 9px 12px; border-radius: 14px; background: #f3f4f6; white-space: pre-wrap;
    overflow-wrap: anywhere; }
  .me .bubble { background: #111827; color: #fff; }
  .notice .bubble { background: #fffbeb; color: #92400e; font-size: 12px; text-align: center; }
  .thinking { color: #9ca3af; }
  .cites { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; color: #6b7280; }
  .cite { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 999px; padding: 1px 7px; }
  #status { display: none; margin: 0 16px 8px; padding: 8px 10px; border-radius: 8px;
    background: #fef2f2; color: #b91c1c; font-size: 12px; }
  footer { border-top: 1px solid #e5e7eb; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  #composer { display: flex; gap: 8px; }
  #input { flex: 1; height: 38px; padding: 0 12px; border: 1px solid #e5e7eb; border-radius: 10px;
    font: inherit; outline: none; }
  #input:focus { border-color: #2563eb; }
  #send { height: 38px; padding: 0 14px; border: 0; border-radius: 10px; background: #111827;
    color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
  #send:disabled, #input:disabled { opacity: .5; cursor: not-allowed; }
  #handoff { align-self: flex-start; border: 0; background: none; padding: 0; cursor: pointer;
    color: #6b7280; font: inherit; font-size: 12px; text-decoration: underline; }
  #handoff.nudge { color: #2563eb; font-weight: 500; }
  #handoff:disabled { color: #9ca3af; cursor: default; text-decoration: none; }
  .disclosure { font-size: 11px; color: #9ca3af; }
</style>
</head>
<body>
  <header>
    <h1 id="title">Chat</h1>
    <button id="close" type="button" aria-label="Close chat">&times;</button>
  </header>
  <div id="log" role="log" aria-live="polite"></div>
  <p id="status" role="alert"></p>
  <footer>
    <form id="composer" autocomplete="off">
      <input id="input" type="text" placeholder="Type a message" aria-label="Message" disabled>
      <button id="send" type="submit">Send</button>
    </form>
    <button id="handoff" type="button">Talk to a person</button>
    <!--
      Stated up front rather than buried. A visitor is entitled to know they
      are talking to software before they type anything into it, and several
      jurisdictions now require it.
    -->
    <p class="disclosure">You are chatting with an AI assistant.</p>
  </footer>
  <script src="${params.scriptPath}"></script>
</body>
</html>
`;
}

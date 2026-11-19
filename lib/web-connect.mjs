// Local sign-in wizard for the one-click Gemini Web setup. Magpie opens this page instead of
// gemini.google.com so the flow unfolds in the right order: open a private window first (the
// backend rotates this session and a shared one would sign the user's daily browser out of
// Google), sign in there and copy the Cookie, then tell us the /u/N index that same window
// shows — asking for the index before the window exists was guesswork.
import http from 'node:http';
import crypto from 'node:crypto';
import { launchPrivateBrowser } from './private-browser.mjs';
import { parseCookieInput, parseAuthuser, validateProxyURL } from './setup.mjs';

const GEMINI_APP = 'https://gemini.google.com/app';
const LINGER_MS = 2 * 60 * 1000;
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_MESSAGE = '本次登录等待已到 10 分钟，页面已失效；请在 Magpie 中重新发起登录。已安装的本地后端会保留。';

// esc is the only interpolation into the page template; every user- or config-derived string
// reaches the DOM through textContent / pre-filled values escaped here, never as markup.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// startWebConnect serves the wizard on 127.0.0.1 behind a random token path. submit() runs the
// import pipeline (parse → wait for backend → import → sign-in result) injected by index.mjs so
// this module stays testable without a backend; the resolved value is what wait() hands Magpie.
export async function startWebConnect({ proxy = '', submit, privateBrowser = launchPrivateBrowser, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof submit !== 'function') throw new Error('startWebConnect requires a submit handler');
  const token = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('base64');
  let origin, ended = false, resultValue, error = '', linger, timer, closing, submitting = false;

  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {}); // wait() may never be called if Magpie abandons the sign-in

  function finish(err, value) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    error = err?.message || '';
    resultValue = value;
    if (err) rejectResult(err); else resolveResult(value);
    // Leave the page up briefly so the user can read the outcome before it goes away.
    linger = setTimeout(close, LINGER_MS);
    linger.unref();
  }
  function close() {
    if (closing) return closing;
    if (!ended) finish(new Error('登录页面已关闭，请在 Magpie 中重新登录。'));
    clearTimeout(linger);
    server.close();
    server.closeAllConnections?.();
    closing = Promise.resolve();
    return closing;
  }

  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const json = (res, status, data) => res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) json(res, 502, { error: err.message });
      else res.end();
    });
  });

  async function handle(req, res) {
    const base = `/${token}`;
    const route = req.url;
    if (req.headers.host !== new URL(origin).host ||
        ![base, `${base}/state`, `${base}/open-private`, `${base}/submit`, `${base}/cancel`].includes(route)) {
      res.writeHead(404, headers).end();
      return;
    }
    if (req.method === 'POST' && (req.headers.origin !== origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) {
      res.writeHead(403, headers).end();
      return;
    }
    if (req.method === 'GET' && route === base) {
      res.writeHead(200, {
        ...headers, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
      }).end(PAGE
        // Function replacers: a literal replacement string would re-expand $$ $' $& $` in a
        // proxy password into template metacharacters and corrupt the rendered DOM.
        .replace('NONCE', () => nonce)
        .replace('GEMINI_URL', () => GEMINI_APP)
        .replace('PREFILL_PROXY', () => esc(proxy)));
      return;
    }
    if (req.method === 'GET' && route === `${base}/state`) {
      json(res, 200, { done: ended, error, email: resultValue?.email || '' });
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, headers).end(); return; }
    if (route === `${base}/cancel`) {
      finish(new Error('已取消登录。'));
      res.writeHead(204, headers).end();
      return;
    }
    if (route === `${base}/open-private`) {
      // Read (and drain) the small body so the socket state stays clean.
      await readBody(req);
      if (ended) { json(res, 410, { error: error || '登录已经结束，请回到 Magpie。' }); return; }
      json(res, 200, await privateBrowser(GEMINI_APP));
      return;
    }
    if (route === `${base}/submit`) {
      if (ended) { json(res, 410, { error: error || '登录已经结束，请回到 Magpie。' }); return; }
      // Single-flight, claimed before the first await so a second POST can never race the
      // import pipeline: it gets a 409 while the first submit is still running. The flag is
      // released on failure so the user can fix the fields and retry in place.
      if (submitting) { json(res, 409, { error: '正在验证中，请稍候…' }); return; }
      submitting = true;
      try {
        const body = await readBody(req);
        if (ended) { json(res, 410, { error: error || '登录已经结束，请回到 Magpie。' }); return; }
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          json(res, 400, { error: '请求格式不正确' });
          return;
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          json(res, 400, { error: '请求格式不正确' });
          return;
        }
        // Parse and validate every field before the backend sees anything: a bad cookie or index
        // is reported in place, and the form keeps its values for a retry.
        let cookie, authuser, proxyURL;
        try {
          cookie = parseCookieInput(input.cookie);
          authuser = parseAuthuser(input.authuser);
          proxyURL = validateProxyURL(input.proxy);
        } catch (err) {
          json(res, 400, { error: err.message });
          return;
        }
        try {
          const value = await submit({ cookie, authuser, proxy: proxyURL, isEnded: () => ended });
          if (ended) { json(res, 410, { error: error || '登录已经结束，请回到 Magpie。' }); return; }
          finish(null, value || {});
          json(res, 200, { ok: true, email: resultValue?.email || '' });
        } catch (err) {
          // The import failed (bad cookie, backend unreachable, unsupported build): the page
          // shows the message in place and the user can fix the fields and submit again.
          json(res, ended ? 410 : 400, { error: ended ? (error || '登录已经结束，请回到 Magpie。') : err.message });
        }
        return;
      } finally {
        // A session that is still open retries in place after a failed submit; once it has
        // ended the flag no longer matters (the 410 check above runs first).
        if (!ended) submitting = false;
      }
    }
    res.writeHead(404, headers).end();
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0, tooBig = false;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY && !tooBig) {
          // Drain the rest instead of destroying the socket, so the error answer still
          // reaches the client.
          tooBig = true;
          reject(new Error('提交内容过大'));
          return;
        }
        if (!tooBig) chunks.push(chunk);
      });
      req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', () => { if (!tooBig) reject(new Error('请求中断')); });
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  origin = `http://127.0.0.1:${server.address().port}`;
  timer = setTimeout(() => finish(new Error(TIMEOUT_MESSAGE)), Math.max(1, timeoutMs));
  timer.unref();
  return { url: `${origin}/${token}`, wait: () => result, close };
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 Gemini Web</title>
<style>
:root { color-scheme: light dark; font: 16px/1.7 system-ui, sans-serif; }
body { max-width: 640px; margin: 6vh auto; padding: 0 24px 48px; }
h1 { font-size: 24px; } h2 { font-size: 18px; margin-top: 2em; }
p, li { opacity: .88; }
button { font: inherit; padding: 8px 18px; border-radius: 8px; cursor: pointer; }
textarea, input[type=text] { width: 100%; box-sizing: border-box; font: 13px/1.5 ui-monospace, monospace; padding: 8px; border-radius: 6px; border: 1px solid #8884; background: transparent; color: inherit; }
textarea { min-height: 96px; resize: vertical; }
label { display: block; margin: 14px 0 4px; font-weight: 600; }
.hint { font-size: 13px; opacity: .65; margin-top: 2px; }
.status { min-height: 1.5em; }
.error { color: #d33; }
.ok { color: #187a2e; }
code { user-select: all; }
[hidden] { display: none; }
</style></head><body>
<h1>登录 Gemini Web</h1>

<h2>第 1 步：用无痕窗口打开 Gemini 并登录</h2>
<p>必须使用无痕 / 隐私窗口（推荐 Firefox），不要用平时登录着 Google 的窗口：本地后端会定时刷新这份登录来保活，和日常浏览器共用同一会话会被 Google 整个踢出登录。无痕窗口关掉后会话只留给后端。</p>
<p><button id="open">打开无痕窗口登录 Gemini</button> <button id="cancel" type="button">取消登录</button></p>
<p id="open-status" class="status" role="status" aria-live="polite"></p>
<p id="manual">也可以手动开一个无痕窗口，访问<br><code>GEMINI_URL</code></p>

<h2>第 2 步：复制 Cookie</h2>
<ol>
<li>在无痕窗口里登录要使用的 Google 账号。</li>
<li>按 <kbd>F12</kbd>（macOS 按 <kbd>⌥⌘I</kbd>）打开开发者工具，切到 <b>Network（网络）</b>，刷新页面。</li>
<li>点列表里任意一个 <code>gemini.google.com</code> 请求 → <b>Headers</b> → <b>Request Headers</b>，复制 <code>cookie</code> 一行的完整值。</li>
</ol>
<label for="cookie">Cookie（必填）</label>
<textarea id="cookie" spellcheck="false" placeholder="cookie 请求头的值；也支持 DevTools 表格复制或 JSON 导出"></textarea>
<label for="authuser">Google 账号索引（authuser，可选）</label>
<input type="text" id="authuser" spellcheck="false" placeholder="0">
<p class="hint">对照无痕窗口登录后的地址栏 <code>/u/N/app</code> 填写 <code>N</code>；单账号留空即可（按 0 处理）。无痕窗口的索引可能和日常窗口不同。</p>
<label for="proxy">代理地址（可选）</label>
<input type="text" id="proxy" spellcheck="false" value="PREFILL_PROXY" placeholder="http://127.0.0.1:7890">
<p class="hint">访问 Google 需要代理时填写（http / https / socks5 / socks5h），会绑定到这个账号；留空则不在本次登录指定代理，若本地后端已配置代理池，仍会按后端规则生效。</p>

<h2>第 3 步：验证并完成登录</h2>
<p><button id="submit">验证并完成登录</button></p>
<p id="submit-status" class="status" role="status" aria-live="polite"></p>
<p>Cookie 只保存在本机的 Gemini Web 后端里，不会发到别处。完成后<b>直接关闭无痕窗口，不要点「退出登录」</b>（退出会让这份 Cookie 失效）。</p>

<script nonce="NONCE">
const base = location.pathname;
const openBtn = document.getElementById('open');
const openStatus = document.getElementById('open-status');
const manual = document.getElementById('manual');
const submitBtn = document.getElementById('submit');
const submitStatus = document.getElementById('submit-status');
const cancelBtn = document.getElementById('cancel');
let done = false;

async function post(route, data) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {})
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  // 410 means the session is over (cancel, timeout, Magpie gave up): nothing on the page can
  // still change that, and a retried submit would be refused the same way.
  if (res.status === 410) {
    done = true;
    submitBtn.disabled = openBtn.disabled = true;
    throw new Error((body && body.error) || '登录已经结束，请回到 Magpie 重新发起登录。');
  }
  if (!res.ok) throw new Error((body && body.error) || '本地服务暂时不可用，请重试。');
  return body;
}

openBtn.onclick = async () => {
  openBtn.disabled = true;
  openStatus.className = 'status';
  try {
    const r = await post('/open-private');
    // The manual link stays visible either way: an opened window may be hidden behind others
    // (or refused by an already-running Firefox on macOS), and 'opened: false' explains itself.
    if (r && r.opened) {
      openStatus.textContent = '已用 ' + r.browser + ' 打开无痕窗口。如果窗口没有弹到最前，请在任务栏 / Dock 里找到它，或使用下方链接手动打开。';
    } else {
      openStatus.textContent = (r && r.reason) || '没有找到可启动无痕窗口的浏览器。';
    }
  } catch (err) {
    openStatus.className = 'status error';
    openStatus.textContent = err.message;
  } finally {
    if (!done) openBtn.disabled = false;
  }
};

submitBtn.onclick = async () => {
  submitBtn.disabled = true;
  submitStatus.className = 'status';
  submitStatus.textContent = '正在验证登录…首次使用会先下载并启动本地后端，可能需要几分钟，请不要关闭本页。';
  try {
    const r = await post('/submit', {
      cookie: document.getElementById('cookie').value,
      authuser: document.getElementById('authuser').value,
      proxy: document.getElementById('proxy').value
    });
    done = true;
    submitStatus.className = 'status ok';
    submitStatus.textContent = '登录成功' + (r && r.email ? '，已绑定 ' + r.email : '') + '。现在可以关闭无痕窗口和本页面，回到 Magpie 使用。';
    submitBtn.hidden = true;
    openBtn.disabled = true;
  } catch (err) {
    // An in-place retry is only offered while the session still lives: once done is set
    // (submit succeeded, cancel clicked, or the server answered 410) the form stays down.
    if (done) {
      submitStatus.className = 'status';
      submitStatus.textContent = err.message;
    } else {
      submitStatus.className = 'status error';
      submitStatus.textContent = err.message + '（可修改上方内容后直接重试）';
    }
  } finally {
    if (!done) submitBtn.disabled = false;
  }
};

cancelBtn.onclick = async () => {
  cancelBtn.disabled = true;
  // The session is over the moment the user asks: lock the form now so a submit already in
  // flight cannot light the fields back up or offer a retry that the server would refuse.
  done = true;
  submitBtn.disabled = openBtn.disabled = true;
  try { await post('/cancel'); } catch {}
  submitStatus.className = 'status';
  submitStatus.textContent = '已取消登录，可以关闭本页面。';
};

// If the session ends another way (timeout, Magpie giving up), say so instead of hanging.
async function poll() {
  if (done) return;
  try {
    const r = await fetch(base + '/state', { cache: 'no-store' });
    if (!r.ok) return;
    const state = await r.json();
    if (state.done) {
      done = true;
      submitBtn.disabled = openBtn.disabled = true;
      submitStatus.className = 'status ' + (state.error ? 'error' : 'ok');
      submitStatus.textContent = state.error || '登录已完成，可以关闭本页面。';
      return;
    }
  } catch { return; }
  setTimeout(poll, 2000);
}
poll();
</script></body></html>`;

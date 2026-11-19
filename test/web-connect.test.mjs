import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { startWebConnect } from '../lib/web-connect.mjs';
import { REQUIRED_COOKIES } from '../lib/setup.mjs';

const SIGNED_IN = REQUIRED_COOKIES.map(n => `${n}=v-${n}`).join('; ');

async function fixture({ submit, privateBrowser, timeoutMs } = {}) {
  const seen = [];
  const page = await startWebConnect({
    proxy: 'http://127.0.0.1:7890',
    privateBrowser: privateBrowser || (() => ({ opened: true, browser: 'Firefox' })),
    submit: submit || (async input => { seen.push(input); return { signIn: { type: 'success' }, email: 'bound@gmail.com' }; }),
    timeoutMs
  });
  const origin = new URL(page.url).origin;
  const post = async (route, data, headers = {}) => {
    const res = await fetch(page.url + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
      body: JSON.stringify(data ?? {})
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  return { page, post, seen, origin };
}

describe('web connect wizard', () => {
  it('serves a nonce-protected page on 127.0.0.1 with a token path and no external resources', async () => {
    const { page } = await fixture();
    try {
      assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);
      const res = await fetch(page.url);
      assert.equal(res.status, 200);
      const html = await res.text();
      const nonce = res.headers.get('content-security-policy').match(/nonce-([^']+)/)[1];
      assert.ok(html.includes(`<script nonce="${nonce}">`), 'page script carries the CSP nonce');
      new vm.Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
      assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)[^"'< ]*(cdn|js|css|fonts)/i, 'no external assets');
      assert.match(html, /value="http:\/\/127\.0\.0\.1:7890"/, 'proxy prefilled');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally { await page.close(); }
  });

  it('rejects foreign origins, cross-site posts, rebound hosts and unknown routes', async () => {
    const { page, post } = await fixture();
    try {
      assert.equal((await post('/submit', {}, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post('/open-private', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await post('/nope')).status, 404);
      assert.equal((await fetch(page.url + '/submit')).status, 405);
      const url = new URL(page.url);
      const status = await new Promise((resolve, reject) => {
        http.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'evil.example' } }, res => {
          res.resume(); resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.equal(status, 404);
      // The page outside the token path is not served.
      assert.equal((await fetch(`${new URL(page.url).origin}/`)).status, 404);
    } finally { await page.close(); }
  });

  it('launches the private browser and reports the choice or the manual fallback', async () => {
    const opened = [];
    const { page, post } = await fixture({
      privateBrowser: url => { opened.push(url); return { opened: true, browser: 'Brave' }; }
    });
    try {
      const r = await post('/open-private');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { opened: true, browser: 'Brave' });
      assert.deepEqual(opened, ['https://gemini.google.com/app']);
    } finally { await page.close(); }
    const { page: none, post: postNone } = await fixture({ privateBrowser: () => ({ opened: false, reason: '没有找到可启动无痕窗口的浏览器' }) });
    try {
      const r = await postNone('/open-private');
      assert.deepEqual(r.body, { opened: false, reason: '没有找到可启动无痕窗口的浏览器' });
    } finally { await none.close(); }
  });

  it('validates cookie, authuser and proxy before submit runs, and reports field errors in place', async () => {
    const { page, post, seen } = await fixture();
    try {
      assert.equal(seen.length, 0);
      let r = await post('/submit', { cookie: 'NID=1' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /缺少 SID/);
      r = await post('/submit', { cookie: SIGNED_IN, authuser: '-1' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /账号索引/);
      r = await post('/submit', { cookie: SIGNED_IN, proxy: 'bad-proxy' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /代理地址/);
      r = await post('/submit', { cookie: SIGNED_IN, proxy: 'ftp://x' });
      assert.equal(r.status, 400);
      assert.equal(seen.length, 0, 'nothing reaches the import pipeline until every field parses');
    } finally { await page.close(); }
  });

  it('passes parsed fields to submit, resolves wait() and reports the bound email', async () => {
    const { page, post, seen } = await fixture();
    try {
      const waiting = page.wait();
      const r = await post('/submit', {
        cookie: `cookie: ${SIGNED_IN}`, authuser: '4', proxy: ' http://127.0.0.1:7890 '
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.email, 'bound@gmail.com');
      assert.deepEqual(seen, [{ cookie: SIGNED_IN, authuser: 4, proxy: 'http://127.0.0.1:7890' }]);
      assert.deepEqual(await waiting, { signIn: { type: 'success' }, email: 'bound@gmail.com' });
      // The session is over: further posts are refused.
      assert.equal((await post('/submit', { cookie: SIGNED_IN })).status, 410);
      assert.equal((await post('/open-private')).status, 410);
      const state = await (await fetch(page.url + '/state')).json();
      assert.equal(state.done, true);
      assert.equal(state.email, 'bound@gmail.com');
    } finally { await page.close(); }
  });

  it('keeps the session open after a failed submit so the user can fix the fields and retry', async () => {
    let attempts = 0;
    const { page, post } = await fixture({
      submit: async input => {
        attempts++;
        if (attempts === 1) throw new Error('这个 Cookie 无法登录 Gemini：not signed in');
        return { signIn: { type: 'success' }, email: 'retry@gmail.com' };
      }
    });
    try {
      const waiting = page.wait();
      const first = await post('/submit', { cookie: SIGNED_IN });
      assert.equal(first.status, 400);
      assert.match(first.body.error, /not signed in/);
      const state = await (await fetch(page.url + '/state')).json();
      assert.equal(state.done, false, 'a failed submit never ends the sign-in');
      const second = await post('/submit', { cookie: SIGNED_IN, authuser: '2' });
      assert.equal(second.status, 200);
      assert.equal(second.body.email, 'retry@gmail.com');
      await waiting;
    } finally { await page.close(); }
  });

  it('rejects oversized bodies and malformed JSON', async () => {
    const { page, origin } = await fixture();
    try {
      const big = await fetch(page.url + '/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: `{"cookie":"${'x'.repeat(300 * 1024)}"}`
      });
      assert.equal(big.status, 502);
      assert.match((await big.json()).error, /过大/);
      const malformed = await fetch(page.url + '/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: 'not json'
      });
      assert.equal(malformed.status, 400);
      assert.match((await malformed.json()).error, /格式/);
    } finally { await page.close(); }
  });

  it('rejects wait() on cancel and expires when the deadline passes', async () => {
    const { page, post } = await fixture();
    const waiting = page.wait();
    assert.equal((await post('/cancel')).status, 204);
    await assert.rejects(waiting, /取消/);
    await page.close();

    const { page: timed } = await fixture({ timeoutMs: 30 });
    let watch;
    try {
      watch = new Promise(resolve => setTimeout(resolve, 2000));
      await assert.rejects(timed.wait(), /10 分钟/);
      const state = await (await fetch(timed.url + '/state')).json();
      assert.equal(state.done, true);
      assert.match(state.error, /10 分钟/);
    } finally {
      await timed.close();
      await watch; // drain the event-loop anchor
    }
  });
});

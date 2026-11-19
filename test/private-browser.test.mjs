import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { launchPrivateBrowser, geminiURL } from '../lib/private-browser.mjs';

// launchPrivateBrowser never spawns here: deps inject platform, env, existence and spawn so the
// whole matrix runs offline.
function fakeChild() {
  const child = new EventEmitter();
  child.unref = () => { child.unrefCalled = true; };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}
function spawned(spawnCalls) {
  return (bin, args, opts) => {
    spawnCalls.push({ bin, args, opts });
    return fakeChild();
  };
}
const only = (...files) => p => files.includes(p);
const none = () => false;

describe('private browser launcher', () => {
  it('only opens https://gemini.google.com URLs', async () => {
    for (const bad of [
      'http://gemini.google.com/app', 'https://evil.example', 'https://google.com',
      'https://gemini.google.com.evil.example/app', 'https://user:pass@gemini.google.com/app',
      'file:///etc/passwd', 'not a url', '', null, undefined
    ]) {
      const r = await launchPrivateBrowser(bad, { platform: 'linux', env: { PATH: '/usr/bin' }, existsSync: only('/usr/bin/firefox'), spawn: spawned([]) });
      assert.equal(r.opened, false, String(bad));
      assert.match(r.reason, /gemini\.google\.com/);
    }
    assert.equal(geminiURL('https://gemini.google.com/u/4/app'), 'https://gemini.google.com/u/4/app');
    assert.equal(geminiURL('https://gemini.google.com/app?hl=zh-CN'), 'https://gemini.google.com/app?hl=zh-CN');
  });

  it('prefers Firefox with a detached private window on macOS', async () => {
    const calls = [];
    const ff = '/Applications/Firefox.app/Contents/MacOS/firefox';
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'darwin', env: { HOME: '/Users/t' }, existsSync: only(ff), spawn: spawned(calls)
    });
    assert.deepEqual(r, { opened: true, browser: 'Firefox' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, ff);
    assert.deepEqual(calls[0].args, ['-private-window', 'https://gemini.google.com/app']);
    assert.deepEqual(calls[0].opts, { detached: true, stdio: 'ignore' });
  });

  it('falls through missing and broken installs on macOS', async () => {
    const calls = [];
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    // Chrome present but refuses to spawn; Edge takes over.
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'darwin',
      env: { HOME: '/Users/t' },
      existsSync: only(chrome, edge),
      spawn: (bin, args, opts) => {
        if (bin === chrome) throw new Error('EACCES');
        calls.push({ bin, args, opts });
        return fakeChild();
      }
    });
    assert.deepEqual(r, { opened: true, browser: 'Microsoft Edge' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, edge);
    assert.deepEqual(calls[0].args, ['--inprivate', 'https://gemini.google.com/app']);
  });

  it('finds browsers under Program Files and LOCALAPPDATA on Windows', async () => {
    const calls = [];
    const ff = path.join('C:\\PF', 'Mozilla Firefox', 'firefox.exe');
    const edge = path.join('C:\\Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' };
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'win32', env, existsSync: only(ff, edge), spawn: spawned(calls)
    });
    assert.deepEqual(r, { opened: true, browser: 'Firefox' });
    assert.equal(calls[0].bin, ff);
    assert.deepEqual(calls[0].args, ['-private-window', 'https://gemini.google.com/app']);
  });

  it('uses Chrome incognito on Windows when Firefox is absent', async () => {
    const calls = [];
    const chrome = path.join('C:\\PF86', 'Google', 'Chrome', 'Application', 'chrome.exe');
    const env = { 'ProgramFiles(x86)': 'C:\\PF86' };
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'win32', env, existsSync: only(chrome), spawn: spawned(calls)
    });
    assert.deepEqual(r, { opened: true, browser: 'Google Chrome' });
    assert.deepEqual(calls[0].args, ['--incognito', 'https://gemini.google.com/app']);
  });

  it('looks browsers up on PATH on Linux, Firefox first', async () => {
    const calls = [];
    const env = { PATH: `/usr/bin${path.delimiter}/opt/bin` };
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'linux', env,
      existsSync: only('/opt/bin/chromium', '/usr/bin/firefox'), spawn: spawned(calls)
    });
    assert.deepEqual(r, { opened: true, browser: 'Firefox' });
    assert.equal(calls[0].bin, '/usr/bin/firefox');
    assert.deepEqual(calls[0].args, ['--private-window', 'https://gemini.google.com/app']);
  });

  it('supports firefox-esr and the Chromium/Edge name variants on Linux', async () => {
    for (const [files, browser, flag] of [
      [['/usr/bin/firefox-esr'], 'Firefox', '--private-window'],
      [['/usr/bin/google-chrome-stable'], 'Google Chrome', '--incognito'],
      [['/usr/bin/chromium-browser'], 'Chromium', '--incognito'],
      [['/usr/bin/brave-browser'], 'Brave', '--incognito'],
      [['/usr/bin/microsoft-edge-stable'], 'Microsoft Edge', '--inprivate']
    ]) {
      const calls = [];
      const r = await launchPrivateBrowser('https://gemini.google.com/app', {
        platform: 'linux', env: { PATH: '/usr/bin' }, existsSync: only(...files), spawn: spawned(calls)
      });
      assert.deepEqual(r, { opened: true, browser }, files[0]);
      assert.equal(calls[0].args[0], flag);
    }
  });

  // A bad binary fails spawn asynchronously ('error' on the next tick), not through a
  // synchronous throw: it must be caught by the launcher instead of crashing the host, must
  // not report a phantom success, and must hand the turn to the next candidate.
  it('catches an async spawn error and falls through to the next candidate', async () => {
    const calls = [];
    const firefox = '/usr/bin/firefox';
    const chromium = '/usr/bin/chromium';
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      existsSync: only(firefox, chromium),
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        const child = new EventEmitter();
        child.unref = () => {};
        if (bin === firefox) {
          const err = new Error('spawn EACCES');
          err.code = 'EACCES';
          queueMicrotask(() => child.emit('error', err));
        } else {
          queueMicrotask(() => child.emit('spawn'));
        }
        return child;
      }
    });
    assert.deepEqual(r, { opened: true, browser: 'Chromium' });
    assert.deepEqual(calls.map(c => c.bin), [firefox, chromium]);
    assert.deepEqual(calls[1].args, ['--incognito', 'https://gemini.google.com/app']);
  });

  it('reports no browser when every candidate fails to spawn asynchronously', async () => {
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      existsSync: only('/usr/bin/firefox'),
      spawn: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return child;
      }
    });
    assert.equal(r.opened, false);
    assert.match(r.reason, /没有找到/);
  });

  it('tolerates a late error emitted after the browser already spawned', async () => {
    const r = await launchPrivateBrowser('https://gemini.google.com/app', {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      existsSync: only('/usr/bin/firefox'),
      spawn: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => {
          child.emit('spawn');
          child.emit('error', new Error('late stream failure'));
        });
        return child;
      }
    });
    assert.deepEqual(r, { opened: true, browser: 'Firefox' });
  });

  it('reports no browser when nothing is installed', async () => {
    for (const [platform, env] of [
      ['darwin', { HOME: '/Users/t' }],
      ['win32', { ProgramFiles: 'C:\\PF' }],
      ['linux', { PATH: '/usr/bin' }]
    ]) {
      const calls = [];
      const r = await launchPrivateBrowser('https://gemini.google.com/app', { platform, env, existsSync: none, spawn: spawned(calls) });
      assert.equal(r.opened, false, platform);
      assert.match(r.reason, /没有找到/);
      assert.equal(calls.length, 0, 'never spawns a missing binary');
    }
  });
});

// Launch the Gemini app in a private/incognito browser window. The sign-in session the backend
// keeps alive must not be shared with the user's daily browser: Google would revoke it on both
// sides. Firefox is preferred because Chrome's DBSC can re-bind a copied session to a profile
// the user already closed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const GEMINI_HOST = /^(www\.)?gemini\.google\.com$/i;
// Firefox takes -private-window on macOS/Windows and --private-window on Linux; both spellings
// work everywhere, but each platform's conventional one is used.
const privateArg = { darwin: '-private-window', win32: '-private-window', linux: '--private-window' };
const PRIVATE_ARG = {
  firefox: platform => privateArg[platform] || '--private-window',
  chromium: '--incognito',
  edge: '--inprivate'
};

// geminiURL restricts launches to the Gemini app: the wizard only ever sends users to Google,
// and a token-guessed local page must not be turned into an open-anything primitive.
export function geminiURL(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !GEMINI_HOST.test(parsed.hostname) ||
      parsed.username || parsed.password) return null;
  return parsed.href;
}

// Per-platform candidate lists, in priority order: Firefox first, then the Chromium family,
// Edge last. The first binary that exists wins; args never go through a shell.
function candidates(platform, env) {
  if (platform === 'darwin') {
    const home = env.HOME || '';
    const app = (browser, appName, binary, flag) => [
      { browser, bin: `/Applications/${appName}.app/Contents/MacOS/${binary}`, flag },
      ...(home ? [{ browser, bin: path.join(home, 'Applications', `${appName}.app`, 'Contents', 'MacOS', binary), flag }] : [])
    ];
    return [
      ...app('Firefox', 'Firefox', 'firefox', PRIVATE_ARG.firefox('darwin')),
      ...app('Google Chrome', 'Google Chrome', 'Google Chrome', PRIVATE_ARG.chromium),
      ...app('Brave', 'Brave Browser', 'Brave Browser', PRIVATE_ARG.chromium),
      ...app('Chromium', 'Chromium', 'Chromium', PRIVATE_ARG.chromium),
      ...app('Microsoft Edge', 'Microsoft Edge', 'Microsoft Edge', PRIVATE_ARG.edge)
    ];
  }
  if (platform === 'win32') {
    const dirs = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    const found = (name, rel, flag) => dirs.map(dir => ({ name, bin: path.join(dir, rel), flag }));
    return [
      ...found('Firefox', path.join('Mozilla Firefox', 'firefox.exe'), PRIVATE_ARG.firefox('win32')),
      ...found('Google Chrome', path.join('Google', 'Chrome', 'Application', 'chrome.exe'), PRIVATE_ARG.chromium),
      ...found('Brave', path.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), PRIVATE_ARG.chromium),
      ...found('Chromium', path.join('Chromium', 'Application', 'chrome.exe'), PRIVATE_ARG.chromium),
      ...found('Microsoft Edge', path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'), PRIVATE_ARG.edge)
    ].map(c => ({ ...c, browser: c.name }));
  }
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const inPath = (browser, bins, flag) => bins.map(bin => ({ browser, bin, flag, lookup: true, dirs }));
  return [
    ...inPath('Firefox', ['firefox', 'firefox-esr'], PRIVATE_ARG.firefox('linux')),
    ...inPath('Google Chrome', ['google-chrome', 'google-chrome-stable'], PRIVATE_ARG.chromium),
    ...inPath('Chromium', ['chromium', 'chromium-browser'], PRIVATE_ARG.chromium),
    ...inPath('Brave', ['brave-browser'], PRIVATE_ARG.chromium),
    ...inPath('Microsoft Edge', ['microsoft-edge', 'microsoft-edge-stable'], PRIVATE_ARG.edge)
  ];
}

function resolveBin(candidate, existsSync, injected) {
  // With the real filesystem an existing path is not enough: a same-named directory cannot
  // be exec'd, and on POSIX a file without +x fails spawn with EACCES. Both are skipped here
  // so the next candidate still gets its turn. An injected existsSync keeps its plain truth
  // table so unit tests needn't emulate stat/access too.
  const usable = p => {
    if (!existsSync(p)) return false;
    if (injected) return true;
    try {
      if (!fs.statSync(p).isFile()) return false;
      if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    } catch {
      return false;
    }
    return true;
  };
  if (!candidate.lookup) return usable(candidate.bin) ? candidate.bin : null;
  for (const dir of candidate.dirs) {
    const full = path.join(dir, candidate.bin);
    if (usable(full)) return full;
  }
  return null;
}

// launchPrivateBrowser spawns the first detected browser detached so the window outlives the
// plugin process. deps injects platform/env/existsSync/spawn so tests never open a real window.
// It is async because spawn() reports a bad binary asynchronously ('error' on the next tick):
// catching it synchronously both crashed the host on an unhandled 'error' and reported a
// phantom success instead of falling through to the next candidate.
export async function launchPrivateBrowser(url, deps = {}) {
  const target = geminiURL(url);
  if (!target) return { opened: false, reason: '只允许打开 https://gemini.google.com/ 的链接' };
  const env = deps.env || process.env;
  const injected = typeof deps.existsSync === 'function';
  const existsSync = injected ? deps.existsSync : (p => fs.existsSync(p));
  const spawnFn = deps.spawn || spawn;
  for (const candidate of candidates(deps.platform || process.platform, env)) {
    const bin = resolveBin(candidate, existsSync, injected);
    if (!bin) continue;
    let child;
    try {
      child = spawnFn(bin, [candidate.flag, target], { detached: true, stdio: 'ignore' });
    } catch {
      // A binary that exists but cannot spawn (broken install, permissions) is skipped the
      // same as one that was never found; the next candidate still gets its turn.
      continue;
    }
    if (typeof child?.once !== 'function') {
      child?.unref?.();
      return { opened: true, browser: candidate.browser };
    }
    // 'spawn' and 'error' are attached before yielding, so an async ENOENT/EACCES is claimed
    // here and never reaches the process as an unhandled error.
    const opened = await new Promise(resolve => {
      let settled = false;
      const settle = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once('error', () => settle(false));
      child.once('spawn', () => {
        // Keep an error sink after spawn too: a process that spawned may still emit 'error'
        // later (stream failures etc.) and an unhandled one would crash the host.
        child.on('error', () => {});
        settle(true);
      });
    });
    if (opened) {
      child.unref?.();
      return { opened: true, browser: candidate.browser };
    }
    // This binary failed to spawn (async EACCES/ENOENT); try the next candidate.
  }
  return { opened: false, reason: '没有找到可启动无痕窗口的浏览器' };
}

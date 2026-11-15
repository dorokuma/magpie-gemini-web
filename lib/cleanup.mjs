import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  studioDataDir,
  cleanStudio,
  hasStudioAssets,
  setStudioAssetHook
} from './studio-native.mjs';
import {
  getDataDir,
  cleanBackend,
  hasBackendAssets,
  setBackendAssetHook
} from './native.mjs';

export const PLUGIN_PACKAGE_NAME = '@dorokuma/magpie-gemini-web';
export const LEGACY_PLUGIN_PACKAGE_NAMES = ['magpie-gemini-web'];
const PLUGIN_PACKAGE_NAMES = [PLUGIN_PACKAGE_NAME, ...LEGACY_PLUGIN_PACKAGE_NAMES];
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DETACHED_WORKER_PATH = fileURLToPath(new URL('./cleanup-detached.cjs', import.meta.url));
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;

function normalizeComparePath(p, platform = process.platform) {
  let resolved = path.resolve(p);
  try {
    if (fs.existsSync(resolved)) resolved = fs.realpathSync(resolved);
  } catch {}
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isLocalPathSpec(spec) {
  return (
    spec.startsWith('/') ||
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('file:') ||
    /^[a-zA-Z]:[\\/]/.test(spec)
  );
}

function resolvePathSpec(magpieDir, spec) {
  if (spec.startsWith('file:')) {
    try {
      return fileURLToPath(spec);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(spec) ? path.resolve(spec) : path.resolve(magpieDir, spec);
}

function matchesPluginSpec(magpieDir, rawSpec, pluginRoot = PLUGIN_ROOT) {
  if (typeof rawSpec !== 'string') return false;
  const spec = rawSpec.trim();
  if (!spec) return false;

  if (PLUGIN_PACKAGE_NAMES.some(name => spec === name || spec.startsWith(`${name}@`))) {
    return true;
  }

  if (!isLocalPathSpec(spec)) {
    return /(?:^|[/:])(?:@dorokuma\/)?magpie-gemini-web(?:\.git)?(?:[#@/?].*)?$/.test(spec);
  }

  const target = resolvePathSpec(magpieDir, spec);
  if (!target || !fs.existsSync(target)) return false;

  if (pluginRoot && normalizeComparePath(target) === normalizeComparePath(pluginRoot)) {
    return true;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    return PLUGIN_PACKAGE_NAMES.includes(pkg?.name);
  } catch {
    return false;
  }
}

// isPluginInMagpie checks whether magpie-gemini-web is still listed in Magpie's plugins.json
// (including when disabled with "off": true). Returns:
//   - true  when the plugin is present in plugins.json
//   - false when plugins.json is valid and the plugin has been removed from it
//   - null  when plugins.json does not exist or cannot be parsed right now
export function isPluginInMagpie(magpieDir, options = {}) {
  if (typeof magpieDir !== 'string' || !magpieDir.trim()) return null;
  const pluginsPath = path.join(magpieDir, 'plugins.json');
  let raw;
  try {
    raw = fs.readFileSync(pluginsPath, 'utf8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) {
    return null;
  }

  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  for (const item of parsed.plugins) {
    const spec = typeof item === 'string' ? item : item?.spec;
    if (matchesPluginSpec(magpieDir, spec, pluginRoot)) {
      return true;
    }
  }

  return false;
}

export function hasDownloadedAssets(options = {}) {
  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  return hasStudioAssets(studioDir) || hasBackendAssets(webDir);
}

// cleanDownloadedAssets stops and deletes downloaded local binaries, archives, and Camoufox
// for both AI Studio and Gemini Web while preserving user accounts, databases, and configs.
export async function cleanDownloadedAssets(options = {}) {
  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const [studio, web] = await Promise.all([
    cleanStudio({ dataDir: studioDir, platform, fetchFn }).catch(err => ({
      stopped: false,
      cleaned: false,
      removed: [],
      dataDir: studioDir,
      error: err.message
    })),
    cleanBackend({ dataDir: webDir, platform, fetchFn }).catch(err => ({
      stopped: false,
      cleaned: false,
      removed: [],
      dataDir: webDir,
      error: err.message
    }))
  ]);

  return { studio, web };
}

function watcherPidFilePath(magpieDir) {
  const key = crypto.createHash('sha256').update(path.resolve(magpieDir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `magpie-gemini-web-cleanup-${key}.pid`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The pidfile graduated from a bare PID line to JSON { pid, pluginRoot, version } so a
// watcher from an older plugin build can be replaced instead of silently reused.
function readWatcherPidFile(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      const pid = Number(parsed?.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        legacy: false,
        pluginRoot: typeof parsed?.pluginRoot === 'string' ? parsed.pluginRoot : null,
        version: typeof parsed?.version === 'string' ? parsed.version : null
      };
    }
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, legacy: true, pluginRoot: null, version: null };
  } catch {
    return null;
  }
}

function readLiveWatcherPid(pidFile) {
  if (!pidFile) return null;
  const record = readWatcherPidFile(pidFile);
  if (record && isProcessAlive(record.pid)) return record.pid;
  return null;
}

function writeWatcherPidFile(pidFile, pid, pluginRoot, version) {
  try {
    fs.writeFileSync(pidFile, `${JSON.stringify({ pid, pluginRoot, version })}\n`, { mode: 0o600 });
  } catch {}
}

// A detached watcher can be identified either by the process.title it sets on startup
// ('magpie-gemini-web-cleanup'; on Linux uv_set_process_title rewrites /proc/<pid>/cmdline
// to just this title; macOS ps may truncate it to the 'magpie-gemini-web-cl' short-title
// prefix) or by the cleanup-detached.cjs script path in its argv/command line.
function isWatcherCommand(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^magpie-gemini-web-cl(?:eanup)?(?:\s|$)/.test(trimmed)) {
    return true;
  }
  return trimmed.split(/\s+/).some(token => {
    const base = token.replace(/^"|"$/g, '').split(/[\\/]/).pop();
    return base === 'cleanup-detached.cjs';
  });
}

const WATCHER_RUN_OPTIONS = { encoding: 'utf8', timeout: 5000, windowsHide: true };
const RUNNABLE_IMAGE_NAMES = new Set(['node', 'node.exe', 'bun', 'bun.exe']);

// true = the running process was launched from our detached worker script;
// false = another process reused the PID; null = inspection unavailable.
export function verifyWatcherIdentity(pid, platform = process.platform, run = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return false;
  if (platform === 'linux' && run === execFileSync) {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (args.length) return args.some(arg => isWatcherCommand(arg));
    } catch {
      // /proc read raced with process exit: fall through to ps for a second look.
    }
  }
  try {
    if (platform === 'win32') {
      const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ' +
        '$p = Get-CimInstance Win32_Process -Filter "ProcessId = $env:TARGET_PID"; ' +
        'if ($p) { "$($p.Name)|$($p.CommandLine)" }'],
      { ...WATCHER_RUN_OPTIONS, timeout: 20000, env: { ...process.env, TARGET_PID: String(pid) } }).trim();
      if (!out) return isProcessAlive(pid) ? null : false;
      const sep = out.indexOf('|');
      const name = (sep === -1 ? '' : out.slice(0, sep)).trim();
      const cmdLine = (sep === -1 ? out : out.slice(sep + 1)).trim();
      if (isWatcherCommand(cmdLine)) return true;
      if (cmdLine || (name && !RUNNABLE_IMAGE_NAMES.has(name.toLowerCase()))) return false;
      return null;
    }
    const command = run('ps', ['-ww', '-p', String(pid), '-o', 'command='], WATCHER_RUN_OPTIONS).trim();
    if (!command) return isProcessAlive(pid) ? null : false;
    return isWatcherCommand(command);
  } catch {
    return isProcessAlive(pid) ? null : false;
  }
}

async function terminateWatcher(pid, timeoutMs = 5000, verify) {
  const isOurs = verify ?? verifyWatcherIdentity(pid);
  if (isOurs !== true) {
    // Never signal a PID whose identity cannot be proven ours.
    return isOurs === null ? 'unknown' : 'foreign';
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!isProcessAlive(pid)) return 'stopped';
  try { process.kill(pid, 'SIGKILL'); } catch {}
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline && isProcessAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return isProcessAlive(pid) ? 'lingering' : 'stopped';
}

export function spawnDetachedCleanup(config, spawnFn = spawn) {
  if (!fs.existsSync(DETACHED_WORKER_PATH)) return null;
  const child = spawnFn(process.execPath, [DETACHED_WORKER_PATH], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      MAGPIE_CLEANUP_CFG: JSON.stringify(config)
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.on?.('error', () => {});
  child.unref?.();
  return child;
}

// Concurrent ensureDetachedWatcher calls for the same pidFile (e.g. GeminiWebPlugin and
// AIStudioPlugin registering back-to-back in one host) must share one in-flight take-over
// instead of both terminating the old watcher and spawning a duplicate daemon.
const inFlightWatchers = new Map();

export async function ensureDetachedWatcher(options = {}) {
  const magpieDir = options.magpieDir;
  if (typeof magpieDir !== 'string' || !magpieDir.trim()) return null;
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  const pollMs = options.pollMs ?? 2000;
  const spawnFn = options.spawnFn || spawn;

  if (!hasStudioAssets(studioDir) && !hasBackendAssets(webDir)) {
    return null;
  }

  const pidFile = options.pidFile || watcherPidFilePath(magpieDir);
  const inflightKey = path.resolve(pidFile);
  const inflight = inFlightWatchers.get(inflightKey);
  if (inflight) return inflight;

  const task = ensureDetachedWatcherOnce({
    magpieDir, pluginRoot, studioDir, webDir, pollMs, spawnFn, pidFile, options
  });
  inFlightWatchers.set(inflightKey, task);
  try {
    return await task;
  } finally {
    if (inFlightWatchers.get(inflightKey) === task) {
      inFlightWatchers.delete(inflightKey);
    }
  }
}

async function ensureDetachedWatcherOnce({
  magpieDir, pluginRoot, studioDir, webDir, pollMs, spawnFn, pidFile, options
}) {
  const record = readWatcherPidFile(pidFile);
  if (record && isProcessAlive(record.pid)) {
    // A watcher that still matches this plugin instance is reused; a bare-PID record
    // (pre-JSON pidfile) or a different pluginRoot/version means a stale watcher from
    // another plugin build that must hand over before a new one starts.
    const current = !record.legacy &&
      normalizeComparePath(record.pluginRoot ?? '') === normalizeComparePath(pluginRoot) &&
      record.version === PLUGIN_VERSION;
    if (current) {
      return { pid: record.pid, pidFile, reused: true };
    }
    const outcome = await terminateWatcher(record.pid, options.terminateTimeoutMs ?? 5000,
      options.verifyWatcherIdentity ? options.verifyWatcherIdentity(record.pid) : undefined);
    if (outcome === 'foreign') {
      // A PID that was provably never our watcher may have already been reused; only
      // drop the stale record and continue, never signal it.
      try { fs.rmSync(pidFile, { force: true }); } catch {}
    } else if (outcome !== 'stopped') {
      // 'unknown' or 'lingering': an uninspectable/stubborn process keeps the slot
      // rather than being signaled blind or shadowed by a second watcher.
      return { pid: record.pid, pidFile, reused: false, stale: outcome };
    }
  } else if (record && !isProcessAlive(record.pid)) {
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }

  // Re-check after waiting for an old watcher to exit: the plugin may have been uninstalled
  // or its assets removed in the meantime, in which case no short-lived watcher should start.
  if (isPluginInMagpie(magpieDir, { pluginRoot }) === false ||
      (!hasStudioAssets(studioDir) && !hasBackendAssets(webDir))) {
    return null;
  }

  const child = spawnDetachedCleanup({
    magpieDir: path.resolve(magpieDir),
    pluginRoot,
    studioDir,
    webDir,
    pidFile,
    mode: 'watch',
    pollMs
  }, spawnFn);

  if (child?.pid) {
    writeWatcherPidFile(pidFile, child.pid, pluginRoot, PLUGIN_VERSION);
  }

  return { pid: child?.pid ?? null, pidFile, reused: false };
}

const activeRegistrations = new Map();

export function isPluginRemovedInActiveMagpie() {
  for (const reg of activeRegistrations.values()) {
    if (isPluginInMagpie(reg.magpieDir, { pluginRoot: reg.pluginRoot }) === false) {
      return true;
    }
  }
  return false;
}

// registerMagpieCleanup hooks Magpie's plugin lifecycle so removing magpie-gemini-web from
// Magpie's plugins.json automatically stops and deletes downloaded local binaries and Camoufox.
export function registerMagpieCleanup(input, options = {}) {
  const magpieDir = typeof input?.directory === 'string' ? input.directory.trim() : '';
  if (!magpieDir) return null;

  const resolvedMagpieDir = path.resolve(magpieDir);
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  if (isPluginInMagpie(resolvedMagpieDir, { pluginRoot }) !== true) {
    return null;
  }

  if (activeRegistrations.has(resolvedMagpieDir)) {
    const existing = activeRegistrations.get(resolvedMagpieDir);
    existing.ensureWatcher().catch(() => {});
    return existing;
  }

  const studioDir = options.studioDir || studioDataDir();
  const webDir = options.webDir || getDataDir();
  const pollMs = options.pollMs ?? 2000;
  const spawnFn = options.spawnFn || spawn;
  const pidFile = options.pidFile || watcherPidFilePath(resolvedMagpieDir);

  let cleaned = false;
  let lastPid = null;
  let watcher = null;

  const ensureWatcher = async () => {
    const state = isPluginInMagpie(resolvedMagpieDir, { pluginRoot });
    if (state === true) {
      cleaned = false;
    }
    if (cleaned || state === false) return null;
    const res = await ensureDetachedWatcher({
      magpieDir: resolvedMagpieDir,
      pluginRoot,
      studioDir,
      webDir,
      pollMs,
      pidFile,
      spawnFn
    });
    if (res?.pid) lastPid = res.pid;
    return res;
  };

  const triggerIfRemoved = () => {
    const state = isPluginInMagpie(resolvedMagpieDir, { pluginRoot });
    if (state === true) {
      if (cleaned) {
        cleaned = false;
        ensureWatcher().catch(() => {});
      }
      return false;
    }
    if (state !== false || cleaned) return false;
    cleaned = true;
    // Rely on the detached worker instead of running in-process cleanup so an in-flight request in
    // the still-loaded host module cannot race with cleanup or leave cleaned permanently stuck.
    if (!readLiveWatcherPid(pidFile) && (hasStudioAssets(studioDir) || hasBackendAssets(webDir))) {
      const child = spawnDetachedCleanup({
        magpieDir: resolvedMagpieDir,
        pluginRoot,
        studioDir,
        webDir,
        pidFile,
        mode: 'immediate'
      }, spawnFn);
      if (child?.pid) {
        lastPid = child.pid;
        writeWatcherPidFile(pidFile, child.pid, pluginRoot, PLUGIN_VERSION);
      }
    }
    return true;
  };

  try {
    watcher = fs.watch(resolvedMagpieDir, (_eventType, filename) => {
      if (!filename || filename === 'plugins.json') {
        triggerIfRemoved();
      }
    });
    watcher.on?.('error', () => {});
    watcher.unref?.();
  } catch {}

  const notifyAssetInstalled = () => {
    for (const reg of activeRegistrations.values()) {
      reg.ensureWatcher().catch(() => {});
    }
  };
  setStudioAssetHook(notifyAssetInstalled);
  setBackendAssetHook(notifyAssetInstalled);
  ensureWatcher().catch(() => {});

  const handle = {
    magpieDir: resolvedMagpieDir,
    pluginRoot,
    pidFile,
    get pid() {
      const live = readLiveWatcherPid(pidFile);
      if (live) return live;
      return isProcessAlive(lastPid) ? lastPid : undefined;
    },
    ensureWatcher,
    triggerIfRemoved,
    close() {
      try { watcher?.close(); } catch {}
      activeRegistrations.delete(resolvedMagpieDir);
    }
  };

  activeRegistrations.set(resolvedMagpieDir, handle);
  return handle;
}

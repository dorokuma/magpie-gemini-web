import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { validateProxyURL } from './setup.mjs';
import { verifyProcessIdentity, studioProcessPids, studioListenerPids } from './studio-native.mjs';
import { hasProxyCredentials, normalizeCurlProxy, redactProxyCredentials } from './studio-upstream.mjs';
import release from './backend-release.json' with { type: 'json' };

export const BACKEND_VERSION = `v${release.version}`;
const RELEASE_BASE = `https://github.com/${release.repository}/releases/download/${release.tag}/`;
export const PINNED_BINARIES = release.binaries;

const UPSTREAM_VERSION = 'v4.28.0';
const UPSTREAM_BASE = `https://github.com/zexadev/gemini-web2api-go/releases/download/${UPSTREAM_VERSION}/`;
// Retained for an explicit, checksum-verified rollback to the upstream release.
export const UPSTREAM_BINARIES = {
  'darwin-arm64': { asset: 'gemini-web2api-go_v4.28.0_darwin_arm64', sha256: 'a6aaf315d4ea0ab4cc179e75b050c305b55e7347bc654eb5b5980dc82bedeffe' },
  'darwin-x64': { asset: 'gemini-web2api-go_v4.28.0_darwin_amd64', sha256: '132207df8d9a87ad9c179f71dafc000e7d8f8721244a378e0989d063ecae5bdd' },
  'linux-x64': { asset: 'gemini-web2api-go_v4.28.0_linux_amd64', sha256: 'e42cd70701a234c06eb81b4af4d925be4fe2b4c77bc6627e99b01750cdfea931' },
  'linux-arm64': { asset: 'gemini-web2api-go_v4.28.0_linux_arm64', sha256: '404dd0e0e8ebc529f925b9db18541f1adfcb2edd5088827c86430c91b3065ea4' },
  'win32-x64': { asset: 'gemini-web2api-go_v4.28.0_windows_amd64.exe', sha256: '4a990dbc106334c73ee2a4ae26b917073a2b82f069dc9da1b1073a608576d9a1' },
  'win32-arm64': { asset: 'gemini-web2api-go_v4.28.0_windows_arm64.exe', sha256: 'ed421bb36a0bf2cd7d0c561ca035e251b01769d0db83ef78834f8578fa545279' }
};

export function pinnedBinary(platform = process.platform, arch = process.arch, channel = 'optimized') {
  if (channel !== 'optimized' && channel !== 'upstream') throw new Error(`Invalid backend channel: ${channel}`);
  const pins = channel === 'upstream' ? UPSTREAM_BINARIES : PINNED_BINARIES;
  const base = channel === 'upstream' ? UPSTREAM_BASE : RELEASE_BASE;
  const version = channel === 'upstream' ? UPSTREAM_VERSION : BACKEND_VERSION;
  const pin = pins[`${platform}-${arch}`];
  if (!pin) {
    throw new Error(`No gemini-web2api-go ${version} build for ${platform}/${arch}. See ${base.slice(0, -1).replace('/download/', '/tag/')}`);
  }
  return { url: base + pin.asset, sha256: pin.sha256 };
}

export function backendChannel(dataDir = getDataDir()) {
  try {
    const { channel } = JSON.parse(fs.readFileSync(path.join(dataDir, 'backend-channel.json'), 'utf8'));
    if (channel !== 'optimized' && channel !== 'upstream') throw new Error('Expected optimized or upstream');
    return channel;
  } catch (error) {
    if (error.code === 'ENOENT') return 'optimized';
    throw new Error(`Invalid backend-channel.json: ${error.message}`);
  }
}

function saveBackendChannel(dataDir, channel) {
  const file = path.join(dataDir, 'backend-channel.json');
  const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ channel }) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function getDataDir(env = process.env) {
  return env.GEMINI_WEB_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'magpie-gemini-web');
}

export function binaryPath(dataDir, platform = process.platform) {
  return path.join(dataDir, 'bin', platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go');
}

export function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function installBackend(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const channel = options.channel ?? 'optimized';
  const pin = options.expectedHash && options.url ? null : pinnedBinary(platform, arch, channel);
  const expectedHash = options.expectedHash || pin.sha256;
  const downloadUrl = options.url || pin.url;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const proxy = validateProxyURL(options.proxy ?? process.env.GEMINI_WEB_PROXY ?? '');

  const dataDir = options.dataDir || getDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  const binDir = path.join(dataDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(binDir, 0o700);

  const binPath = binaryPath(dataDir, platform);
  let binaryReady = false;

  if (fs.existsSync(binPath)) {
    const existingHash = computeFileHash(binPath);
    if (existingHash === expectedHash) {
      binaryReady = true;
      console.log(`Backend binary verified: ${binPath}`);
    }
  }

  if (!binaryReady) {
    console.log(`Downloading backend binary from ${downloadUrl}...`);
    const tmpPath = path.join(binDir, `gemini-web2api-go.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
    try {
      // A slow download goes on while data keeps coming; a minute without any gives it up.
      if (proxy && (!options.fetchFn || options.fetchFn === globalThis.fetch)) {
        if (/[\r\n]/.test(proxy)) throw new Error('Invalid GEMINI_WEB_PROXY');
        // A proxy with credentials travels over stdin, never argv; inner blanks are encoded first.
        const curlProxy = normalizeCurlProxy(proxy);
        const proxySecret = hasProxyCredentials(curlProxy);
        const curlArgs = [
          '--fail', '--location', '--silent', '--show-error',
          '--connect-timeout', '15', '--speed-limit', '1', '--speed-time', '60',
          ...(proxySecret ? ['--config', '-'] : ['--proxy', curlProxy]),
          '-o', tmpPath, downloadUrl
        ];
        await new Promise((resolve, reject) => {
          const child = execFile('curl', curlArgs, (err, _stdout, stderr) => {
            if (!err) return resolve();
            const status = err.code ?? (err.signal ? `signal ${err.signal}` : err.status || 'failed');
            const reason = redactProxyCredentials(String(stderr || '').trim().slice(0, 500));
            reject(new Error(`Failed to download binary via curl (status: ${status})${reason ? `: ${reason}` : ''}`));
          });
          if (proxySecret) {
            child.stdin?.on('error', () => {});
            child.stdin?.end(`proxy = ${JSON.stringify(curlProxy)}\n`);
          }
        });
        fs.chmodSync(tmpPath, 0o700);
      } else {
        const stall = new AbortController();
        let timer;
        const rearm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => stall.abort(new Error('Failed to download binary: no data for 60 s')), 60000);
        };
        const chunks = [];
        try {
          rearm();
          const res = await fetchFn(downloadUrl, {
            ...(proxy ? { proxy } : {}),
            signal: stall.signal
          });
          if (!res.ok) {
            throw new Error(`Failed to download binary: HTTP ${res.status}`);
          }
          for await (const chunk of res.body) {
            chunks.push(chunk);
            rearm();
          }
        } finally {
          clearTimeout(timer);
        }
        fs.writeFileSync(tmpPath, Buffer.concat(chunks), { mode: 0o700 });
      }

      const downloadedHash = computeFileHash(tmpPath);
      if (downloadedHash !== expectedHash) {
        throw new Error(`SHA256 checksum mismatch: expected ${expectedHash}, got ${downloadedHash}`);
      }

      fs.renameSync(tmpPath, binPath);
      fs.chmodSync(binPath, 0o700);
      console.log(`Backend binary installed: ${binPath}`);
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  }

  const files = ensureDataFiles(dataDir, options.rateLimit);
  // A local custom build keeps the user's channel. Official installs record their
  // selection only after verification and replacement succeeded.
  if ((!options.expectedHash && !options.url) || options.channel !== undefined) saveBackendChannel(dataDir, channel);
  onBackendAssetInstalled?.();
  return { binPath, ...files };
}

// ensureDataFiles creates config.json and secrets.json when missing; existing ones are kept.
// rateLimit carries the per_ip_* limits declared in the plugin options: a new config.json
// records them, and an existing one is merged key by key only when a passed value differs,
// so port, multi_turn and every other field the user set stay exactly as they were.
const RATE_LIMIT_CONFIG_KEYS = ['per_ip_concurrent', 'per_ip_rpm', 'per_ip_rph'];

function ensureDataFiles(dataDir, rateLimit = {}) {
  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      host: "127.0.0.1",
      port: 8083,
      log_requests: false,
      multi_turn: false,
      temporary_chat: true,
      // temporary_chat 不足以防幽灵会话（带附件/Mode-8 时服务端仍落「打不开」的
      // 索引残片）；auto_delete 让后端收尾统一 GzXR5e 删掉，双保险。
      auto_delete_conversation: true
    };
    for (const key of RATE_LIMIT_CONFIG_KEYS) {
      if (rateLimit[key] !== undefined) defaultConfig[key] = rateLimit[key];
    }
    writeJsonFile(configPath, defaultConfig);
    console.log(`Created default config: ${configPath}`);
  } else {
    mergeRateLimitConfig(configPath, rateLimit);
    fs.chmodSync(configPath, 0o600);
  }

  const secretsPath = path.join(dataDir, 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    const defaultSecrets = {
      apiKey: 'gw_' + crypto.randomBytes(32).toString('hex'),
      adminToken: crypto.randomBytes(32).toString('hex')
    };
    fs.writeFileSync(secretsPath, JSON.stringify(defaultSecrets, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(secretsPath, 0o600);
    console.log(`Created secrets: ${secretsPath}`);
  } else {
    fs.chmodSync(secretsPath, 0o600);
  }

  return { configPath, secretsPath };
}

// writeJsonFile replaces file atomically (temp file + rename) with 0600 permissions.
function writeJsonFile(file, data) {
  const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  fs.chmodSync(file, 0o600);
}

// mergeRateLimitConfig rewrites configPath only when a passed rateLimit value differs from
// what is already stored; a file that fails to parse is left untouched and the caller's
// own error handling decides.
function mergeRateLimitConfig(configPath, rateLimit) {
  const wanted = RATE_LIMIT_CONFIG_KEYS.filter(key => rateLimit[key] !== undefined);
  if (!wanted.length) return;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  if (!wanted.some(key => config[key] !== rateLimit[key])) return;
  for (const key of wanted) config[key] = rateLimit[key];
  writeJsonFile(configPath, config);
}

export function startBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const expectedHash = options.expectedHash || pinnedBinary(process.platform, process.arch, backendChannel(dataDir)).sha256;
  const spawnFn = options.spawnFn || spawn;
  const { binPath, args, env } = prepareLaunch(dataDir, [expectedHash]);

  const child = spawnFn(binPath, args, {
    env,
    stdio: 'inherit'
  });

  const onSigInt = () => child.kill('SIGINT');
  const onSigTerm = () => child.kill('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  const cleanupListeners = () => {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
  };

  child.on('error', () => {
    cleanupListeners();
    console.error('Failed to start backend process');
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    cleanupListeners();
    if (typeof options.exitFn === 'function') {
      options.exitFn(code, signal);
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  return child;
}

// prepareLaunch checks the installed backend before it is run: a binary whose hash is one of
// trustedHashes, a loopback-only config and well-formed secrets. It returns what to spawn.
function prepareLaunch(dataDir, trustedHashes, platform = process.platform) {
  const binPath = binaryPath(dataDir, platform);
  const configPath = path.join(dataDir, 'config.json');
  const secretsPath = path.join(dataDir, 'secrets.json');

  if (!fs.existsSync(binPath)) {
    throw new Error(`Binary not found at ${binPath}. Run 'npm run backend:install' first.`);
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration not found at ${configPath}. Run 'npm run backend:install' first.`);
  }
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`Secrets not found at ${secretsPath}. Run 'npm run backend:install' first.`);
  }

  const actualHash = computeFileHash(binPath);
  if (!trustedHashes.includes(actualHash)) {
    throw new Error(`Binary integrity verification failed: expected ${trustedHashes.join(' or ')}, got ${actualHash}`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`Failed to parse configuration file at ${configPath}`);
  }

  if (config.host !== '127.0.0.1') {
    throw new Error(`Security validation failed: host must be strictly 127.0.0.1, got ${config.host}`);
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`Invalid port number in configuration: ${config.port}`);
  }

  let secrets;
  try {
    secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch {
    throw new Error(`Failed to parse secrets file at ${secretsPath}`);
  }

  if (!secrets.apiKey || typeof secrets.apiKey !== 'string' || !secrets.adminToken || typeof secrets.adminToken !== 'string') {
    throw new Error('Invalid secrets format in secrets.json');
  }

  const dbPath = path.join(dataDir, 'gemini.db');
  const args = ['--config', configPath, '--db', dbPath];
  const env = {
    ...process.env,
    API_KEY: secrets.apiKey,
    ADMIN_TOKEN: secrets.adminToken
  };

  return { binPath, args, env, port: config.port, secrets };
}

// trustedHashes accepts the selected release channel and any explicitly installed local build.
function trustedHashes(dataDir, platform, arch) {
  const hashes = [];
  try {
    hashes.push(pinnedBinary(platform, arch, backendChannel(dataDir)).sha256);
  } catch {}
  try {
    const argon = JSON.parse(fs.readFileSync(path.join(dataDir, 'argon-build.json'), 'utf8'));
    if (/^[a-f0-9]{64}$/.test(argon.sha256)) hashes.push(argon.sha256);
  } catch {}
  return hashes;
}

function readLocalSetup(dataDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || typeof secrets.apiKey !== 'string' || typeof secrets.adminToken !== 'string') {
      return null;
    }
    const origin = `http://127.0.0.1:${config.port}`;
    return { origin, baseURL: `${origin}/v1`, apiKey: secrets.apiKey, adminToken: secrets.adminToken };
  } catch {
    return null;
  }
}

// localSetup returns the saved configuration and credentials in dataDir ({ origin, baseURL,
// apiKey, adminToken }), or null when none has been configured there, even if the binary was
// cleaned up.
export function localSetup(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  return readLocalSetup(dataDir);
}

// localBackend returns the backend this plugin manages in dataDir ({ origin, baseURL, apiKey,
// adminToken }), or null when none has been set up there.
export function localBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;
  if (!fs.existsSync(binaryPath(dataDir, platform))) return null;
  return readLocalSetup(dataDir);
}

// backendState says whether the backend at setup answers with this setup's API key.
async function backendState(setup, fetchFn) {
  let res;
  try {
    res = await fetchFn(`${setup.baseURL}/models`, {
      headers: { Authorization: `Bearer ${setup.apiKey}` },
      signal: AbortSignal.timeout(2000)
    });
  } catch {
    return 'down';
  }
  return res.ok ? 'up' : 'foreign';
}

// syncBackendRateLimit applies the plugin's per_ip_* limits to a healthy managed backend
// through its admin API: GET the full runtime config, PUT it back with only the passed
// limits changed (PUT persists to the backend's runtime_config store and takes effect at
// once). Values already matching skip the PUT; a missing adminToken or a non-2xx answer
// fails loudly instead of leaving the impression the limits applied.
async function syncBackendRateLimit(setup, rateLimit, fetchFn) {
  const wanted = Object.entries(rateLimit || {}).filter(([, v]) => v !== undefined);
  if (!wanted.length) return;
  if (typeof setup.adminToken !== 'string' || !setup.adminToken) {
    throw new Error(`Cannot apply per-IP rate limits to ${setup.origin}: the managed backend has no admin token`);
  }
  const url = `${setup.origin}/admin/api/config`;
  const headers = { Authorization: `Bearer ${setup.adminToken}` };
  let res;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new Error(`Cannot apply per-IP rate limits to ${setup.origin}: failed to read runtime config: ${err?.message || err}`);
  }
  if (!res.ok) {
    throw new Error(`Cannot apply per-IP rate limits to ${setup.origin}: GET /admin/api/config returned HTTP ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Cannot apply per-IP rate limits to ${setup.origin}: invalid runtime config response`);
  }
  const config = body?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Cannot apply per-IP rate limits to ${setup.origin}: runtime config response has no "config" object`);
  }
  if (!wanted.some(([key, value]) => config[key] !== value)) return;
  const next = { ...config };
  for (const [key, value] of wanted) next[key] = value;
  let put;
  try {
    put = await fetchFn(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    throw new Error(`Cannot apply per-IP rate limits to ${setup.origin}: failed to write runtime config: ${err?.message || err}`);
  }
  if (!put.ok) {
    let detail = '';
    try {
      const errBody = await put.json();
      if (typeof errBody?.error === 'string') detail = `: ${errBody.error}`;
    } catch {}
    throw new Error(`Cannot apply per-IP rate limits to ${setup.origin}: PUT /admin/api/config returned HTTP ${put.status}${detail}`);
  }
}


// backendVersion asks the backend at setup for its self-reported version (the same string
// --version prints). Returns null when the backend is down, foreign, or too old to answer.
async function backendVersion(setup, fetchFn) {
  try {
    const res = await fetchFn(`${setup.origin}/`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.version === "string" && data.version ? data.version : null;
  } catch {
    return null;
  }
}

// normalizeVersion strips a leading "v" so "v5.0.0" and "5.0.0" compare equal.
function normalizeVersion(v) { return typeof v === "string" ? v.replace(/^v/, "") : null; }

// expectedBackendVersion returns the version string the running backend should report for the
// binary on disk: a trusted argon-build.json local build keeps its recorded version, the
// pinned release keeps its tag version, and anything else falls back to the pin so an
// untrusted binary is still steered back to the release.
function expectedBackendVersion(dataDir, platform, arch) {
  const channel = backendChannel(dataDir);
  let fallback = release.version;
  try {
    const binHash = fs.existsSync(binaryPath(dataDir, platform))
      ? computeFileHash(binaryPath(dataDir, platform)) : null;
    if (binHash) {
      try {
        const argon = JSON.parse(fs.readFileSync(path.join(dataDir, "argon-build.json"), "utf8"));
        if (argon.sha256 === binHash && typeof argon.version === "string") return argon.version;
      } catch {}
      try {
        const pin = pinnedBinary(platform, arch, channel);
        if (pin.sha256 === binHash) return release.version;
      } catch {}
    }
  } catch {}
  return fallback;
}

// inDataDirBackendProc
// using /proc on Linux so a stale binary renamed elsewhere is still recognised.
// backendOwnedByDataDir reports whether pid is OUR backend: it must both run a
// gemini-web2api-go image and tie itself to this dataDir — launched from bin/ inside it, or
// carrying --config/--db inside it. Both halves keep a same-port stranger (another install,
// or a test fixture pointing its config at a live port) from being killed by mistake.
function backendOwnedByDataDir(pid, dataDir, platform) {
  const root = path.resolve(dataDir);
  const owned = candidate => {
    if (!candidate) return false;
    const cleaned = candidate.replace(/ \(deleted\)$/, "");
    if (!path.basename(cleaned).startsWith("gemini-web2api-go")) return false;
    const resolved = path.resolve(cleaned);
    const rel = path.relative(root, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const argsInDataDir = cmdline => {
    if (!cmdline) return false;
    return cmdline.split("\0").concat(cmdline.split(/\s+/)).some(a => {
      const v = a.replace(/^--(?:config|db)=/, "");
      if (!v) return false;
      const resolved = path.resolve(v);
      const rel = path.relative(root, resolved);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
  };
  if (platform === "linux") {
    let exe = "", cmdline = "";
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch {}
    const arg0 = cmdline.split("\0")[0] || "";
    // The executable image must live under dataDir (bin/, backups kept beside it), AND the
    // process must own this dataDir either by its launch path or by --config/--db inside it.
    return (owned(exe) || owned(arg0)) && (owned(arg0) || argsInDataDir(cmdline));
  }
  if (platform === "darwin") {
    try {
      const cmdline = execFileSync("ps", ["-p", String(pid), "-ww", "-o", "command="], { encoding: "utf8", timeout: 5000 }).trim();
      const arg0 = cmdline.split(/\s+/)[0] || "";
      return owned(arg0) && argsInDataDir(cmdline);
    } catch { return false; }
  }
  // win32 cannot have a stale backend: Windows locks the running image, so the binary can
  // never be replaced underneath a live process — verifyProcessIdentity covers it.
  return false;
}

// staleBackendPids lists live processes listening on setup.origin that are NOT the binary on
// disk but still look like a gemini-web2api-go image — the leftovers that keep an outdated
// backend answering health checks after the binary was swapped.
function staleBackendPids(setup, dataDir, platform, verify) {
  const bin = binaryPath(dataDir, platform);
  const port = Number(new URL(setup.origin).port);
  let listeners = [];
  try { listeners = studioListenerPids(port, platform); } catch {}
  const tracked = recordedBackendPid(dataDir);
  const candidates = [...new Set([...listeners, ...(Number.isInteger(tracked) && tracked > 0 ? [tracked] : [])])];
  // No verify exemption: reaching this point means the answerer is stale (version mismatch)
  // or the backend is being rebuilt — a same-path stale process must go down too.
  return candidates.filter(pid => processAlive(pid) && backendOwnedByDataDir(pid, dataDir, platform));
}

// stopStaleBackend kills backend processes that hold the port but are not the managed binary,
// so the release build can actually take over the port instead of being adopted-and-masked.
async function stopStaleBackend(setup, dataDir, platform, verify, fetchFn) {
  const stale = staleBackendPids(setup, dataDir, platform, verify);
  if (!stale.length) return 0;
  for (const pid of stale) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (stale.every(p => !processAlive(p))) break;
    await sleep(100);
  }
  for (const pid of stale) {
    if (processAlive(pid) && backendOwnedByDataDir(pid, dataDir, platform)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  const closeDeadline = Date.now() + 2000;
  while (Date.now() < closeDeadline) {
    if (await backendState(setup, fetchFn) !== "up") break;
    await sleep(100);
  }
  return stale.length;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// withLock serializes setup across plugin hosts (Magpie may run more than one) by a lock file.
async function withLock(dataDir, fn, timeoutMs) {
  const lockPath = path.join(dataDir, '.setup.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx', 0o600));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > timeoutMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`Timed out waiting for another Gemini Web setup (${lockPath})`);
      await sleep(300);
    }
  }
  // A download has no overall deadline, so the holder keeps the lock fresh while it works;
  // only a lock left by a process that is gone goes stale.
  const keepFresh = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {}
  }, Math.max(1000, Math.floor(timeoutMs / 4)));
  keepFresh.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(keepFresh);
    fs.rmSync(lockPath, { force: true });
  }
}

// ensureBackend makes sure the local backend is installed and running, and returns how to reach
// it. A backend already answering with this setup's key is left alone. Otherwise a missing or
// untrusted binary is (re)installed from the selected release channel, config and secrets are
// created when missing, and the backend is started in the background (logging to backend.log)
// so it outlives the caller.
export async function ensureBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const spawnFn = options.spawnFn || spawn;
  const verify = options.verifyIdentity || verifyProcessIdentity;
  const startTimeoutMs = options.startTimeoutMs ?? 20000;
  const rateLimit = options.rateLimit;

  // A healthy managed backend gets the plugin's per_ip_* limits synced into its live
  // runtime config (see syncBackendRateLimit below).
  const settle = () => syncBackendRateLimit(setup, rateLimit, fetchFn);

  // Adoption is version-aware. A healthy backend is only reused when it reports the version
  // the binary on disk should run; a stale one — including the case where it answers with a
  // different API key and so looks "foreign" — is killed first so the release build can
  // actually take the port. Without this, a plugin upgrade never reaches the backend: the
  // old process keeps answering health checks and the swap silently never happens.
  let setup = readLocalSetup(dataDir);
  const expectedVersion = expectedBackendVersion(dataDir, platform, arch);
  const matchesExpected = async () => {
    const running = normalizeVersion(await backendVersion(setup, fetchFn));
    const expected = normalizeVersion(expectedVersion);
    if (!running) return 'unknown';           // too old to report — adopt, cannot self-heal
    return running === expected ? 'match' : 'stale';
  };

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, async () => {
    setup = readLocalSetup(dataDir);
    const trusted = trustedHashes(dataDir, platform, arch);
    const binPath = binaryPath(dataDir, platform);
    const binTrusted = fs.existsSync(binPath) && trusted.includes(computeFileHash(binPath));

    if (setup) {
      const state = await backendState(setup, fetchFn);
      if (state === 'up') {
        const verdict = binTrusted ? await matchesExpected() : 'stale';
        if (verdict === 'match' || verdict === 'unknown') { await settle(); return setup; }
        // Version mismatch or untrusted binary: kill whatever holds the port before the
        // pinned build is installed and respawned. Nothing killed = the listener is not
        // ours to swap, so keep adopting rather than break a working install.
        const killed = await stopStaleBackend(setup, dataDir, platform, verify, fetchFn);
        if (!killed) { await settle(); return setup; }
        if (await backendState(setup, fetchFn) === 'up') {
          // Port still claimed by something we could not identify; never stack a second
          // backend behind it.
          await settle();
          return setup;
        }
      } else if (state === 'foreign' && fs.existsSync(binPath)) {
        // "foreign" here is often still OUR backend — launched by hand or by an older plugin
        // with a different secrets file — holding the port while a pinned build waits. Only
        // images owned by this dataDir are killed; anything else keeps its name. When no
        // binary exists yet we skip the probe entirely: the port cannot be ours anyway, and
        // probing now would consume the caller's network before the download runs.
        const killed = await stopStaleBackend(setup, dataDir, platform, verify, fetchFn);
        if (!killed) {
          throw new Error(`${setup.origin} is already used by another service; change "port" in ${path.join(dataDir, 'config.json')}`);
        }
        const after = await backendState(setup, fetchFn);
        if (after === 'foreign') {
          throw new Error(`${setup.origin} is already used by another service; change "port" in ${path.join(dataDir, 'config.json')}`);
        }
        if (after === 'up') {
          const verdict = binTrusted ? await matchesExpected() : 'stale';
          if (verdict === 'match' || verdict === 'unknown') { await settle(); return setup; }
          await stopStaleBackend(setup, dataDir, platform, verify, fetchFn);
        }
      }
    }

    if (!binTrusted) {
      await installBackend({ dataDir, platform, arch, fetchFn, channel: backendChannel(dataDir), proxy: options.proxy, rateLimit });
    } else {
      ensureDataFiles(dataDir, rateLimit);
    }
    setup = readLocalSetup(dataDir);
    if (!setup) throw new Error(`Invalid Gemini Web backend config in ${dataDir}`);
    if (await backendState(setup, fetchFn) === 'foreign') {
      throw new Error(`${setup.origin} is already used by another service; change "port" in ${path.join(dataDir, 'config.json')}`);
    }

    const launch = prepareLaunch(dataDir, trusted, platform);
    const logPath = path.join(dataDir, 'backend.log');
    const log = fs.openSync(logPath, 'a', 0o600);
    let child;
    try {
      child = spawnFn(launch.binPath, launch.args, {
        env: launch.env,
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true
      });
      child.on?.('error', () => {});
      if (child.pid) fs.writeFileSync(path.join(dataDir, 'backend.pid'), `${child.pid}\n`, { mode: 0o600 });
      child.unref?.();
    } finally {
      fs.closeSync(log);
    }

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (await backendState(setup, fetchFn) === 'up') {
        await settle();
        return setup;
      }
      await sleep(300);
    }
    try { child?.kill?.('SIGTERM'); } catch {}
    if (child?.pid && typeof child?.kill !== 'function') {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(path.join(dataDir, 'backend.pid'), { force: true });
    throw new Error(`Gemini Web backend did not start within ${Math.round(startTimeoutMs / 1000)}s; see ${logPath}`);
  }, 600000);
}

export async function statusBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const configPath = path.join(dataDir, 'config.json');
  const fetchFn = options.fetchFn || globalThis.fetch;

  let host = '127.0.0.1';
  let port = 8083;

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.host === '127.0.0.1') host = config.host;
      if (Number.isInteger(config.port) && config.port > 0) port = config.port;
    } catch {}
  }

  const statusUrl = `http://${host}:${port}/`;
  let res;
  try {
    res = await fetchFn(statusUrl, {
      signal: AbortSignal.timeout(2000)
    });
  } catch (err) {
    throw new Error(`Failed to connect to backend at ${statusUrl}: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`Backend returned HTTP ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Backend returned invalid JSON response');
  }

  const version = data.version || 'unknown';
  const models = Array.isArray(data.models) ? data.models.join(', ') : 'none';

  console.log(`Backend status: ok`);
  console.log(`Version: ${version}`);
  console.log(`Available models: ${models}`);

  return { status: 'ok', version, models: data.models };
}

let onBackendAssetInstalled = null;

export function setBackendAssetHook(fn) {
  onBackendAssetInstalled = typeof fn === 'function' ? fn : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function recordedBackendPid(dataDir) {
  try { return Number(fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8').trim()); } catch { return NaN; }
}

export function hasBackendAssets(dataDir = getDataDir(), platform = process.platform, options = {}) {
  const verify = options.verifyIdentity || verifyProcessIdentity;
  if (!fs.existsSync(dataDir)) return false;
  for (const name of ['bin', 'backend-channel.json', 'argon-build.json']) {
    if (fs.existsSync(path.join(dataDir, name))) return true;
  }
  const pidFile = path.join(dataDir, 'backend.pid');
  if (fs.existsSync(pidFile)) {
    const pid = recordedBackendPid(dataDir);
    const bin = binaryPath(dataDir, platform);
    if (processAlive(pid) && verify(pid, bin, platform) !== false) {
      return true;
    }
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }
  return false;
}

function forceRemoveBackendPath(target, platform) {
  if (!fs.existsSync(target)) return false;
  try {
    if (platform !== 'win32') {
      const st = fs.lstatSync(target);
      if (st.isDirectory()) {
        try { fs.chmodSync(target, (st.mode & 0o777) | 0o700); } catch {}
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
    return !fs.existsSync(target);
  } catch {
    return false;
  }
}

export async function stopBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const verify = options.verifyIdentity || verifyProcessIdentity;
  const pidFile = path.join(dataDir, 'backend.pid');
  const bin = binaryPath(dataDir, platform);

  if (!fs.existsSync(dataDir)) return { stopped: true };

  const setup = readLocalSetup(dataDir);
  const state = setup ? await backendState(setup, fetchFn) : 'down';
  if (state === 'foreign') {
    throw new Error(`Cannot stop unknown or foreign process listening on ${setup.origin}`);
  }

  const candidates = [];
  const tracked = recordedBackendPid(dataDir);
  if (Number.isInteger(tracked) && tracked > 0) candidates.push(tracked);
  if (fs.existsSync(bin)) {
    try {
      candidates.push(...studioProcessPids(bin, platform));
    } catch {}
    if (setup && state === 'up') {
      const port = Number(new URL(setup.origin).port);
      try {
        candidates.push(...studioListenerPids(port, platform));
      } catch {}
    }
  }

  const live = [...new Set(candidates)].filter(p => processAlive(p));
  const verified = [];
  const unknown = [];
  for (const p of live) {
    const identity = verify(p, bin, platform);
    if (identity === true) verified.push(p);
    else if (identity === null) unknown.push(p);
  }
  if (!verified.length) {
    // An uninspectable live process keeps its record rather than being abandoned or killed blind.
    if (unknown.length) {
      return { stopped: false, reported: `Cannot inspect gemini-web2api-go process ${unknown.join(', ')} safely; its PID record was kept` };
    }
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    if (state === 'up') {
      return { stopped: false, reported: `Cannot identify a verified gemini-web2api-go process for ${setup.origin}` };
    }
    return { stopped: true };
  }

  for (const pid of verified) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (verified.every(p => !processAlive(p))) break;
    await sleep(100);
  }

  if (options.force && verified.some(p => processAlive(p))) {
    for (const pid of verified) {
      if (processAlive(pid) && verify(pid, bin, platform) === true) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline) {
      if (verified.every(p => !processAlive(p))) break;
      await sleep(50);
    }
  }

  if (verified.some(p => processAlive(p))) {
    return { stopped: false, reported: `Process ${verified.filter(p => processAlive(p)).join(', ')} did not exit after SIGTERM` };
  }

  if (unknown.some(p => processAlive(p))) {
    return { stopped: false, reported: `Cannot inspect gemini-web2api-go process ${unknown.filter(p => processAlive(p)).join(', ')} safely; its PID record was kept` };
  }

  try { fs.rmSync(pidFile, { force: true }); } catch {}

  if (setup && state === 'up') {
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline) {
      if (await backendState(setup, fetchFn) === 'down') break;
      await sleep(100);
    }
    if (await backendState(setup, fetchFn) !== 'down') {
      return { stopped: false, reported: `${setup.origin} is still responding after stop` };
    }
  }

  return { stopped: true };
}

// cleanBackend stops any running managed gemini-web2api-go process in dataDir and deletes the
// downloaded binary and channel metadata while preserving config.json, secrets.json, gemini.db,
// and logs.
export async function cleanBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;

  if (!fs.existsSync(dataDir)) {
    return { stopped: true, cleaned: true, removed: [], dataDir };
  }

  return withLock(dataDir, async () => {
    const stopRes = await stopBackend({ dataDir, platform, fetchFn: options.fetchFn, force: true, verifyIdentity: options.verifyIdentity }).catch(() => null);

    // A PID whose identity cannot be disproven is not evidence the backend exited: keep its
    // record and assets rather than deleting them under it, as assertStudioExited does.
    const bin = binaryPath(dataDir, platform);
    const tracked = recordedBackendPid(dataDir);
    const pidFile = path.join(dataDir, 'backend.pid');
    const verify = options.verifyIdentity || verifyProcessIdentity;
    let lingering = [];
    if (processAlive(tracked) && verify(tracked, bin, platform) !== false) {
      lingering = [tracked];
    } else {
      try { fs.rmSync(pidFile, { force: true }); } catch {}
      if (fs.existsSync(bin)) {
        try {
          lingering = studioProcessPids(bin, platform)
            .filter(p => processAlive(p) && verify(p, bin, platform) !== false);
        } catch {}
      }
    }

    if (lingering.length > 0 || (stopRes && !stopRes.stopped)) {
      return {
        stopped: false,
        cleaned: false,
        removed: [],
        dataDir,
        reported: stopRes?.reported || `Gemini Web backend may still be running (PID ${lingering.join(', ')})`
      };
    }

    const removed = [];
    for (const name of ['bin', 'backend.pid', 'backend-channel.json', 'argon-build.json']) {
      if (forceRemoveBackendPath(path.join(dataDir, name), platform)) {
        removed.push(name);
      }
    }

    return { stopped: true, cleaned: true, removed, dataDir };
  }, options.lockTimeoutMs ?? 600000);
}

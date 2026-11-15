#!/usr/bin/env node
// One-way sync of the pinned backend release manifest from the published
// dorokuma/gemini-web2api-go GitHub release. The pinned binaries are the only
// backend artifact source; this script never rebuilds or patches them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultPinPath = path.join(root, 'lib/backend-release.json');

export const TARGET_PLATFORMS = {
  'darwin-arm64': ['darwin', 'arm64'],
  'darwin-x64': ['darwin', 'amd64'],
  'linux-x64': ['linux', 'amd64'],
  'linux-arm64': ['linux', 'arm64'],
  'win32-x64': ['windows', 'amd64'],
  'win32-arm64': ['windows', 'arm64']
};

const SEMVER_LINE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_LINE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_LINE = /^[a-f0-9]{64}$/;

const upstreamHashes = () => {
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'lib/native.mjs'), 'utf8');
  } catch (error) {
    throw new Error(`Cannot read lib/native.mjs for upstream rollback hashes: ${error.message}`);
  }
  const start = text.indexOf('UPSTREAM_BINARIES');
  const end = start === -1 ? -1 : text.indexOf('};', start);
  if (start === -1 || end === -1) {
    throw new Error('UPSTREAM_BINARIES block not found in lib/native.mjs; refusing ambiguous rollback check');
  }
  const hashes = [...text.slice(start, end + 2).matchAll(/'[a-f0-9]{64}'/g)].map(m => m[0].slice(1, -1));
  if (hashes.length < 6) {
    throw new Error(`UPSTREAM_BINARIES in lib/native.mjs must pin at least 6 rollback hashes, got ${hashes.length}`);
  }
  return new Set(hashes);
};

export function expectedAssetName(version, platformKey) {
  const [goos, goarch] = TARGET_PLATFORMS[platformKey];
  if (!goos) throw new Error(`Unsupported platform key: ${platformKey}`);
  return `gemini-web2api-go_v${version}_${goos}_${goarch}${goos === 'windows' ? '.exe' : ''}`;
}

export function parseSha256Sums(sumsText, version) {
  if (typeof sumsText !== 'string') throw new Error('SHA256SUMS.txt content must be a string');
  if (!SEMVER_LINE.test(String(version))) throw new Error(`Invalid version for SHA256SUMS.txt parsing: ${version}`);
  const expected = new Map(Object.keys(TARGET_PLATFORMS).map(key => [expectedAssetName(version, key), key]));
  const found = new Map();
  const seen = new Set();
  for (const [index, rawLine] of sumsText.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([A-Fa-f0-9]+) {1,2}\*?(.+)$/);
    if (!match) throw new Error(`Malformed SHA256SUMS.txt line ${index + 1}: ${rawLine}`);
    const [, hash, name] = match;
    if (seen.has(name)) throw new Error(`Duplicate asset in SHA256SUMS.txt: ${name}`);
    seen.add(name);
    if (!SHA256_LINE.test(hash)) throw new Error(`Invalid SHA-256 for ${name}: expected 64 lowercase hex chars, got ${hash}`);
    const key = expected.get(name);
    if (!key) throw new Error(`Unexpected asset in SHA256SUMS.txt: ${name}`);
    found.set(key, { asset: name, sha256: hash });
  }
  const missing = [...expected.values()].filter(key => !found.has(key));
  if (missing.length) throw new Error(`SHA256SUMS.txt is missing platform binaries: ${missing.join(', ')}`);
  if (found.size !== Object.keys(TARGET_PLATFORMS).length) {
    throw new Error(`SHA256SUMS.txt must list exactly the six supported platform binaries, got ${found.size}`);
  }
  return found;
}

export function validateBackendReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Backend release manifest must be an object');
  }
  const allowed = new Set(['version', 'repository', 'tag', 'binaries']);
  for (const key of Object.keys(manifest)) {
    if (!allowed.has(key)) throw new Error(`Unexpected field in backend release manifest: ${key}`);
  }
  if (typeof manifest.version !== 'string' || !SEMVER_LINE.test(manifest.version)) {
    throw new Error(`manifest.version must be a strict single-line SemVer X.Y.Z, got ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.repository !== 'dorokuma/gemini-web2api-go') {
    throw new Error(`manifest.repository must be dorokuma/gemini-web2api-go, got ${JSON.stringify(manifest.repository)}`);
  }
  if (manifest.tag !== `v${manifest.version}`) {
    throw new Error(`manifest.tag must be v${manifest.version}, got ${JSON.stringify(manifest.tag)}`);
  }
  if (!manifest.binaries || typeof manifest.binaries !== 'object' || Array.isArray(manifest.binaries)) {
    throw new Error('manifest.binaries must be an object');
  }
  const keys = Object.keys(manifest.binaries);
  const expectedKeys = Object.keys(TARGET_PLATFORMS);
  if (keys.length !== expectedKeys.length || !expectedKeys.every(key => keys.includes(key))) {
    throw new Error(`manifest.binaries must contain exactly the six platform keys ${expectedKeys.join(', ')}; got ${keys.join(', ') || 'none'}`);
  }
  const upstream = upstreamHashes();
  for (const key of expectedKeys) {
    const pin = manifest.binaries[key];
    if (!pin || typeof pin !== 'object') throw new Error(`manifest.binaries.${key} must be an object`);
    const expectedName = expectedAssetName(manifest.version, key);
    if (pin.asset !== expectedName) {
      throw new Error(`manifest.binaries.${key}.asset must be ${expectedName}, got ${JSON.stringify(pin.asset)}`);
    }
    if (!SHA256_LINE.test(pin.sha256 || '')) {
      throw new Error(`manifest.binaries.${key}.sha256 must be 64 lowercase hex chars, got ${JSON.stringify(pin.sha256)}`);
    }
    if (upstream.has(pin.sha256)) {
      throw new Error(`manifest.binaries.${key}.sha256 duplicates an upstream rollback hash; refuses an ambiguous pin`);
    }
  }
  return true;
}

function readManifest(pinPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read backend release manifest at ${pinPath}: ${error.message}`);
  }
  validateBackendReleaseManifest(manifest);
  return manifest;
}

export async function syncBackendPins({ pinPath = defaultPinPath, tag, repo = 'dorokuma/gemini-web2api-go', mode = 'verify', fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('A fetch implementation is required');
  if (!['verify-schema', 'verify', 'write-pins'].includes(mode)) {
    throw new Error(`Unknown mode: ${mode} (expected verify-schema, verify or write-pins)`);
  }

  if (mode === 'verify-schema') {
    return readManifest(pinPath);
  }

  if (mode === 'write-pins') {
    if (!TAG_LINE.test(tag || '')) {
      throw new Error(`--tag must be a strict single-line vX.Y.Z tag, got ${JSON.stringify(tag)}`);
    }
    const sumsUrl = `https://github.com/${repo}/releases/download/${tag}/SHA256SUMS.txt`;
    const res = await fetchFn(sumsUrl, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Failed to fetch ${sumsUrl}: HTTP ${res.status}`);
    const binaries = parseSha256Sums(await res.text(), tag.slice(1));
    const manifest = { version: tag.slice(1), repository: repo, tag, binaries: Object.fromEntries(binaries) };
    validateBackendReleaseManifest(manifest);
    const dir = path.dirname(pinPath);
    const temp = `${pinPath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
      fs.renameSync(temp, pinPath);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return manifest;
  }

  // mode === 'verify': local schema first, then the published sums and asset reachability.
  const manifest = readManifest(pinPath);
  const sumsUrl = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/SHA256SUMS.txt`;
  const res = await fetchFn(sumsUrl, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Failed to fetch ${sumsUrl}: HTTP ${res.status}`);
  const remote = parseSha256Sums(await res.text(), manifest.version);
  for (const key of Object.keys(TARGET_PLATFORMS)) {
    const local = manifest.binaries[key];
    const published = remote.get(key);
    if (local.asset !== published.asset || local.sha256 !== published.sha256) {
      throw new Error(`Pinned ${key} differs from published SHA256SUMS.txt: local ${local.sha256}, published ${published.sha256}`);
    }
  }
  for (const key of Object.keys(TARGET_PLATFORMS)) {
    const url = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${manifest.binaries[key].asset}`;
    const head = await fetchFn(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (head.status === 200) continue;
    if (head.status === 405 || head.status === 403 || head.status === 404) {
      const ranged = await fetchFn(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (ranged.status === 200 || ranged.status === 206) continue;
      throw new Error(`Pinned asset not reachable (${ranged.status}): ${url}`);
    }
    throw new Error(`Pinned asset not reachable (${head.status}): ${url}`);
  }
  return manifest;
}

function parseArgs(args) {
  const out = { mode: null, tag: undefined, repo: undefined, pinPath: undefined };
  for (const arg of args) {
    if (arg === '--verify-schema') out.mode = 'verify-schema';
    else if (arg === '--verify') out.mode = 'verify';
    else if (arg === '--write-pins') out.mode = 'write-pins';
    else if (arg.startsWith('--tag=')) out.tag = arg.slice('--tag='.length);
    else if (arg.startsWith('--repo=')) out.repo = arg.slice('--repo='.length);
    else if (arg.startsWith('--pin-path=')) out.pinPath = arg.slice('--pin-path='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.mode) out.mode = 'verify';
  if (out.mode === 'write-pins' && !out.tag) throw new Error('--write-pins requires --tag=vX.Y.Z');
  return out;
}

let invokedAs;
try { invokedAs = process.argv[1] && fs.realpathSync(process.argv[1]); } catch {}
const selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedAs === selfPath) {
  const { mode, tag, repo, pinPath } = parseArgs(process.argv.slice(2));
  syncBackendPins({ pinPath, tag, repo, mode }).then(manifest => {
    console.log(`${mode}: ${manifest.repository}@${manifest.tag} (${manifest.version}) — 6 platform pins OK`);
  }).catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

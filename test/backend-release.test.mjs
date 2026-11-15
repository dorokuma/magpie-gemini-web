import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
import { backendChannel, binaryPath, ensureBackend, installBackend, pinnedBinary,
  PINNED_BINARIES, UPSTREAM_BINARIES } from '../lib/native.mjs';
import { parseSha256Sums, validateBackendReleaseManifest, syncBackendPins,
  TARGET_PLATFORMS } from '../scripts/sync-backend-pins.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-release-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'bin'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 8083, multi_turn: true }));
  fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_fixture', adminToken: 'fixture_admin' }));
  fs.writeFileSync(path.join(dataDir, 'gemini.db'), 'existing account database');
  return dataDir;
}
function pinFixture(t, pins, bytes) {
  const previous = pins['darwin-arm64'];
  pins['darwin-arm64'] = { ...previous, sha256: hash(bytes) };
  t.after(() => { pins['darwin-arm64'] = previous; });
}

it('ships pinned default and rollback downloads for all six supported targets', () => {
  const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
  assert.deepEqual(Object.keys(PINNED_BINARIES).sort(), targets);
  assert.deepEqual(Object.keys(TARGET_PLATFORMS).sort(), targets);
  for (const key of targets) {
    const [platform, arch] = key.split('-');
    const pinned = pinnedBinary(platform, arch);
    const upstream = pinnedBinary(platform, arch, 'upstream');
    assert.match(pinned.url, /^https:\/\/github\.com\/dorokuma\/gemini-web2api-go\/releases\/download\/v5\.0\.0\//);
    assert.match(pinned.sha256, /^[a-f0-9]{64}$/);
    assert.match(upstream.url, /^https:\/\/github\.com\/zexadev\/gemini-web2api-go\/releases\/download\/v4\.28\.0\//);
    assert.notEqual(pinned.sha256, upstream.sha256);
    assert.equal(pinned.url.endsWith('.exe'), platform === 'win32');
  }
  assert.throws(() => pinnedBinary('linux', 'mips'), /No gemini-web2api-go/);
  assert.throws(() => pinnedBinary('linux', 'x64', 'unknown'), /Invalid backend channel/);
});

it('upgrades a stopped upstream backend to the optimized release without changing account data', async t => {
  const dataDir = fixture(t);
  const old = Buffer.from('upstream fixture');
  const next = Buffer.from('optimized fixture');
  pinFixture(t, UPSTREAM_BINARIES, old);
  pinFixture(t, PINNED_BINARIES, next);
  const bin = binaryPath(dataDir, 'darwin');
  fs.writeFileSync(bin, old);
  const calls = [];
  let spawned = false;
  await ensureBackend({ dataDir, platform: 'darwin', arch: 'arm64',
    fetchFn: async url => {
      calls.push(url);
      if (url === pinnedBinary('darwin', 'arm64').url) return new Response(next);
      if (!spawned) throw new Error('ECONNREFUSED');
      return Response.json({ data: [] });
    },
    spawnFn: () => { spawned = true; return { pid: 1234, on() {}, unref() {} }; }
  });
  assert.deepEqual(fs.readFileSync(bin), next);
  assert.ok(spawned);
  assert.ok(calls.includes(pinnedBinary('darwin', 'arm64').url));
  assert.equal(backendChannel(dataDir), 'optimized');
  assert.equal(fs.readFileSync(path.join(dataDir, 'gemini.db'), 'utf8'), 'existing account database');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'))).multi_turn, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'))).apiKey, 'gw_fixture');
});

it('persists an explicit upstream rollback across automatic starts and can switch back', async t => {
  const dataDir = fixture(t);
  const upstream = Buffer.from('upstream fixture');
  const optimized = Buffer.from('optimized fixture');
  pinFixture(t, UPSTREAM_BINARIES, upstream);
  pinFixture(t, PINNED_BINARIES, optimized);
  await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', channel: 'upstream',
    fetchFn: async url => {
      assert.equal(url, pinnedBinary('darwin', 'arm64', 'upstream').url);
      return new Response(upstream);
    }
  });
  assert.equal(backendChannel(dataDir), 'upstream');
  let spawned = false;
  await ensureBackend({ dataDir, platform: 'darwin', arch: 'arm64',
    fetchFn: async url => {
      assert.ok(url.startsWith('http://127.0.0.1:8083/'), 'rollback must not redownload the default build');
      if (!spawned) throw new Error('ECONNREFUSED');
      return Response.json({ data: [] });
    },
    spawnFn: () => { spawned = true; return { pid: 1234, on() {}, unref() {} }; }
  });
  assert.ok(spawned);
  await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', fetchFn: async () => new Response(optimized) });
  assert.equal(backendChannel(dataDir), 'optimized');
  assert.deepEqual(fs.readFileSync(binaryPath(dataDir, 'darwin')), optimized);
});

it('parses a real v5.0.0-style SHA256SUMS.txt into all six platform pins', () => {
  const sums = [
    '852af30ffbcfd1402905f855e78d41d54a2f62313085aab420423ea0d855e2c1  gemini-web2api-go_v5.0.0_darwin_amd64',
    'dfdcac8065483176fc42c6387014aa106cfe30175b94c393d7345f596eb26c7a  gemini-web2api-go_v5.0.0_darwin_arm64',
    '7a13f0e9c3003732eeb6346d16be191f486d1eaa035d61f1e8751ee287680e2a  gemini-web2api-go_v5.0.0_linux_amd64',
    'c0c468c7c8f85c0772a389586bbc92d7493e27e3b26e5baba0fc749abc427bfe  gemini-web2api-go_v5.0.0_linux_arm64',
    '08ce950afe2eda4a622f9c1560e578bdb13d00477ac9f20cd5bd62036a4345f4 *gemini-web2api-go_v5.0.0_windows_amd64.exe',
    'fb36c3b457e6b372b6a528c19ede49637712d384b4623751174aba1d7d621f26  gemini-web2api-go_v5.0.0_windows_arm64.exe'
  ].join('\n') + '\n';
  const found = parseSha256Sums(sums, '5.0.0');
  assert.equal(found.size, 6);
  assert.equal(found.get('linux-arm64').sha256, 'c0c468c7c8f85c0772a389586bbc92d7493e27e3b26e5baba0fc749abc427bfe');
  assert.equal(found.get('win32-x64').asset, 'gemini-web2api-go_v5.0.0_windows_amd64.exe');
});

it('rejects malformed sums, missing platforms and unexpected assets', () => {
  const line = key => `${'a'.repeat(64)}  gemini-web2api-go_v5.0.0_${key}`;
  assert.throws(() => parseSha256Sums('not-a-hash  foo', '5.0.0'), /Malformed SHA256SUMS/);
  assert.throws(() => parseSha256Sums(line('linux_amd64'), '5.0.0'), /missing platform binaries/);
  const six = ['darwin_amd64', 'darwin_arm64', 'linux_amd64', 'linux_arm64', 'windows_amd64.exe', 'windows_arm64.exe'];
  assert.throws(() => parseSha256Sums(six.map(line).join('\n') + `\n${'b'.repeat(64)}  extra`, '5.0.0'), /Unexpected asset/);
});

it('validateBackendReleaseManifest enforces repository, tag, six keys and upstream-hash disjointness', () => {
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/backend-release.json'), 'utf8'));
  assert.doesNotThrow(() => validateBackendReleaseManifest(good));
  assert.throws(() => validateBackendReleaseManifest({ ...good, repository: 'x/y' }), /repository/);
  assert.throws(() => validateBackendReleaseManifest({ ...good, tag: 'v9.9.9' }), /tag/);
  const broken = JSON.parse(JSON.stringify(good));
  delete broken.binaries['linux-x64'];
  assert.throws(() => validateBackendReleaseManifest(broken), /six platform keys/);
  const clashing = JSON.parse(JSON.stringify(good));
  clashing.binaries['linux-x64'] = { ...clashing.binaries['linux-x64'], sha256: UPSTREAM_BINARIES['linux-x64'].sha256 };
  assert.throws(() => validateBackendReleaseManifest(clashing), /duplicates an upstream rollback hash/);
});

it('syncBackendPins verify-schema reads the committed manifest offline', async () => {
  const manifest = await syncBackendPins({ pinPath: path.join(ROOT, 'lib/backend-release.json'), mode: 'verify-schema' });
  assert.equal(manifest.repository, 'dorokuma/gemini-web2api-go');
  assert.equal(manifest.tag, `v${manifest.version}`);
  assert.equal(Object.keys(manifest.binaries).length, 6);
});

it('importing the sync script under a non-path argv[1] does not run main or throw', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import './scripts/sync-backend-pins.mjs'", 'check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(out, '');
});

it('a failed upgrade keeps the previous binary, channel, config, secrets and database', async t => {
  const dataDir = fixture(t);
  const bin = binaryPath(dataDir, 'darwin');
  fs.writeFileSync(bin, 'previous binary');
  fs.writeFileSync(path.join(dataDir, 'backend-channel.json'), JSON.stringify({ channel: 'upstream' }));
  const paths = [bin, ...['backend-channel.json', 'config.json', 'secrets.json', 'gemini.db'].map(name => path.join(dataDir, name))];
  const before = paths.map(file => fs.readFileSync(file));
  for (const response of [() => new Response('offline', { status: 503 }), () => new Response('corrupt binary')]) {
    await assert.rejects(installBackend({ dataDir, platform: 'darwin', arch: 'arm64', fetchFn: async () => response() }), /HTTP 503|SHA256 checksum mismatch/);
    for (let i = 0; i < paths.length; i++) assert.deepEqual(fs.readFileSync(paths[i]), before[i]);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'bin')), ['gemini-web2api-go']);
  }
});

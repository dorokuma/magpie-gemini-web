import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  installBackend,
  startBackend,
  statusBackend,
  stopBackend,
  cleanBackend,
  hasBackendAssets,
  computeFileHash,
  getDataDir
} from '../lib/native.mjs';

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `magpie-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

it('getDataDir keeps the ~/.local/share/magpie-gemini-web default and honors GEMINI_WEB_DATA_DIR', () => {
  assert.equal(getDataDir({}), path.join(os.homedir(), '.local', 'share', 'magpie-gemini-web'));
  assert.equal(getDataDir({ GEMINI_WEB_DATA_DIR: '/custom/dir' }), '/custom/dir');
});

describe('22. Setup helper hash mismatch/download failure no executable installed', () => {
  it('aborts on download failure and leaves no executable', async () => {
    const dataDir = makeTempDir();
    const fakeFetch = async () => new Response('Not Found', { status: 404 });

    await assert.rejects(
      async () => installBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        fetchFn: fakeFetch
      }),
      /Failed to download binary: HTTP 404/
    );

    const binPath = path.join(dataDir, 'bin', 'gemini-web2api-go');
    assert.equal(fs.existsSync(binPath), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('aborts on SHA256 mismatch, deletes temp file and leaves no executable', async () => {
    const dataDir = makeTempDir();
    const dummyContent = Buffer.from('malicious or corrupted binary bytes');
    const fakeFetch = async () => new Response(dummyContent, { status: 200 });

    const expectedHash = '0000000000000000000000000000000000000000000000000000000000000000';

    await assert.rejects(
      async () => installBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        expectedHash,
        fetchFn: fakeFetch
      }),
      /SHA256 checksum mismatch/
    );

    const binPath = path.join(dataDir, 'bin', 'gemini-web2api-go');
    assert.equal(fs.existsSync(binPath), false);

    // Ensure no leftover tmp files in bin
    const binDir = path.join(dataDir, 'bin');
    const files = fs.readdirSync(binDir);
    assert.deepEqual(files, []);

    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('23. Native helper config/secrets creation reuse modes 600 without values in stdout, loopback restriction', () => {
  it('creates config.json and secrets.json with mode 0600 without logging secret values', async () => {
    const dataDir = makeTempDir();
    const validContent = Buffer.from('valid dummy binary content');
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');
    const fakeFetch = async () => new Response(validContent, { status: 200 });

    // Capture stdout
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const res = await installBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        expectedHash: validHash,
        fetchFn: fakeFetch
      });

      const configStat = fs.statSync(res.configPath);
      // Check mode ends in 600 (permission rw-------)
      assert.equal(configStat.mode & 0o777, 0o600);

      const secretsStat = fs.statSync(res.secretsPath);
      assert.equal(secretsStat.mode & 0o777, 0o600);

      const secrets = JSON.parse(fs.readFileSync(res.secretsPath, 'utf8'));
      assert.ok(secrets.apiKey.startsWith('gw_'));
      assert.equal(secrets.apiKey.length, 67); // 'gw_' + 64 hex chars
      assert.equal(secrets.adminToken.length, 64);

      // Verify no secrets leaked to stdout
      const allLogs = logs.join('\n');
      assert.equal(allLogs.includes(secrets.apiKey), false);
      assert.equal(allLogs.includes(secrets.adminToken), false);

      // Reuse test: running install again does NOT overwrite config or secrets
      const firstApiKey = secrets.apiKey;
      await installBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        expectedHash: validHash,
        fetchFn: fakeFetch
      });

      const secretsAfter = JSON.parse(fs.readFileSync(res.secretsPath, 'utf8'));
      assert.equal(secretsAfter.apiKey, firstApiKey);
    } finally {
      console.log = origLog;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('enforces loopback host restriction (strictly 127.0.0.1)', () => {
    const dataDir = makeTempDir();
    const validContent = Buffer.from('binary');
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');

    fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
    const binPath = path.join(dataDir, 'bin', 'gemini-web2api-go');
    fs.writeFileSync(binPath, validContent, { mode: 0o700 });

    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({
      apiKey: 'gw_key',
      adminToken: 'token'
    }), { mode: 0o600 });

    // Host set to 0.0.0.0 should be rejected by startBackend
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      host: '0.0.0.0',
      port: 8083
    }), { mode: 0o600 });

    assert.throws(
      () => startBackend({ dataDir, expectedHash: validHash }),
      /Security validation failed: host must be strictly 127.0.0.1/
    );

    // Host set to 127.0.0.1 should pass validation
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      host: '127.0.0.1',
      port: 8083
    }), { mode: 0o600 });

    let spawnedArgs = null;
    let spawnedEnv = null;
    const fakeSpawn = (bin, args, opts) => {
      spawnedArgs = args;
      spawnedEnv = opts.env;
      return {
        on: () => {},
        kill: () => {}
      };
    };

    startBackend({ dataDir, expectedHash: validHash, spawnFn: fakeSpawn, exitFn: () => {} });
    assert.deepEqual(spawnedArgs, ['--config', path.join(dataDir, 'config.json'), '--db', path.join(dataDir, 'gemini.db')]);
    assert.equal(spawnedEnv.API_KEY, 'gw_key');
    assert.equal(spawnedEnv.ADMIN_TOKEN, 'token');

    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('handles spawn failure on startBackend cleanly without unhandled error', () => {
    const dataDir = makeTempDir();
    const validContent = Buffer.from('binary');
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');

    fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'bin', 'gemini-web2api-go'), validContent, { mode: 0o700 });
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({
      apiKey: 'gw_key',
      adminToken: 'token'
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      host: '127.0.0.1',
      port: 8083
    }), { mode: 0o600 });

    const errorsLogged = [];
    const origErr = console.error;
    console.error = (...args) => errorsLogged.push(args.join(' '));

    const origExitCode = process.exitCode;
    const initialSigIntCount = process.listenerCount('SIGINT');

    const fakeChild = new EventEmitter();
    fakeChild.kill = () => {};

    try {
      startBackend({
        dataDir,
        expectedHash: validHash,
        spawnFn: () => fakeChild,
        exitFn: () => {}
      });

      assert.equal(process.listenerCount('SIGINT'), initialSigIntCount + 1);

      fakeChild.emit('error', new Error('spawn ENOENT'));

      assert.equal(process.exitCode, 1);
      assert.equal(process.listenerCount('SIGINT'), initialSigIntCount);
      assert.ok(errorsLogged.some(msg => msg.includes('Failed to start backend process')));
    } finally {
      process.exitCode = origExitCode;
      console.error = origErr;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('statusBackend reads loopback status and prints version/models without leaking secrets', async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      host: '127.0.0.1',
      port: 8083
    }));

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    const fakeFetch = async (url) => {
      assert.equal(url, 'http://127.0.0.1:8083/');
      return new Response(JSON.stringify({
        status: 'ok',
        version: '4.21.0',
        models: ['gemini-2.5-flash', 'gemini-3.1-pro']
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const res = await statusBackend({ dataDir, fetchFn: fakeFetch });
      assert.equal(res.version, '4.21.0');
      assert.deepEqual(res.models, ['gemini-2.5-flash', 'gemini-3.1-pro']);
      const allLogs = logs.join('\n');
      assert.match(allLogs, /Backend status: ok/);
      assert.match(allLogs, /Version: 4.21.0/);
    } finally {
      console.log = origLog;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

it('an uninspectable recorded backend PID keeps backend.pid and blocks clean', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-unknown-pid-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const pidFile = path.join(dataDir, 'backend.pid');
  // An explicit uninspectable-identity stub keeps this test off the host's PowerShell.
  const uninspectable = { verifyIdentity: () => null };
  fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
  // Without bin/ or channel files a backend.pid alone must still count as an asset, and
  // an identity the stub cannot disprove must keep its record rather than dropping it.
  assert.equal(hasBackendAssets(dataDir, process.platform, uninspectable), true);
  assert.equal(fs.existsSync(pidFile), true, 'an unknown-identity PID must not drop its record');
  fs.mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
  const binFile = path.join(dataDir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go');
  fs.writeFileSync(binFile, 'bin');
  const fetchFn = () => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  const stopped = await stopBackend({ dataDir, fetchFn, ...uninspectable });
  assert.equal(stopped.stopped, false);
  assert.match(stopped.reported, /Cannot inspect/);
  assert.equal(fs.existsSync(pidFile), true);
  const cleaned = await cleanBackend({ dataDir, fetchFn, ...uninspectable });
  assert.equal(cleaned.stopped, false);
  assert.equal(cleaned.cleaned, false);
  assert.equal(fs.existsSync(pidFile), true, 'unknown-identity PID record must survive cleanBackend');
  assert.equal(fs.existsSync(binFile), true, 'binary must survive cleanBackend');
});

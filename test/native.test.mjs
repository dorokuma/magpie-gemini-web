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
  ensureBackend,
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

describe('24. per-IP rate limits merge into config.json without disturbing other fields', () => {
  it('writes passed per_ip_* values into a fresh config.json', async () => {
    const dataDir = makeTempDir();
    const validContent = Buffer.from('fake backend');
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');
    await installBackend({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      expectedHash: validHash,
      fetchFn: async () => new Response(validContent),
      rateLimit: { per_ip_concurrent: 8, per_ip_rpm: 120, per_ip_rph: 0 }
    });
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(config.per_ip_concurrent, 8);
    assert.equal(config.per_ip_rpm, 120);
    assert.equal(config.per_ip_rph, 0);
    assert.equal(config.port, 8083);
    assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('merges only changed per_ip_* keys into an existing config.json and leaves it alone when nothing differs', async () => {
    const dataDir = makeTempDir();
    const validContent = Buffer.from('fake backend');
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');
    const configPath = path.join(dataDir, 'config.json');
    const original = { host: '127.0.0.1', port: 9876, multi_turn: true, custom_field: 'keep me', per_ip_rpm: 30 };
    fs.writeFileSync(configPath, JSON.stringify(original), { mode: 0o644 });
    const fetchFn = async () => new Response(validContent);

    // A differing value is merged; every other field survives.
    await installBackend({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      expectedHash: validHash,
      fetchFn,
      rateLimit: { per_ip_rpm: 120 }
    });
    const merged = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(merged.per_ip_rpm, 120);
    assert.equal(merged.per_ip_concurrent, undefined, 'unpassed limits are not forced in');
    assert.equal(merged.port, 9876);
    assert.equal(merged.multi_turn, true);
    assert.equal(merged.custom_field, 'keep me');
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

    // Same values again: no rewrite.
    let before = fs.statSync(configPath).mtimeMs;
    await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', expectedHash: validHash, fetchFn, rateLimit: { per_ip_rpm: 120 } });
    assert.equal(fs.statSync(configPath).mtimeMs, before);

    // No rateLimit at all: no rewrite either.
    before = fs.statSync(configPath).mtimeMs;
    await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', expectedHash: validHash, fetchFn });
    assert.equal(fs.statSync(configPath).mtimeMs, before);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('hot-applies differing limits to a running managed backend and skips the PUT when they already match', async () => {
    const dataDir = makeTempDir();
    const binDir = path.join(dataDir, 'bin');
    fs.mkdirSync(binDir);
    const validContent = Buffer.from('fake backend');
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');
    fs.writeFileSync(path.join(binDir, 'gemini-web2api-go'), validContent, { mode: 0o700 });
    fs.writeFileSync(path.join(dataDir, 'argon-build.json'), JSON.stringify({ sha256: validHash, version: 'v0.0.0-test' }));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 8083, multi_turn: true }));
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_test', adminToken: 'admin_test' }));

    const adminCalls = [];
    const runtimeConfig = {
      retry_attempts: 3,
      request_timeout_sec: 600,
      default_model: 'gemini-4-hydrogen',
      impersonate: 'chrome',
      gemini_bl: 'boq_123',
      per_ip_concurrent: 5,
      per_ip_rpm: 30,
      per_ip_rph: 80
    };
    const fetchFn = async (url, init = {}) => {
      const target = String(url);
      if (target === 'http://127.0.0.1:8083/') {
        return Response.json({ version: 'v0.0.0-test', models: [] });
      }
      if (target === 'http://127.0.0.1:8083/v1/models') {
        assert.equal(init.headers?.Authorization, 'Bearer gw_test');
        return Response.json({ data: [] });
      }
      if (target === 'http://127.0.0.1:8083/admin/api/config') {
        assert.equal(init.headers?.Authorization, 'Bearer admin_test');
        adminCalls.push(init.method || 'GET');
        if ((init.method || 'GET') === 'PUT') {
          const sent = JSON.parse(init.body);
          assert.equal(sent.retry_attempts, 3, 'PUT must carry the full runtime config back');
          assert.equal(sent.impersonate, 'chrome');
          Object.assign(runtimeConfig, sent);
          return Response.json({ ok: true, config: runtimeConfig });
        }
        return Response.json({ config: { ...runtimeConfig }, models: [], deploy: {} });
      }
      throw new Error(`unexpected URL ${target}`);
    };

    const spawned = [];
    const opts = {
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      fetchFn,
      spawnFn: () => { spawned.push(1); return { pid: 4242, on() {}, unref() {} }; },
      verifyIdentity: () => false
    };

    // Differing values: one GET + one PUT, backend keeps running untouched.
    const setup = await ensureBackend({ ...opts, rateLimit: { per_ip_rpm: 120, per_ip_rph: 200 } });
    assert.equal(setup.baseURL, 'http://127.0.0.1:8083/v1');
    assert.deepEqual(adminCalls, ['GET', 'PUT']);
    assert.equal(runtimeConfig.per_ip_rpm, 120);
    assert.equal(runtimeConfig.per_ip_rph, 200);
    assert.equal(runtimeConfig.per_ip_concurrent, 5);
    assert.equal(spawned.length, 0, 'an already-healthy backend is reused, not restarted');

    // Values now in sync: a GET happens but no second PUT.
    adminCalls.length = 0;
    await ensureBackend({ ...opts, rateLimit: { per_ip_rpm: 120, per_ip_rph: 200 } });
    assert.deepEqual(adminCalls, ['GET']);

    // No rateLimit: the admin API is never touched.
    adminCalls.length = 0;
    await ensureBackend(opts);
    assert.deepEqual(adminCalls, []);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fails loudly when the managed backend cannot apply the limits', async () => {
    const dataDir = makeTempDir();
    const binDir = path.join(dataDir, 'bin');
    fs.mkdirSync(binDir);
    const validContent = Buffer.from('fake backend');
    const validHash = crypto.createHash('sha256').update(validContent).digest('hex');
    fs.writeFileSync(path.join(binDir, 'gemini-web2api-go'), validContent, { mode: 0o700 });
    fs.writeFileSync(path.join(dataDir, 'argon-build.json'), JSON.stringify({ sha256: validHash, version: 'v0.0.0-test' }));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 8083 }));
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_test', adminToken: 'admin_test' }));

    const fetchFn = async (url) => {
      const target = String(url);
      if (target === 'http://127.0.0.1:8083/') return Response.json({ version: 'v0.0.0-test', models: [] });
      if (target === 'http://127.0.0.1:8083/v1/models') return Response.json({ data: [] });
      if (target === 'http://127.0.0.1:8083/admin/api/config') return new Response('forbidden', { status: 403 });
      throw new Error(`unexpected URL ${target}`);
    };
    await assert.rejects(
      ensureBackend({ dataDir, platform: 'darwin', arch: 'arm64', fetchFn, verifyIdentity: () => false, rateLimit: { per_ip_rpm: 120 } }),
      /Cannot apply per-IP rate limits.*HTTP 403/
    );
    fs.rmSync(dataDir, { recursive: true, force: true });
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

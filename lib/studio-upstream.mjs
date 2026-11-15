import { execFile } from 'node:child_process';

// A proxy carrying credentials must reach curl over stdin, never argv; credentials also
// have to be masked in error text. Both cover passwords containing '@' (which makes the
// userinfo end at the last '@' before the host) and proxies without a scheme.
// normalizeCurlProxy trims the proxy and percent-encodes inner blanks so curl's --config
// parser never sees an unescaped userinfo that would split the password from the host.
export function normalizeCurlProxy(proxy) {
  if (typeof proxy !== 'string') return '';
  const trimmed = proxy.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[ \t]/g, ch => encodeURIComponent(ch));
}

export function hasProxyCredentials(proxy) {
  if (typeof proxy !== 'string') return false;
  const trimmed = proxy.trim();
  if (!trimmed) return false;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.username !== '' || parsed.password !== '') return true;
  } catch {}
  return /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?[^/?#]+@/.test(trimmed);
}

export function redactProxyCredentials(text) {
  return String(text || '')
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:(?!:\/\/)[^/?#'"\r\n])+@/g, '$1***@')
    .replace(/(^|[\s'"(])[^/\s'"]+:[^/?#'"\r\n]+@(?=(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d+)?)/g, '$1***@');
}

function curlMetadata(args, config) {
  return new Promise((resolve, reject) => {
    const child = execFile('curl', args, {
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 50000, windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); }
      else resolve(stdout);
    });
    // Credentials travel over stdin, never argv or a temporary file.
    child.stdin?.on('error', () => {});
    child.stdin?.end(config);
  });
}
export const STUDIO_UPSTREAM = 'Mag1cFall/AIStudio2API';
const API = `https://api.github.com/repos/${STUDIO_UPSTREAM}/releases`;
const TARGETS = {
  'darwin-arm64': 'darwin-arm64.tar.gz', 'darwin-x64': 'darwin-amd64.tar.gz',
  'linux-arm64': 'linux-arm64.tar.gz', 'linux-x64': 'linux-amd64.tar.gz',
  'win32-x64': 'windows-amd64.zip'
};

export function supportsOfficialStudio(platform = process.platform, arch = process.arch) {
  return Object.hasOwn(TARGETS, `${platform}-${arch}`);
}

export function unsupportedStudioMessage(platform = process.platform, arch = process.arch) {
  return `No official AIStudio2API CLI archive for ${platform}/${arch}. 自动安装支持 macOS / Linux 的 x64、arm64，以及 Windows x64。当前平台请选「指定 AIStudio2API 程序路径（高级）」使用兼容程序，或「连接已有 AIStudio2API（地址 + API key）」。Windows arm64 可选择系统能够运行的 x64 程序。`;
}

export function studioReleaseTag(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('AIStudio2API version must be a release tag such as v0.3.7');
  const tag = value.startsWith('v') ? value : `v${value}`;
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(tag)) {
    throw new Error('AIStudio2API version must be a release tag such as v0.3.7');
  }
  return tag;
}

// Validate metadata as well as the downloaded bytes. A release cannot redirect installation
// to another repository, a different archive format or an asset without a GitHub SHA-256 digest.
export function officialStudioAsset(release, { platform = process.platform, arch = process.arch, version } = {}) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(unsupportedStudioMessage(platform, arch));
  const requested = studioReleaseTag(version);
  const tag = studioReleaseTag(release?.tag_name);
  if (!tag || release.draft || (!requested && release.prerelease) || (requested && requested !== tag)) {
    throw new Error('GitHub returned an unexpected AIStudio2API release');
  }
  const name = `aistudio2api-${tag}-${target}`;
  const matches = Array.isArray(release.assets) ? release.assets.filter(a => a?.name === name) : [];
  if (matches.length !== 1) throw new Error(`Official AIStudio2API ${tag} has no unique CLI archive ${name}`);
  const asset = matches[0];
  const url = `https://github.com/${STUDIO_UPSTREAM}/releases/download/${tag}/${name}`;
  if (asset.browser_download_url !== url) throw new Error('Unexpected official AIStudio2API asset URL');
  if (!/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest || '')) {
    throw new Error(`GitHub does not provide a SHA-256 digest for ${name}; download and select an executable manually instead`);
  }
  return { version: tag, asset: name, sha256: asset.digest.slice(7).toLowerCase(), url, repository: STUDIO_UPSTREAM };
}

export async function resolveStudioRelease(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!supportsOfficialStudio(platform, arch)) throw new Error(unsupportedStudioMessage(platform, arch));
  const version = studioReleaseTag(options.version);
  const url = version ? `${API}/tags/${encodeURIComponent(version)}` : `${API}/latest`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'magpie-gemini-web' };
  const token = process.env.AI_STUDIO_GITHUB_TOKEN?.trim();
  if (token && /[\r\n]/.test(token)) throw new Error('Invalid AI_STUDIO_GITHUB_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  let release;
  try {
    if (options.fetchFn && options.fetchFn !== globalThis.fetch) {
      const response = await options.fetchFn(url, { headers, redirect: 'error', signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      release = await response.json();
    } else {
      const args = ['--fail', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '15', '--max-time', '45'];
      for (const [key, value] of Object.entries(headers)) {
        if (key !== 'Authorization') args.push('-H', `${key}: ${value}`);
      }
      if (options.proxy && /[\r\n]/.test(options.proxy)) throw new Error('Invalid AI_STUDIO_PROXY');
      // A proxy with credentials travels over stdin, never argv; inner blanks are encoded first.
      const curlProxy = normalizeCurlProxy(options.proxy);
      const proxySecret = hasProxyCredentials(curlProxy);
      if (curlProxy && !proxySecret) args.push('--proxy', curlProxy);
      if (token || proxySecret) args.push('--config', '-');
      args.push(url);
      let config = token ? `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n` : '';
      if (proxySecret) config += `proxy = ${JSON.stringify(curlProxy)}\n`;
      release = JSON.parse(await curlMetadata(args, config));
    }
  } catch (err) {
    // execFile errors include argv, which can contain a proxy password; a signal kill must not echo it.
    const httpStatus = /returned error: (\d{3})/.exec(String(err.stderr || ''))?.[1];
    const reason = (httpStatus ? `GitHub HTTP ${httpStatus}`
      : err.signal || err.code === null ? err.killed ? `curl timed out (${err.signal || 'killed'})` : `curl signal ${err.signal}`
      : typeof err.code === 'number' ? `curl exit ${err.code}` : err.code || err.message);
    throw new Error(`Could not read official AIStudio2API releases (${redactProxyCredentials(reason)}). Check the network or studio.proxy / AI_STUDIO_PROXY, then retry. Existing files were kept.`);
  }
  return officialStudioAsset(release, { platform, arch, version });
}

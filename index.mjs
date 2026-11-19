import { normalizeBaseURL, settings, credentials, listModels, forward, UNREACHABLE_HEADER, PLUGIN_ICON } from './lib/backend.mjs';
import { ensureBackend, localBackend, localSetup } from './lib/native.mjs';
import { registerMagpieCleanup, isPluginRemovedInActiveMagpie } from './lib/cleanup.mjs';
import { importCookie, ensureProxy, validateProxyURL, requireLoginBackend } from './lib/setup.mjs';
import { usage, poolChoices, poolAccounts, accountEmail } from './lib/usage.mjs';
import { startWebConnect } from './lib/web-connect.mjs';

const ID = 'gemini-web';

// Saved macOS Task sign-ins predate removal of the native bridge. Reject them here so their
// local key is not sent to the Gemini Web backend.
function retiredTask(auth) {
  return auth?.type === 'api' && auth.metadata?.mode === 'task';
}

function retiredTaskError() {
  return Object.assign(new Error('macOS 原生 Task 已停用，请改用 Gemini Web 登录'), { signIn: 'expired' });
}

// The local page authorize opens walks the sign-in in its natural order: a private window to
// Gemini first (the backend rotates this session, so a shared one would sign the daily browser
// out of Google), the Cookie copied from it, then the /u/N index that same window shows. Magpie
// itself would open gemini.google.com in the default browser — wrong window — and ask() would
// want the index before any window existed.
const GUIDE_STEPS = [
  'Magpie 会打开本机登录向导页，按页面三步走：',
  '1. 点「打开无痕窗口登录 Gemini」（推荐 Firefox），在无痕窗口登录 Google 账号',
  '2. 按 F12 复制 gemini.google.com 请求的 cookie 值，填回向导页',
  '3. 对照无痕窗口地址栏 /u/N/app 填账号索引（单账号留空），点「验证并完成登录」',
  '为什么必须无痕窗口：后端会定时刷新这份登录保活，和日常浏览器共用会被 Google 踢出登录。',
  'Cookie 只保存在本机的 Gemini Web 后端里，不会发到别处。'
].join('\n');

// signInFor is the Magpie sign-in for one account of the local backend's pool: the backend's
// key, with the account's id for its usage card and its Google email, which names the card and
// keeps each Google account a sign-in of its own (Magpie takes two sign-ins with one email for
// one account, and two with neither for one when their key is the same). The account is the
// pool's own entry (see poolAccounts), which says the way out to read the email by; without
// one the email isn't read.
async function signInFor(local, account) {
  const email = account.email || await accountEmail(account).catch(() => undefined);
  return {
    type: 'success',
    key: local.apiKey,
    metadata: {
      baseURL: local.baseURL, account: account.id, ...(email ? { email } : {}),
      // The account index (/u/N) the email is for; usage takes the email only while it holds.
      ...(email && account.authuser > 0 ? { authuser: account.authuser } : {})
    }
  };
}

// managedBackend is the local backend this plugin set up, when baseURL points at it.
function managedBackend(baseURL, key) {
  if (isPluginRemovedInActiveMagpie()) return null;
  const local = localBackend() || (key ? localSetup() : null);
  return local && local.baseURL === baseURL && (!key || local.apiKey === key) ? local : null;
}

// forwardManaged is forward(), but when the backend this plugin manages can't be reached it
// starts the backend and tries once more.
async function forwardManaged(input, init, getAuth, opts) {
  const retryInput = input instanceof Request ? input.clone() : input;
  const res = await forward(input, init, getAuth, opts);
  if (res.headers.get(UNREACHABLE_HEADER) !== 'unreachable') return res;
  let c;
  try {
    c = credentials(await getAuth(), opts);
  } catch {
    return res;
  }
  if (!managedBackend(c.baseURL, c.key)) return res;
  try {
    await ensureBackend({ proxy: opts.proxy });
  } catch {
    return res;
  }
  return forward(retryInput, init, getAuth, opts);
}

export const GeminiWebPlugin = async (_input, options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    settings(options);
  }
  const { studio: _studio, ...webOptions } = options;
  const opts = settings(webOptions);
  registerMagpieCleanup(_input);
  const proxyPrompt = {
    type: 'text',
    key: 'proxy',
    message: '访问 Google 的代理地址（无需代理或已在代理池配置可留空）',
    placeholder: opts.proxy || 'http://127.0.0.1:7890',
    validate: value => {
      try {
        validateProxyURL(value);
      } catch (e) {
        return e.message;
      }
    }
  };

  // Bring a backend set up earlier back after Magpie or the computer restarts. Not awaited:
  // requests that arrive first start it themselves through forwardManaged.
  if (localBackend()) {
    ensureBackend({ proxy: opts.proxy })
      .then(async local => {
        if (!opts.proxy) return;
        await requireLoginBackend(local);
        await ensureProxy(local, opts.proxy);
      })
      .catch(err => console.error(`[gemini-web] could not start the local backend: ${err.message}`));
  }

  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[ID] ??= { name: 'Gemini Web', npm: '@ai-sdk/openai-compatible', api: opts.baseURL, models: {} };
    },
    auth: {
      provider: ID,
      icon: PLUGIN_ICON,
      // Two at once per sign-in, as a person with two Gemini tabs: an agent's first turn and
      // the session title it asks for alongside no longer wait one behind the other, which
      // Gemini Web can take minutes to answer (#33). The backend still caps each way out to
      // Google (per-IP limits), and Magpie's own setting on the provider goes over this.
      maxConcurrency: 2,
      methods: [{
        type: 'oauth',
        label: '一键配置本地 Gemini Web（推荐）',
        prompts: [proxyPrompt],
        ask(inputs) {
          if (!inputs || !('proxy' in inputs)) return proxyPrompt;
          return null;
        },
        // Opens the local sign-in wizard instead of gemini.google.com so Magpie's window is the
        // guide, not the wrong browser. The backend install starts now so it downloads while
        // the user signs in; the wizard's submit waits for it, imports the cookie with the
        // window's own authuser index, and resolves wait() with the sign-in result (the
        // backend's own API key, one Magpie sign-in per Google account — see signInFor).
        async authorize(inputs) {
          const proxy = validateProxyURL(inputs?.proxy || opts.proxy || '');
          const ready = ensureBackend({ proxy });
          ready.catch(() => {});
          const session = await startWebConnect({
            proxy,
            async submit({ cookie, authuser, proxy: formProxy }) {
              const local = await ready;
              const bind = formProxy !== undefined ? formProxy : proxy;
              const added = await importCookie(local, cookie, { authuser, ...(bind ? { proxy: bind } : {}) });
              const account = (await poolAccounts().catch(() => [])).find(a => a.id === added.id);
              const signIn = await signInFor(local, account || { id: added.id });
              return { signIn, email: signIn.metadata?.email || '' };
            }
          });
          return {
            url: session.url,
            method: 'auto',
            instructions: GUIDE_STEPS,
            async callback() {
              try {
                const done = await session.wait();
                return done?.signIn || { type: 'failed', error: '登录没有返回结果' };
              } catch (err) {
                return { type: 'failed', error: err.message };
              }
            }
          };
        }
      }, {
        type: 'api',
        label: '连接已有后端（自定义地址 + API key）',
        placeholder: 'Backend API key (not a Google cookie)',
        prompts: [{
          type: 'text',
          key: 'baseURL',
          message: 'Backend OpenAI base URL (blank: plugin default)',
          placeholder: opts.baseURL,
          validate: value => {
            try {
              normalizeBaseURL(value || opts.baseURL);
            } catch (e) {
              return e.message;
            }
          }
        }],
        // Magpie stores raw prompt inputs as metadata unless authorize returns its own;
        // write the resolved URL so a blank answer doesn't persist as baseURL: "".
        authorize: async inputs => ({
          type: 'success',
          metadata: { baseURL: normalizeBaseURL(inputs?.baseURL || opts.baseURL) }
        })
      }, {
        type: 'oauth',
        label: '添加本地后端里已有的 Google 账号',
        // Magpie asks through ask(), listing the pool as it is now; prompts holds the question
        // for OpenCode, and makes Magpie hand authorize the answer.
        prompts: [{ type: 'select', key: 'account', message: '选择 Google 账号', options: [] }],
        async ask(inputs) {
          if (inputs?.account) return null;
          if (!localBackend()) throw new Error('还没有本地后端：请先用「一键配置本地 Gemini Web」');
          const choices = await poolChoices();
          if (!choices.length) throw new Error('本地后端里没有启用的 Google 账号');
          return {
            type: 'select',
            key: 'account',
            message: '选择 Google 账号',
            placeholder: '',
            options: choices.map(c => ({ label: c.label, value: String(c.id), hint: c.hint }))
          };
        },
        async authorize(inputs) {
          const local = localBackend();
          if (!local) throw new Error('还没有本地后端：请先用「一键配置本地 Gemini Web」');
          const id = Number(inputs?.account);
          const chosen = (await poolChoices()).find(c => c.id === id);
          if (!chosen) throw new Error(`本地后端里没有启用的账号 #${inputs?.account}`);
          return {
            url: '',
            method: 'auto',
            instructions: '',
            callback: async () => signInFor(local, chosen)
          };
        }
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (retiredTask(auth)) throw retiredTaskError();
        if (auth?.type !== 'api') return {};
        const c = credentials(auth, opts);
        return {
          apiKey: c.key,
          baseURL: c.baseURL,
          fetch: (input, init) => forwardManaged(input, init, getAuth, opts)
        };
      },
      // Magpie's usage card: the 5-hour and weekly limits of each Google account in the local
      // backend's pool, as gemini.google.com/usage shows them. A backend this plugin doesn't
      // manage keeps its accounts out of reach. No read marks the sign-in: the Magpie key
      // belongs to the backend, not to Google.
      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api') return { error: 'Gemini Web 还没有登录', windows: [], signIn: 'kept' };
        if (retiredTask(auth)) return { error: retiredTaskError().message, windows: [], signIn: 'expired' };
        let c;
        try {
          c = credentials(auth, opts);
        } catch (err) {
          return { error: err.message, windows: [], signIn: 'kept' };
        }
        if (!managedBackend(c.baseURL, c.key)) {
          return { error: '只能读取插件自己管理的本地后端的额度（连接已有后端时读不到）', windows: [], signIn: 'kept' };
        }
        const { account, email, authuser } = auth.metadata || {};
        return { ...(await usage(Number.isInteger(account) ? { account, email, authuser } : {})), signIn: 'kept' };
      }
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api') return provider.models;
        if (retiredTask(auth)) throw retiredTaskError();
        const c = credentials(auth, opts);
        try {
          return await listModels(c, opts);
        } catch (err) {
          if (!err.unreachable || !managedBackend(c.baseURL, c.key)) throw err;
          await ensureBackend({ proxy: opts.proxy });
          return listModels(c, opts);
        }
      }
    }
  };
};

export { AIStudioPlugin } from './lib/studio.mjs';
export default GeminiWebPlugin;

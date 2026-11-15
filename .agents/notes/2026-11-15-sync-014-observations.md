# sync-014 C 档门禁第一轮 Oracle 观察项（2026-11-15）

以下 7 条为 Oracle 检出的低危观察项，本轮转记录不改动；涉及代码定位供后续评估。

## 1. [pattern:lockfile-stale-check-and-empty-wx]

- `lib/studio-native.mjs`：`.setup.lock` 在判定为死锁并删除前未重新读取/校验锁文件内容（PID 行与时间戳可能在检查后已被新持有者改写，窄窗内存在误删活锁的理论窗口）。
- `lib/studio-updates.mjs`：`wx`（排他创建）写锁路径在极端断电下可能留下 0 字节空文件；`occupied()` 读取锁内容为空时仍会把它视为占用，可能让自动更新长期自锁，需人工删除。

## 2. [pattern:lockless-catalog-refresh-hot-swap-window]

- `lib/studio.mjs`：`provider.models`（模型目录刷新）不持有 `.studio-use` 租约。若撞上 AIStudio2API 热升级的窄窗口，返回的并非连接拒绝类错误（如 HTTP 5xx/异常 body）时，单次刷新按现状不重试，调用方会看到一次瞬时失败；下一次刷新自愈。

## 3. [pattern:empty-string-proxy-env-precedence]

- `lib/studio.mjs` 与 `lib/studio-native.mjs`：当 `config.json` 存 `{"studio":{"proxy":""}}`（显式清空代理）时，运行态（服务进程环境）仍可能读取 `.env` 中的 `AI_STUDIO_PROXY`/`PROXY` 生效，而 `downloadProxy` 一侧因显式空串返回 `''` 走直连——同一份配置在「运行态代理」与「下载代理」两条路径上优先级判定不一致。

## 4. [pattern:studio-legacy-035-to-official-migration]

- 本机存量 AI Studio `0.3.5-magpie.1`（自构建 legacy）升级到官方 `v0.3.8+` 时：安装流程会先解锁目录权限 `0555`、经 `ensureStudioConfig` 迁移并在 `install-manifest.json`/配置中标记 `legacy-migrated`；旧的 `magpie_signin:1` 签名通道随之退场，后续登录改走手动确认流程。行为符合迁移设计，记录备查回滚/排障语境。

## 5. [pattern:stale-pid-kernel-thread-or-eperm-null-identity]

- Linux 下残留 `backend.pid` 若恰好被内核线程或异主进程复用，`verifyProcessIdentity` 返回 `null`（无法证实也无法证伪），`stopBackend`/`cleanBackend`/`hasBackendAssets` 一律保守拒绝：不删 `backend.pid`、不删 `bin/`，也不发信号。极端触发时（真实后端已死而 PID 被内核线程/异主进程长期占用）需人工删除过期 `backend.pid` 后再执行 `clean`。

## 6. [pattern:local-plugin-cutover-staging-constraints]

- 本机插件切换到新版需满足：先合入主仓 `0.14.1`；`plugins.json` 保持对象 `{"spec": ...}` 结构；核对 `/proc/<pid>/cmdline` 杀掉旧 cleanup watcher；`bin/` 须与数据目录同文件系统落盘为 `0700` 后经原子 `mv` 就位，再经 `ensureBackend()` 拉起。

## 7. [pattern:lockless-fastpath-toctou]

- `lib/native.mjs:429-432` `ensureBackend` 快路径（setup 有效 + 二进制存在 + 状态 `up` 直接返回）不取 `.setup.lock`，与 `cleanBackend` 删除 `bin/` 之间存在窄 TOCTOU 窗口：clean 删完二进制后，并发 ensure 可能在快路径检查与时锁内复查之间误判。已有 reinstall 路径（锁内复查失败后重装）兜底，非本轮引入，维持观察。

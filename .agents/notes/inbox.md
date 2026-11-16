# 观察项收件箱（Inbox）

[pattern:preserved-internal-process-identifiers] | type:redline | added:2026-11-15
`lib/cleanup-detached.cjs` 的 `process.title = 'magpie-gemini-web-cleanup'`（pidfile 与 watcher 身份探测依赖）、默认数据目录 `~/.local/share/magpie-gemini-web`、`argon-build.json` 存量信任清理兼容及 `UPSTREAM_BINARIES` 的 `zexadev/gemini-web2api-go` `v4.28.0` 回滚键不得随作用域包名改写，否则破坏跨版本在途守护进程接管。

[pattern:legacy-unscoped-npm-migration] | type:redline | added:2026-11-15
无作用域旧包 `magpie-gemini-web` 与作用域包 `@dorokuma/magpie-gemini-web` 在 npm 上属两个独立包；迁移期卸载清理逻辑必须同时识别 `PLUGIN_PACKAGE_NAME` 与 `LEGACY_PLUGIN_PACKAGE_NAMES`，防止旧 watcher 误判已卸载并删空新包运行资产。

[pattern:empty-string-proxy-env-precedence] | type:debt | added:2026-11-15
`lib/studio.mjs` 与 `lib/studio-native.mjs`：当 `config.json` 显式设 `{"studio":{"proxy":""}}` 清空代理时，下载路径 `downloadProxy` 返回空串走直连；但服务运行态仍可能采用宿主环境变量 `AI_STUDIO_PROXY`（经 `pluginProxy`）或服务 `.env` 保存的 `PROXY`，两条路径代理优先级不一致。

[pattern:lockfile-empty-wx-self-lock] | type:debt | added:2026-11-15
`lib/studio-updates.mjs`：`wx` 排他创建写锁在极端断电下若遗留 0 字节空锁文件，`occupied()` 读取空内容仍判为占用，会导致自动更新长期自锁直至人工删锁。

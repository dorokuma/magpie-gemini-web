# release/v0.15.0 编码前 Oracle 观察项

[pattern:npm-scoped-packument-tradeoff]
作用域包 `@dorokuma/magpie-gemini-web` 的 packument 走 `https://registry.npmjs.org/%40dorokuma%2fmagpie-gemini-web`（`encodeURIComponent` 编码），一次响应同时含 `versions.<ver>` 与 `dist-tags.latest`；版本条目不存在的响应是 404 还是缺 `versions` 键取决于索引进度，故 `verify-package.yml` 拉整个 packument 再断言两处，避免分两次请求时序窗口。

[pattern:legacy-unscoped-npm-migration]
无作用域包 `magpie-gemini-web` → 作用域包迁移没有「重命名」概念：npm 上是两个独立包。迁移期卸载清理必须同时识别新旧包名（`PLUGIN_PACKAGE_NAME` + `LEGACY_PLUGIN_PACKAGE_NAMES`），否则装了新包的用户会被旧名 watcher 误判为已卸载而清掉资产；README 需提示用户手动卸载旧包装新包。

[pattern:studio-historical-archive-readonly]
`lib/studio-release.json`、`scripts/studio-signin-candidate.json`、`patches/studio-*.patch` 与 `docs/studio-release.md` 文末 BUKOWSKIREAL CI run 记录是历史溯源只读归档：默认安装只跟随官方 Mag1cFall/AIStudio2API Release，这些文件不参与运行时决策；`studio-signin-candidate.json` 的 `repository` 保持旧值以维持历史候选 `repository × tag` 自洽，不随仓库迁移改写。

[pattern:preserved-internal-process-identifiers]
以下内部标识不随包名变化：`lib/cleanup-detached.cjs` 的 `process.title = 'magpie-gemini-web-cleanup'`（pidfile 核验与 watcher 身份探测依赖）、Gemini Web 数据目录 `~/.local/share/magpie-gemini-web`（`GEMINI_WEB_DATA_DIR` 可覆盖）、`argon-build.json` 存量信任与清理兼容、`UPSTREAM_BINARIES` 的 `zexadev/gemini-web2api-go` `v4.28.0` 回滚通道。改任何一个都会破坏在途旧守护进程 pidfile 兼容与跨版本平滑接管。

[pattern:stale-pid-kernel-thread-or-eperm-null-identity]
`verifyWatcherIdentity` 返回 `null`（身份不可核验）或 `lingering` 时保留槽位且跳过立即清理，宁可残留已下载二进制待下次重装自愈，绝不盲杀未知进程，用户账号与数据库不受影响。

[pattern:cross-process-watcher-takeover-window]
`inFlightWatchers` 合并同一宿主进程内双插件并发注册；跨独立 OS 进程同时接管旧 pidfile 的极端窗口未引入跨进程锁文件，最坏多一个常驻孤儿 watcher，并多跑一次带 `.setup.lock` 串行保护的清理。

[pattern:watcher-pidfile-mode-distinction]
`immediate` 卸载清理进程写入的 JSON pidfile 未区分 `mode`（与 0.14.1 行为一致），卸载清理数秒内立刻重装会复用该进程并在下次资产安装钩子触发时自愈。

[pattern:top-level-manifest-read-assumption]
`lib/cleanup.mjs` 顶层同步读取本包 `package.json` 的 `version`，依赖源码检出与 npm tarball 必含合法 `package.json` 的包结构不变式。

[pattern:draft-release-npm-publish-order]
`publish-package.yml` 仅在首次上传 tarball 分支断言 `isDraft === true`；发版规程固定为先校验上传 draft、若发布 npm 后立即取消 draft 标 Latest。

[pattern:single-target-ci-provenance-scope]
插件仓 `backend.yml` 仅从源码重建 `linux-x64` 比对 SHA-256 做跨仓可复现锚点，其余 5 平台由后端仓自身 `release.yml` 构建校验及插件仓 6 平台 `backend-smoke.mjs --download` 矩阵覆盖。

[pattern:macos-ps-title-truncation-boundary]
`isWatcherCommand` 的 `magpie-gemini-web-cl(?:eanup)?` 前缀正则属覆盖 macOS `ps` 短缓冲区（约 20 字节）标题截断边界的尽力而为启发式：截断落在 `magpie-gemini-web-cl` 至 `magpie-gemini-web-cleanup` 区间内可识别，更短截断不命中时仅走 `foreign` 另起 watcher、绝不盲杀；更短路径缓冲截断的根治需跨版本引入非 `ps` 令牌通道，不在本轮范围。

[pattern:release-gate-fence-and-tag-peeling-scope]
`Makefile` `release-check` 的 CHANGELOG 章节解析 awk 仅以第 1 列顶格三反引号（`index($$0, "```") == 1`）作为代码围栏开关，缩进或更长围栏不翻转 `fence` 状态；对维护者自写的 CHANGELOG.md 足够，外部粘贴含缩进围栏的章节可能被计入实质正文。`publish-package.yml` 的 `release-commit` 与 `pack-and-upload` 两作业内联同构约 20 行附注 tag 剥离逻辑：`matching-refs` 分页接口经 `r.ref === \`refs/tags/${tag}\`` 精确过滤后 `tagRef` 才可空，`while (obj.type === 'tag')` 链式调 `git/tags` 剥离且 `depth <= 10` 封顶，最终只锁定 40 位 SHA-1 hex 的 peeled commit；`targetCommitish` 非 40 位 hex（如分支名）时跳过一致性断言，远端无该 tag 的草稿回退模式则断言 `targetCommitish` 恰为 40 位提交 SHA。

[pattern:matching-refs-pagination-and-draft-target-sha]
`publish-package.yml` 用 `gh api --paginate --slurp repos/${repo}/git/matching-refs/tags/${tag}` 加客户端精确匹配 `refs/tags/${tag}` 区分「远端已有 tag」与「未打 tag 的草稿回退」：正确性建立在 Git 引用字典序（精确名恒排在 `-rc` 等前缀扩展项之前）与 `--paginate --slurp` 完整拉页之上，同时依赖 runner 预装 `gh >= 2.22` 及同前缀 tag 响应体小于 `execFileSync` 默认 1 MiB 缓冲（超限或旧版 `gh` 均 fail-closed 报错）；主发版规程固定为先推送附注 tag 再建草稿 Release，若未推 tag 先建草稿则须传 `gh release create --draft --target <40位SHA>`（GitHub UI 默认传分支名会被草稿回退分支显式断言拦截）。

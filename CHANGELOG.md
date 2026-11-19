# 更新日志

本文件按版本倒序记录 `magpie-gemini-web`（0.15.0 起为 `@dorokuma/magpie-gemini-web`）的全部已发布与待发变更，依据本仓 `git log` 与 tag 事实编写。

## 0.18.0 - 2026-11-19

### 变更
- Gemini Web 后端 pin 升级至 **`dorokuma/gemini-web2api-go` `v6.2.0`** 官方预编译二进制：**`gemini-4-carbon` 对话模式与任务模式拆分**——`gemini-4-carbon` / `gemini-4-carbon-thinking` / `gemini-4-carbon-thinking-medium` 改为纯对话模式（三档各自准确自报），新增独立任务模式模型 `gemini-4-carbon-task`，三大家族（Neon / Carbon / Hydrogen）均提供独立 `-task` 模型（对应 Gemini Web 网页端「任务」开关）。

### 修复
- AI Studio 插件兼容 `AIStudio2API` `v0.3.x` 的 `interactions_api` 能力键名：上游自 `v0.3.12` 起将 Deep Research 模型的能力标记由 `interaction_route` 更名为 `interactions_api`，恢复 `deep-research-*` 模型在新版后端 `/v1/models` 下的展示，同时保留旧 `interaction_route` 键的兼容。

## 0.17.0

### 新增
- Gemini Web 后端 pin 升级至 **`dorokuma/gemini-web2api-go` `v6.1.0`** 官方预编译二进制：**对话模式与任务模式分离**，新增任务/工具密集型场景独立模型 `gemini-4-neon-task` 与 `gemini-4-hydrogen-task`（对应 Gemini Web 网页端「任务」开关），日常对话模型 `gemini-4-neon` / `gemini-4-hydrogen` / `gemini-4-carbon` 行为不变；同时包含 `v6.0.1` 的工具调用提示词修复（不再诱发「工具调用次数有上限/工具被停用」幻觉而拒绝继续调用工具）。

### 文档
- README（中英）与 `package.json` description 清理过时的 `gemini-4-argon` / Argon 文案（谷歌已下架 Argon），补充对话模式与任务模式分离说明；删除「与原版的主要差异」中面向维护者的发版流程条目。

## 0.16.0

### 破坏性变更
- Gemini Web 后端 pin 升级至 **`dorokuma/gemini-web2api-go` `v6.0.0`** 官方预编译二进制：上游模型目录将原 Argon 的 Mode=8 槽位原位改名为 4 Carbon，**对外 `gemini-4-argon` / `gemini-4-argon-thinking` / `gemini-4-argon-thinking-medium` 三条模型已移除**，请求这些模型名不再被识别。请改用 `gemini-4-carbon*` 或新增的 `gemini-4-neon*`（Argon↔Carbon 的 `strict_model` 同槽互认逻辑保留）。

### 新增
- **Gemini 4 Neon 模型接入**：Gemini Web 新增 `gemini-4-neon` / `gemini-4-neon-thinking` / `gemini-4-neon-thinking-medium` 三条对外模型（付费号专属，免费号静默降级）；Neon 为服务端内部思考模型，回复不输出 `reasoning_content`。
- `strict_model` 同槽升级豁免降级冷却：请求 `4 Neon Medium` 收到 `4 Neon High` 自报属同槽单向升级，不再误判降级并冷却账号。

### 文档
- README（中英）与 `package.json` description 更新 Gemini Web 侧模型清单为 Gemini 4 Carbon / Hydrogen / Neon，注明 Neon 服务端内部思考不输出 `reasoning_content`；AI Studio 侧原有模型说明（含 `gemini-4-argon`）不变。

## 0.15.3

### 修复
- 后端版本感知自愈：`ensureBackend` 收养在跑后端前比对后端自报版本（`GET /` 的 `version`）与盘上二进制期望版本（pin 版本、`argon-build.json` 记录的本地构建版本）。**插件升级现在真正换后端**：旧版只查健康就收养活进程，npm 更新后老后端只要不死就永远顶替新版运行。
- 陈旧后端正确回收：版本不匹配或盘上二进制不可信时，按「监听端口 + 进程映像归属本数据目录（exe/--config/--db 任一路径落在 dataDir 内）」精确识别并终止旧进程（Linux 走 `/proc`，macOS 走 `ps`，Windows 无此场景），再安装/拉起 pin 版本；同名端口但归属其它数据目录的进程、以及无法识别的占用一律不动。
- 修复两处静默假成功：旧逻辑在「二进制换了但旧进程仍占端口」时健康检查照样 200，新进程永远起不来而表面一切正常；「占端口者密钥不同（foreign 表象）」时直接报错而非回收，手工/老插件起的后端永久卡死。

## 0.15.2

### 文档
- README（中英）增补 Fork 声明与致谢章节：注明 fork 自 `BUKOWSKIREAL/magpie-gemini-web` 的上游归属、MIT 许可继承与与原版的主要差异。

### CI
- 发版链路迁移 npm **Trusted Publishing (OIDC)**：`pack-and-upload` 作业显式升级 npm（OIDC 要求 ≥ 11.5.1）；npm 首包发布经由作用域包 + token staging 引导完成（npm 侧历史占位 `0.0.0-stage` 为 staged-publishing 机制产物）。

## 0.15.1

### 修复
- AI Studio 代理优先级收口：插件配置 `studio.proxy`（及传入 `options.proxy` 的 `install` / `prepare-browser` `--proxy`）显式设为空串 `""` 时在服务运行态与安装/自动更新下载态一致地跳过 `AI_STUDIO_PROXY` 与管理页 `.env`/`config.json` 保存的代理（运行态注入 `PROXY=""`；macOS/Windows 上后端自身的系统代理自动检测仍可能生效；CLI `start --proxy ""` 保持清空 `.env` 保存值的既有语义），未设置（缺省 `undefined`）时仍按原顺序回退。
- 自动更新锁原子发布与自愈：维护门与使用租约改为写满 .pending-record.*.tmp 后经 renameSync 原子发布，消除活写者暴露半截锁文件的竞态窗口；同时对历史/极端断电遗留超过 10 秒宽限窗的 0 字节/损坏锁及孤儿暂存文件自动清理（二次读取发现内容已变更时保持占用语义），不再永久自锁。

### 文档
- `AGENTS.md` 铁律补入无作用域旧包 `magpie-gemini-web` 迁移期双包名卸载清理红线。

## 0.15.0

### 变更
- npm 包名切换为作用域包 **`@dorokuma/magpie-gemini-web`**；卸载清理的 `plugins.json` 匹配同时接受新包名与历史包名 `magpie-gemini-web`（精确名、`@version`、git/URL spec、本地目录 `package.json` 的 `name`），迁移期双名并存不误判。
- Gemini Web 后端固定使用 **`dorokuma/gemini-web2api-go` `v5.0.0`** 官方预编译二进制：默认通道直接按 `lib/backend-release.json` 中 6 平台（macOS arm64/x64、Linux x64/arm64、Windows x64/arm64）的 SHA-256 pin 从后端仓 Release 下载校验，一仓一制品，插件仓不再重编。
- 退役 `patches/argon.patch` 打补丁重编流水线：删除 `patches/argon.patch`、`scripts/backend-release.mjs`、`scripts/backend-argon.mjs` 与 `publish-backend.yml`，`backend:release:build`、`backend:build:argon`、`backend:install:argon`、`backend:start:argon` 命令随之移除。历史本机 `argon-build.json` 记录仍被信任与清理，存量自定义构建不受影响。
- 守护进程跨版本平滑接管：卸载清理 watcher 的 pidfile 升级为 JSON `{ pid, pluginRoot, version }`，兼容读取旧版纯数字 pidfile；检测到存活的旧格式或旧插件实例 watcher 时，经 watcher 进程身份核验后先安全终止旧进程再拉起新 watcher，且退出清理只删除 `pid === process.pid` 的 pidfile，避免旧进程退出误删新记录。
- `magpie plugin options` 报错提示中的插件名更新为 `@dorokuma/magpie-gemini-web`。

### 新增
- `scripts/sync-backend-pins.mjs`：`--write-pins --tag=vX.Y.Z` 从后端仓 Release 的 `SHA256SUMS.txt` 单向同步 6 平台 pin（原子写入、严格校验 SemVer/仓库/资产名/哈希，且拒绝与上游回滚哈希重复）；`--verify` 离线校验清单结构后联网比对已发布 `SHA256SUMS.txt` 并确认 6 个资产可达；`--verify-schema` 纯离线校验。对应命令 `backend:pins:verify`、`backend:pins:sync`、`backend:smoke`。
- `scripts/backend-smoke.mjs` 支持 `--binary=<path>` 冒烟本地二进制，`--download`（或解包 tarball 后默认）从 pin 的 Release URL 下载校验后端。
- `Makefile`：`make check`（npm test + pin 离线校验 + `npm pack --dry-run`）与 `make release-check TAG=vX.Y.Z`（TAG 单行 SemVer、`package.json` 名版本匹配、pin 结构、CHANGELOG 章节实质内容、已有同名 tag 必须为 annotated tag 且指向当前 `HEAD`）。

### CI
- `backend.yml`：增加 `concurrency` 防抖；`plugin` 作业跑 `make check`、`sync-backend-pins.mjs --verify`，并以 Go 1.27.1 从 pin 的源码 tag 重建 `linux-x64` 比对 SHA-256 做可复现溯源；6 平台矩阵直接 `backend-smoke.mjs --download` 冒烟真实发布二进制。
- `publish-package.yml`：修复作用域包 tarball 名（`dorokuma-magpie-gemini-web-X.Y.Z.tgz`）；发版与重跑复用 tarball 时无条件执行 `make check` 与 `make release-check TAG=<tag>`，并支持远端附注 tag 剥离锁定提交 SHA。
- `verify-package.yml`：跑 `make check`；packument 一次请求同时校验版本条目与 `dist-tags.latest`，URL 按 `encodeURIComponent` 编码作用域名。
- `studio.yml` / `studio-official.yml`：POSIX 分支以 `make check` 替换 `npm test`（Windows runner 保持原样）。
- 仓库档位升为 L2。

### 迁移提示
- 已安装旧无作用域包 `magpie-gemini-web` 的用户：在 Magpie 中删除旧插件条目，重新安装 `@dorokuma/magpie-gemini-web`；本地数据目录 `~/.local/share/magpie-gemini-web`、账号、Cookie、数据库与凭据不变，双包名兼容期卸载清理不会误判新插件为已卸载。

## 0.14.1（同步上游 0.14.0 与后端 v4.28.0-magpie.5）

- 后端升级至 `v4.28.0-magpie.5`（自托管 `dorokuma` fork 重建，上游基线 `v4.28.0`）；同步上游 `v0.14.0`。
- AI Studio 默认自动跟随官方 Mag1cFall/AIStudio2API 最新稳定版：后台检查更新、空闲窗口下载校验后自动更新并保留账号/端口/凭据，可 `studio:updates auto|manual` 控制；旧 `-magpie` 构建可自动替换为官方包。
- 新增官方安装、生命周期、自动更新、用户自备路径等冒烟脚本与 `studio-official.yml` 五平台可复用验证工作流；`publish-package.yml` 增加发布 tarball 校验与上传。
- README 与包描述更新至 Gemini 4 Carbon / Hydrogen 模型说明；`backend-release.json` 记录 `upstream.commit` 与 Go `1.27.1`。

## 0.13.2（v0.13.1 + 补丁同步）

- `argon.patch` 与上游 main 同步，后端发布 `v4.28.0-magpie.3`。

## 0.13.1（v0.13.0 + 自托管 fork）

- 仓库迁移至 `dorokuma/magpie-gemini-web`；后端切换为自托管 fork 构建并发布 `v4.28.0-magpie.2`；仓库建立 L1 基线。
- 移除已退役的 macOS native Task 登录桥。

## 0.13.0

- AI Studio 升级至 `0.3.5-magpie.1`；修复 #53 多账号索引漏传（Gemini 账号索引修复）。
- 自动衔接上游账号导入与 Magpie 登录（#54）。
- 完善发布元数据与包 tarball 上传工作流。

## 0.12.0

- AI Studio `0.3.4-magpie.1`，Gemini Web 后端 `4.28.0-magpie.1`。
- 管理页界面重构适配；`strict_model` 槽位校验兼容显示名家族互认。

## 0.11.0

- AI Studio `0.3.2-magpie.1`，Gemini Web 后端 `4.27.1-magpie.1`。

## 0.10.0

- AI Studio `0.3.0-magpie.1`（账号异步任务流、Chrome/Cookie/CDP 导入、SpiderMonkey 默认生成后端），Gemini Web 后端 `4.27.0-magpie.2`。
- 新增 `/v1/chat/completions` 上的 Deep Research 模型（#45/#46）。
- 新增卸载清理：在 Magpie 中删除插件自动停止并清理已下载后端与 Camoufox，保留账号与配置（#44）。
- 账号索引（authuser）变化后重新读取用量；`web_channel` 被忽略时仅提示一次（#43）。

## 0.9.0

- AI Studio 升级至 `0.2.19` 并保留已保存设置（#39）。
- AI Studio 服务信息卡片不再显示额度读数（#38）。
- Gemini Web 后端升级 `4.27.0-magpie.1`；图片输入默认开启（#41）。

## 0.8.1

- Gemini Web 后端 `4.26.0-magpie.2`：排队请求按上游沉默计时等待出字而非固定超时（#36）。
- 修复刷新显示 Gemini Web 当前用量（#35）。

## 0.8.0

- AI Studio `0.2.18-magpie.1`：WAA 后端迁移至 SpiderMonkey（CGO）。
- AI Studio 图片输入默认开启（#30）；Nano Banana 图片模型接入 Magpie 出图（#28）。

## 0.7.0

- AI Studio `0.2.17-magpie.1`：CGO SQLite 构建与请求正文安全迁移补丁。
- 新增 Twin Sparkles 插件图标（#25/#26）；README 增加 Star 趋势图。

## 0.6.0

- 后端 `4.26.0-magpie.1`、AI Studio `0.2.16-magpie.1`；新增 Gemini Web 登录代理支持（#24）。
- 修复慢速下载、长等待与非 ASCII/相对路径下的安装与登录（#23）。

## 0.5.6

- 兼容 Bun `ConnectionRefused` 探测本地 AI Studio 端口（#22）。

## 0.5.5

- AI Studio 登录进度独立页面，在 Magpie 超时前结束展示；补充 PowerShell 5.1 插件选项写法文档。
- 托管服务启动不再借用 Magpie 代理，旧服务检测代理来源提示。

## 0.5.4

- AI Studio 升级至 `v0.2.14`（无补丁官方版）。

## 0.5.3

- AI Studio 代理设置改由管理页持有并显示来源。

## 0.5.2

- AI Studio `v0.2.13` 托管构建并禁用其在线更新；每个 AI Studio 账号独立登录；README 重构为对比表与折叠进阶章节。

## 0.5.1

- AI Studio 每个 Google 账号恢复为独立登录项（Magpie 账号列表按邮箱显示），0.5.0 的池化登录保留其卡片。
- AI Studio 登录入口合并为单一路径：新装即完成托管服务部署并打开登录窗；已有账号先列新增、再列本地服务账号，过期的可直接重登；自备 AIStudio2API 仍为独立入口。
- 登录步骤明确提示首次登录将下载 Camoufox（约 300 MB）。

## 0.5.0

- 新增 Google AI Studio Provider，由托管 AIStudio2API 支撑。
- Cookie 校验超时报后端无法连接 Google；发布流水线增加 npm/GitHub 包与真实下载校验、CI 上传私有 draft 资产。

## 0.4.1

- 默认安装切换为优化版后端发行物（`-magpie` 构建）：新增 `lib/backend-release.json` 平台 pin 清单与 optimized/upstream 双通道（`backend-channel.json`），配套 `backend-release.mjs` 发布、`backend-smoke.mjs` 冒烟与 `backend.yml` 发布工作流。
- 后端源码归档兼容 Windows tar；CI 支持上传已校验后端二进制到私有 release 草稿并经 release 列表解析草稿资产。
- 文档补充 macOS native Task 登录实测说明与付费 Google AI Pro 可用 `gemini-4-argon` 的说明。

## 0.4.0

- 工具调用默认开启，并在后端返回 400 时提示开启方式。
- macOS 提供 Gemini.app native Task 实验性登录（后续版本已退役）。

## 0.3.3

- Argon 直连请求携带 Chrome 请求头降低特征；Cookie 轮换后不再每次抓取 app 页面；用量按后端实际通路读取且仅在变化时刷新。

## 0.3.2

- 默认声明 1M token 上下文窗口。

## 0.3.1

- 移除回复中的 Gemini 引用标记（`[cite: n]` 等）。

## 0.3.0

- 在 Magpie 中展示每个 Google 账号的 5 小时与每周额度；要求用无痕窗口取 Cookie；README 中英双版本重写。

## 0.2.0

- 新增一键本地配置：从 Magpie 内安装、启动并登录（#9）。

## 0.1.3

- 提供 low/high 思考档位，路由至 `-thinking` 模型（#8）。

## 0.1.2

- 后端迁移至上游 `v4.22.0`，Argon 补丁重打为 `4.22.0-argon.1`；文档记录后端 API key 与 admin token 存放位置。

## 0.1.1

- 登录时持久化解析后的 baseURL，空提示不再保存为空串。
- Argon 后端补丁升级至 `4.21.0-argon.2`，降低首 token 与工具调用延迟（#1）。

## 0.1.0

- 首个版本：Gemini Web Provider，携带 Argon 后端补丁（`4.21.0-argon.1`）。

# AGENTS.md

档位：L2

## 检查
- `make check`：依次运行 `npm test`（`node --test test/*.test.mjs` 全量单测）、`node scripts/sync-backend-pins.mjs --verify-schema`（离线校验后端 pin 清单结构）与 `npm pack --dry-run`。
- `make release-check TAG=vX.Y.Z`：发版前校验 TAG 严格为 `vX.Y.Z`、`package.json` 名称与版本匹配、pin 清单结构与 `CHANGELOG.md` 对应章节，本地已有同名 tag 时还要求其为 annotated tag 且指向当前 `HEAD`。
- CI：`backend.yml` 的 `plugin` 作业跑 `make check`、`--verify`（联网比对已发布 `SHA256SUMS.txt` 与 6 平台资产可达性），并以 Go `1.27.1` 从 pin 的 `repository`/`tag` 重建 `linux-x64` 比对 SHA-256；`backend` 矩阵在 6 平台跑 `backend-smoke.mjs --download`。

## 铁律
- 包名为 `@dorokuma/magpie-gemini-web`；Gemini Web 本地数据目录 `~/.local/share/magpie-gemini-web` 与 watcher `process.title`、`magpie-gemini-web-cleanup` 不变，保证旧守护进程 pidfile 兼容替换与 `argon-build.json` 存量信任。
- Gemini Web 后端固定为 `dorokuma/gemini-web2api-go` 官方 Release 预编译二进制（当前 `v5.0.0`），pin 在 `lib/backend-release.json`，只能由 `node scripts/sync-backend-pins.mjs --write-pins --tag=vX.Y.Z` 单向同步远端 `SHA256SUMS.txt` 生成，禁止手改 SHA256；升级后端只改 tag 后重新同步。`patches/argon.patch` 与本地重编流水线已退役。
- `UPSTREAM_BINARIES` 保留 `zexadev/gemini-web2api-go` `v4.28.0` 作为显式校验回滚通道（`backend:install:upstream`），不得删除或改哈希。
- AI Studio 后端默认自动跟随官方 Mag1cFall/AIStudio2API Release；`lib/studio-release.json`、`scripts/studio-signin-candidate.json`、`patches/studio-*.patch` 与 `studio.yml`/`publish-studio.yml` 属历史溯源只读归档，不参与默认安装，未经任务明确授权不得修改。
- `.agents/notes/` 为白名单模式：目录被 .gitignore 忽略，值得公开的结论用 `git add -f` 逐条入库。
- 无作用域旧包 `magpie-gemini-web` 与作用域包 `@dorokuma/magpie-gemini-web` 在 npm 上属两个独立包；卸载清理逻辑必须同时识别 `PLUGIN_PACKAGE_NAME` 与 `LEGACY_PLUGIN_PACKAGE_NAMES`，防止旧 watcher 误判已卸载并删空新包运行资产。
- 日常变更记入中文 `CHANGELOG.md` 的 `## [Unreleased]`，发版时将其归入 `## X.Y.Z`（与 `package.json` 同 commit 更新）并通过 `make release-check TAG=vX.Y.Z`。

## 关联
- 上游/维护后端源码：`/root/workspace/gemini-web2api-go`（远端 `dorokuma/gemini-web2api-go`，上游 `zexadev/gemini-web2api-go`）。
## Release Policy / 发布规范

本节是本仓库发版的强制规则。仓库已有的更具体版本、构建或发布渠道规则优先，但不得降低以下底线。

1. **版本与变更记录**：遵循 Semantic Versioning，正式版本使用 `vX.Y.Z`。破坏性变更升 MAJOR，新功能升 MINOR，兼容修复升 PATCH。任何用户可见行为、运行时/API/包接口、依赖、安全性或分发产物变化，都必须在同一发版提交中更新版本元数据并写入 CHANGELOG/Release Notes；纯文档且不产生可分发产物时可免升版，但须在规则或 Release Notes 中明确说明。
2. **发布门禁**：发版前工作树必须干净，版本号、CHANGELOG 与发布说明必须一致；必须运行仓库规定的测试、构建、lint、类型检查及必要的安全检查，且全部通过。若仓库提供 `release-check`、`make release-check`、版本检查脚本或同等门禁，必须原样通过，不得绕过。
3. **发布顺序**：先提交并推送发布提交到目标分支 → 在该发布提交上创建 Tag（默认使用带注解的 `git tag -a vX.Y.Z -m "vX.Y.Z"`；仅当现有发布工具明确要求轻量 Tag 时可例外）→ 推送 Tag → 创建**非草稿** GitHub Release → 再发布 npm、PyPI、容器镜像等关联分发渠道。不得只推分支或只打 Tag 就宣称发版完成。
4. **GitHub Release 产物**：标题使用 `vX.Y.Z`，正文必须包含实质性变更摘要、升级/破坏性变更说明及验证结果；二进制、安装包、插件包等适用产物必须作为 Release assets 上传，并提供校验和（如适用）。**Tag 本身不等于完整发版，必须同时存在可访问的 GitHub Release。**
5. **发布后验收**：至少执行并确认 `git ls-remote --tags origin refs/tags/vX.Y.Z`、Tag 指向发布提交、`gh release view vX.Y.Z` 可访问且不是 draft；若发布到包仓库/镜像仓库，还必须核验对应版本、摘要或安装链接可用。
6. **不可变性**：已发布 Tag 不得复用、移动或删除，不得 force push 发布分支或 Tag，不得从未提交、未经测试或未通过门禁的树发布。发布后发现问题须通过新的 patch 版本修复，禁止覆盖历史 Release。
7. **例外必须显式化**：归档、已停用、被替代、仅文档或无可分发产物的仓库，必须在项目规则中明确写出“不发新版本”及历史 Tag/Release 的处置方式；例外不能用于绕过上述发布闭环。

### Repository-specific release contract

- 本仓具体权威流程见 `AGENTS.md` 既有 `make release-check TAG=vX.Y.Z`、CHANGELOG、npm 与固定后端二进制规则；不得以通用条款替代该门禁。

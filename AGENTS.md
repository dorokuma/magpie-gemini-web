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
- 发版前必须更新中文 `CHANGELOG.md` 并通过 `make release-check TAG=vX.Y.Z`。

## 关联
- 上游/维护后端源码：`/root/workspace/gemini-web2api-go`（远端 `dorokuma/gemini-web2api-go`，上游 `zexadev/gemini-web2api-go`）。

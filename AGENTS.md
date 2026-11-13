# AGENTS.md

档位：L1

## 检查
- `make check`：运行 `npm test`（`node --test test/*.test.mjs` 全量单测）。

## 铁律
- 仓库自维护于 `dorokuma/magpie-gemini-web`；Gemini Web 后端预编译二进制 pin 在 `lib/backend-release.json`，由 `node scripts/backend-release.mjs --write-pins` 生成，禁止手改 SHA256。
- AI Studio 后端 pin 在 `lib/studio-release.json`，由 `scripts/studio-release.mjs` 管理。
- 补丁 `patches/argon.patch` 是后端行为的唯一权威来源；升级后端版本时同步更新该补丁再重建 pins。
- `.agents/notes/` 为白名单模式：目录被 .gitignore 忽略，值得公开的结论用 `git add -f` 逐条入库。

## 关联
- 上游/维护后端源码：`/root/workspace/gemini-web2api-go`（远端 `dorokuma/gemini-web2api-go`，上游 `zexadev/gemini-web2api-go`）。

# 后端发布与同步

从 `0.15.0` 起，Gemini Web 后端采用**一仓一制品**：插件直接使用 [`dorokuma/gemini-web2api-go`](https://github.com/dorokuma/gemini-web2api-go) 官方 Release 发布的预编译二进制，插件仓不再保留补丁与本地重编流水线（`patches/argon.patch`、`scripts/backend-release.mjs`、`scripts/backend-argon.mjs` 已退役）。`lib/backend-release.json` 是唯一 pin 清单，记录 `version`、`repository`、`tag` 与 6 个平台资产的文件名和 SHA-256。

## pin 的结构与约束

- `version` 为严格单行 SemVer（如 `5.0.0`），`tag` 必须等于 `v${version}`，`repository` 固定为 `dorokuma/gemini-web2api-go`。
- `binaries` 恰好包含 6 个平台键：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`；资产名为 `gemini-web2api-go_v${version}_${goos}_${goarch}${ext}`（Windows 为 `.exe`），哈希为 64 位小写十六进制。
- 任何平台的哈希不得与 `lib/native.mjs` 中 `UPSTREAM_BINARIES`（上游 `zexadev/gemini-web2api-go` `v4.28.0` 回滚通道）重复，避免通道混淆。
- **禁止手改 SHA-256**；pins 只能由同步脚本生成。

## 同步新后端版本（write-pins）

后端仓发布新 Release（含 6 平台二进制与 `SHA256SUMS.txt`）后：

```bash
node scripts/sync-backend-pins.mjs --write-pins --tag=vX.Y.Z
# 或
npm run backend:pins:sync -- --tag=vX.Y.Z
```

脚本会：

1. 校验 `--tag` 为严格单行 `vX.Y.Z`；
2. 拉取 `https://github.com/dorokuma/gemini-web2api-go/releases/download/vX.Y.Z/SHA256SUMS.txt`；
3. 解析并校验 6 个平台齐全、无重复、资产名精确匹配、哈希为 64 位小写十六进制；
4. 构造清单并再次校验后**原子写入** `lib/backend-release.json`（2 空格缩进 + 末尾换行）。

## 校验（verify / verify-schema）

```bash
node scripts/sync-backend-pins.mjs --verify-schema   # 纯离线：校验清单结构
node scripts/sync-backend-pins.mjs --verify          # 离线校验 + 联网比对
# 或 npm run backend:pins:verify
```

`--verify` 先做离线结构校验，再拉取已发布 `SHA256SUMS.txt` 逐平台比对哈希完全一致，并对全部 6 个资产 URL 发 `HEAD`（必要时回退 `Range: bytes=0-0`）确认可达。CI 的 `plugin` 作业额外用 Go `1.27.1` 从 pin 的源码 tag 重建 `linux-x64` 并比对 SHA-256，提供源码↔二进制可复现溯源。

## 冒烟（backend-smoke）

```bash
node scripts/backend-smoke.mjs --download           # 从 pin 的 Release URL 下载真实二进制
node scripts/backend-smoke.mjs --binary=/path/bin   # 冒烟本地二进制（仍校验 pin 哈希）
# 或 npm run backend:smoke
```

冒烟使用独立临时数据目录与黑洞代理，验证安装、SHA-256、`GET /` 的 `health.version === release.version`、`capabilities.account_proxy_binding === true`、认证、模型列表、双代理池首检绑定以及已验证二进制的复用；不使用 Google 账号。解包 tarball 后可直接运行 `package/scripts/backend-smoke.mjs --download`。

## 回退（upstream 通道）

`lib/native.mjs` 保留上游 `zexadev/gemini-web2api-go` `v4.28.0` 的 6 平台 pin 作为**显式校验回滚通道**：

```bash
npm run backend:install:upstream   # 回退并固定官方 v4.28.0
npm run backend:install            # 恢复默认（pin 的 dorokuma Release）
```

选择持久化在数据目录 `backend-channel.json`；自动启动按所选通道校验哈希。历史本机 Argon 构建的 `argon-build.json` 记录继续被信任与清理，但不再产生新的本地构建。

## 首次发布 npm 包

`@dorokuma/magpie-gemini-web` 首次发布到 npm 必须提供 `NPM_TOKEN` secret（npm Trusted Publishing OIDC 仅支持已存在包的后续版本，工作流会在未配置 token 且包尚不存在时直接报错）。

# OBA Codex 评论草稿（本地定制版）

基于官方 v1.6.1（commit 2a50be8690844704f0ab359c36742572a92a6320），开发分支 `feat/codex-comment-drafts`。保留上游 MIT LICENSE。

## 使用

1. 打开独立应用 `OBA-Codex.exe`，进入「自动回复」。
2. 「Codex 评论草稿」显示已找到 CLI 后，可先点「不直播，先试写」。测试不需要连接千帆或开启直播。
3. 展开「回复要求和模型」，输入主播语气及已确认的直播信息。模型留空使用 CLI 默认模型；可选填当前账号有权限使用的模型。
4. 真实评论通过原有千帆连接与「开始监听」进入列表。点某条文字评论旁的「Codex 拟回复」，再点「生成回复草稿」。
5. 草稿在该弹窗内显示，可编辑、复制或照着口播。**不会进入原有自动回复队列，也不会自动发送。** 原有「开始任务」是另一套自动回复功能，使用 Codex 草稿无需开启它。

首次识别不到 CLI 时，先安装 Codex CLI 并在终端运行 `codex login`。本机已使用 ChatGPT 登录，不需要在 OBA 填 API Key。账号认证和使用额度由 Codex CLI 管理。

只在点击生成时把选定评论正文和主播要求提交给 Codex；昵称、时间、其他评论、千帆登录信息不包含在提交内容里。回复要求和模型保存在本机；草稿不持久保存，关闭弹窗会丢弃草稿，关闭生成中的弹窗会取消该请求。每次调用独立、最多同时一条，120 秒超时；失败可重试。

1.6.1-codex.2 会将 Electron 解析到的系统代理传给 CLI 子进程；已有的代理环境变量优先，不修改 Windows 全局设置。生成时显示等待秒数、模型等待和网络重试状态，可主动取消。若长时间等待，先检查系统代理是否可用。

## 开发与构建

Node.js + pnpm（本机验证 pnpm 11.19.0）。

```text
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm run test:codex
pnpm run test:codex-live
pnpm run build:local
```

`test:codex-live` 会真实调用已登录 Codex，消耗账号额度；内容为合成测试评论。

若 Electron 二进制自动下载失败，可从 Electron 官方发布页下载与 `node_modules/electron/package.json` 版本一致的 Windows x64 zip，按该包 `checksums.json` 校验后解压到 `node_modules/electron/dist`，并写入 `path.txt` 为 `electron.exe`。本机使用 Electron 36.9.5，已通过 SHA256 校验。

本机离线复用 Electron 目录打包命令：

```text
pnpm exec vite build
pnpm exec electron-builder --win --dir --publish never --config.electronDist=node_modules/electron/dist
```

依赖锁文件已纳入版本管理；构建时将 Electron node-gyp 固定为同项目发布到 npm 的版本，避免间接 Git 安装。`motion/react` 替代了上游未声明依赖的 `framer-motion` 导入。

## 设计与验证

- Electron 主进程固定 IPC 接口；原生 spawn 参数数组、shell=false、评论通过 UTF-8 stdin。
- 每次 CLI 运行使用独立临时目录，read-only、ephemeral，忽略用户配置，禁用 shell、浏览器、MCP 配置、插件、Hooks 等；不读取本项目上下文。临时输出在结束后清理。
- 原始 stderr 不回传界面，避免将内部诊断/认证信息带入评论草稿。
- 按请求 ID 和窗口归属取消；窗口销毁时终止所属请求；UI 关闭弹窗也会取消。
- 独立应用名/数据目录；关闭上游自动更新，避免定制功能被官方二进制覆盖；默认关闭上游固定的调试端口。
- 本地自用目录包未签名，不发布到远程仓库。原安装版仍可独立使用。

已验证：TypeScript 检查、五项输入/提示词隔离/默认模型/并发取消/代理环境测试、生产构建、Windows 目录打包、应用启动与 CLI 识别。主进程服务使用本机代理完成合成评论的真实调用，一次测试耗时约 11 秒；这不是延迟保证。真实直播评论的点击生成需在收到评论后试用；尚未验证任何平台发送（本功能没有发送操作）。

官方 CLI 调用说明：https://learn.chatgpt.com/docs/non-interactive-mode

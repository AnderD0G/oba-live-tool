# Mac 完整桌面助播台交接

目标是复用 Windows 当前 `1.6.7-voice.52` 的完整 Electron 助播台：同一套 React 页面、桌面后台、SQLite workers、实时信息/任务、筛选、回复草稿、翻译、打点、OBS 设置和手机入口。不重新设计界面。

**之前 `deploy/mac-handoff` 的 ZIP 是 Docker core，只有简化管理页和手机端；它不是这次要安装的桌面程序。** 不要继续在管理令牌页面配置桌面界面，也不要直接从仓库默认分支构建旧版。请使用本目录交付的完整源码 ZIP，并先读解压后的 `START-HERE-MAC.md`。旧容器和数据保留；如果它还在采集，先通过它自己的页面停止采集，避免两个实例同时监听。不要删 Docker 卷。

## 给 Mac 上 Codex 的步骤

1. 在普通用户目录解压为 `oba-mac-desktop`。核对仓库交付说明里的 ZIP SHA256，再按 `PACKAGE-MANIFEST.json` 验证文件。这里包含 `src/`、`electron/preload/`、完整 `electron/main/`、`shared/`、`public/`、锁文件和桌面构建配置。Windows `node_modules`、EXE、浏览器登录、数据库、密钥和私人配置都没有带。
2. 使用 Mac 原生 Node 24 和 pnpm 10.34.5。Apple Silicon 终端里确认 `node -p process.arch` 是 `arm64`。安装 Mac Chrome；不要沿用 Windows 的浏览器路径。在源码根目录执行：

   ```sh
   HUSKY=0 pnpm install --frozen-lockfile
   pnpm exec tsx --test tests/macDesktopBuild.test.ts tests/desktopLanding.test.ts tests/macMcpDiscovery.test.ts tests/desktopConfigImport.test.ts
   pnpm build:mac
   ```

   新入口只在 macOS 上执行，默认生成当前架构的 `.app`，不下载 Windows Codex 运行时、不发布、不删除旧产物。M4 Pro 对应的产物：

   ```text
   release/1.6.7-voice.52-mac-arm64/mac-arm64/OBA-Codex.app
   ```

   如先选择生成 DMG，用 `pnpm build:mac --dmg`；Intel 可用 `--arch x64`。同一个输出目录已存在时会拒绝覆盖，先另存旧产物再构建。不要复制 Windows 的 Electron distribution。不要运行旧 `build:installer`，它是 Windows 安装流程。
3. 打开 `.app`，应直接进入「实时助播台」，有完整侧栏和配置功能。生成的是本地未签名程序；按 macOS 正常的“打开”流程确认，不要全局关闭系统保护。先验证空场景打开、SQLite worker 就绪、没有自动采集或发送。可以运行下面的隔离 smoke，它只写临时 profile，结束关闭自己启动的窗口：

   ```sh
   node scripts/smoke-desktop-config-import.mjs "/绝对路径/OBA-Codex.app/Contents/MacOS/OBA-Codex"
   ```

4. 用户会另给私人文件 `助播台配置.json`（Windows 上在桌面「发给Mac」文件夹）。它只含知识、回复规则和客户筛选策略，单独传输，不上传仓库。启动目标 Mac 桌面程序、停止采集后执行：

   ```sh
   node scripts/import-desktop-assistant-config.mjs "/绝对路径/助播台配置.json" "$HOME/Library/Application Support/OBA-Codex"
   ```

   先确认这个目录确实是本次 `.app` 的 userData，里面应有运行中的 `director-api.json`。如果用了 `OBA_USER_DATA_DIR`，第二参数必须用那个实际目录。本次迁移文件和工具只对应 `default` 账号，其他账号会拒绝，避免把规则写入不存在的账号。工具在本机读取接口令牌，用户不用手填管理令牌。它按目标 revision 分别保存，服务端在同一命令队列里检查采集已停止；遇到冲突或不确定结果会停止并报告 `applied/partial/outcomeUnknown`，不要盲重跑。导入前如目标已有自定义配置，先备份。确认导入的知识和模板适合本次直播，原测试语境可能仍在文本里。
5. 在 Mac 配置模型密钥并登录 TikTok，接回 Mac OBS WebSocket。Windows 的加密凭据、浏览器登录、盘符和虚拟声卡不直接复制。已有 OBS 场景继续在 Mac OBS 里使用；这个源码包没有迁移 OBS 素材/场景。先自测翻译预览、任务置顶/清空、手机入口、Find N5 展开布局和打点。实际公开发言必须沿用用户确认流程，不因安装自动发送。实际直播测试结束停止采集、等写入排空，再关闭受管直播间窗口以节省代理流量。

## MCP 复用

复用 `scripts/mcp-director-server.mjs` 和 `shared/*Contract.mjs`，工具名字和协议不变。Mac 需要重新登记本机 stdio 启动路径；Windows 的现有 MCP 仍控制 Windows。它不是远程 WebSocket 服务，不能把 OBS WebSocket 地址填到这里，也不把私密 token 写进交接包。

Mac Codex 检查已有 MCP 项，合并一个本机连接，保留其他设置；不要覆盖整个 `~/.codex/config.toml`。下面是模板，Node、源码和 userData 都换成 Mac 的**实际绝对路径**，TOML 里不要直接写 `$HOME` 或 `~`：

```toml
[mcp_servers.oba_director_mac]
command = "/实际路径/node"
args = ["/实际路径/oba-mac-desktop/scripts/mcp-director-server.mjs"]
cwd = "/实际路径/oba-mac-desktop"
startup_timeout_sec = 20
tool_timeout_sec = 180

[mcp_servers.oba_director_mac.env]
OBA_USER_DATA_DIR = "/Users/实际用户/Library/Application Support/OBA-Codex"
```

启动 `.app` 后，MCP 从 Mac 这份 `director-api.json` 自动读端口和本机令牌；它支持 Mac 默认 Application Support 目录，显式 profile 只连接该 profile。按 Codex 客户端方式重新加载连接，用 tools/list 和只读能力/状态验证，确认采集未启动、OBS 未推流。普通 OBA API 仍只允许本机回环，不要为省事改成公开 LAN API。配置方式依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 本次验证的界限

Windows 上已验证这套桌面原型、构建配置/路由测试、配置导入和真实 EXE 的隔离 IPC 读回。交付说明会列本次干净解压构建结果。**这台 Windows 不能替代 Mac `.app` 实际启动验证**：Mac Codex 需要完成 native build、打开窗口、SQLite 两个 worker、Chrome、手机访问和 OBS 连接检查，再报哪些已经通过。

当前助播台的语音输入调用本机 `127.0.0.1:7799` 的外部豆包服务，源码里保留了可选 `deploy/voice-container`。这不代表它已接好 Mac 的实体麦克风；原容器 7799 没有向宿主机发布，不能直接让桌面版凭空连上。请单独验证/配置这一条，避免把调试 API 暴露到局域网。历史 Qwen CUDA 模型、Windows CABLE 虚拟声卡和本机导播实验服务也不是 Mac 原生可用的承诺，它们不阻碍打开完整桌面助播台。

不要重做 UI、不要启用冷热分层/压缩、不要导入旧测试观众数据库、不要清除现有数据。先把用户熟悉的桌面工作流接回 Mac，再逐项确认平台相关外设。

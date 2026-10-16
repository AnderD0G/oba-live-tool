# OBA Voice（Mac 独立语音连接）

OBA Voice 把本机麦克风连接到本机 Docker 中的 Selkies/豆包浏览器。它独立于普通 Chrome 标签页，也独立于 OBA-Codex 主程序。关闭普通 Chrome 的容器页面不会断开 OBA Voice 的连接。

首次使用时，macOS 会询问是否允许 **OBA Voice** 使用麦克风，请允许。权限只授予 `https://127.0.0.1:13443` 主页面的音频请求；摄像头、屏幕捕获、外部导航和弹窗均拒绝。拒绝后不会循环弹出系统授权框；可在「系统设置 → 隐私与安全性 → 麦克风」允许后，通过菜单「重新连接」。

菜单栏的「语音」图标提供当前状态、显示窗口、暂停/恢复和退出。点击窗口左上角关闭按钮只隐藏窗口，连接继续；**暂停**会销毁页面、释放麦克风；**退出 OBA Voice**会结束连接。需要继续语音时让 OBA Voice 保持运行，不必保留普通 Chrome 标签页。

窗口右上方有 **OBA Voice · 本机窗口** 控制条。点「最小化」可缩到 Dock，点「收起到后台」可隐藏窗口；两者都保留豆包和语音连接。控制条下方会提示「收起后豆包继续运行」。画面里面的 Chromium 关闭按钮会关闭容器内浏览器，需要收起时请使用这两个本机按钮；可从 Dock 或菜单栏「语音 → 显示语音窗口」再次打开。

当前支持的旧版容器在 WebSocket 已连接且收到服务端配置后，只发送一次开启麦克风的请求；只有收到真实麦克风成功状态才显示「正在转发」。请求失败会显示未开启，不会不断重试打开设备。服务断开会显示断开，并在重连后重新确认状态。若未来经过验证的容器支持按需录音，会尊重其按需策略，空闲时释放麦克风。打开连接不会开始豆包录音、翻译或发送。

本功能不是直播闭麦开关。它不改变 TK Studio、OBS 或系统的麦克风状态；直播端是否静音必须单独确认。直播闭麦与豆包录音使用独立链路。

## 安装配置

应用身份固定为 `com.local.oba.voice`，独立数据目录是 `~/Library/Application Support/OBA-Voice`。不读取或修改 OBA-Codex 的数据库、登录资料或普通 Chrome 配置。

安装时从已核对的本机容器复制**公钥证书**到该目录的 `server-cert.pem`，目录权限 `0700`、文件权限 `0600`、当前用户所有，不使用符号链接。首次启动会把证书 SHA-256 指纹固定到同目录 `trust.json`；后续不会自动接受网络返回的新证书。不要复制私钥。

也可以显式启动一次：

```sh
open -a 'OBA Voice' --args --certificate='/绝对路径/本机公钥证书.pem'
```

或传入已核对的 SHA-256 十六进制指纹 `--certificate-fingerprint=...`。证书变化后需要显式重新配置。`--voice-user-data=/绝对路径/独立目录` 可用于隔离验收，不会改正式配置。只允许连接固定本机 HTTPS/WSS 地址；没有全局忽略证书校验。

每次 TLS 验证都核对固定指纹，包括系统原本信任的 CA 证书；更换成其他证书不会绕过固定指纹。

## 开发与验收

复用仓库已安装的 Electron 36 和 electron-builder，无新依赖：

```sh
node --test deploy/mac-voice-app/test/*.test.cjs
node scripts/build-mac-voice-app.cjs arm64
```

产物位于 `release/oba-voice-1.0.1-mac-arm64/mac-arm64/OBA Voice.app`。打包脚本不会安装、启动应用，也不会打开物理麦克风。首次物理麦克风权限、真实设备输入及观众隔离效果必须另外在本机验收；自动化状态测试不能替代这些检查。

脚本只复用当前 Mac 的本机 Electron 运行时，只接受与运行脚本的 Node 架构一致的目标；Apple Silicon 上不接受 `x64` 交叉打包，也不隐式下载其他架构。Intel 版请在对应的 `x64` Mac/运行时环境构建。

合成输入验收可用 Electron 标准 `--use-fake-device-for-media-stream`、`--use-fake-ui-for-media-stream`、`--use-file-for-fake-audio-capture=/绝对路径/tone.wav`。必须同时传三个参数，并通过 `--voice-user-data` 指定系统临时目录下的独立私有目录，WAV 必须位于该目录中；条件不齐会拒绝启动，以免误用真实麦克风。只有这类隔离输入才跳过 macOS 物理设备授权。

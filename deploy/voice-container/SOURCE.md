The bridge source was selected from the user-provided
`豆包语音项目-源码.zip` (read on 2026-10-16):

- `service/doubao_ctl.mjs`
- `service/package.json`, with its `ws` range pinned to version 8.21.3 for the image

`doubao_ctl.mjs` remains byte-for-byte unchanged. The package lock records the
registry dependency and integrity; Docker installs `ws` 8.21.3, including its MIT
LICENSE, during the build. Preinstalled `node_modules` is excluded from Docker
contexts and the portable handoff package.

No Chrome profiles, cookies, credentials, Windows runtime, DSH plugin, or recorded
audio are included. The original HTTP/CDP bridge is unchanged. Its optional
Windows clipboard copy returns `clipboard:false` on Linux; recognized text is
still returned over HTTP. The service controls only the isolated container Chrome.

LinuxServer's official Chromium image supplies the separate Selkies microphone
forwarding feature. It is not supplied by the DSH plugin in the source ZIP.

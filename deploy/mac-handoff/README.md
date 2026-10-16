> **完整 Electron 桌面版请转到 [Mac 完整桌面助播台交接](../mac-desktop/README.md)，下载其中的 `oba-mac-desktop-1.6.7-voice.52.zip` 并按包内 `START-HERE-MAC.md` 安装。**
>
> 本目录保留的是较早的 Docker core 交付，只含简化管理页与手机端，未包含完整 Electron 助播台。它不再是本次完整桌面安装的入口；现有容器和数据请保留。

# Mac Docker core handoff — 1.6.7-voice.52

This directory contains the reviewed deployment source snapshot for 2026-10-16. Use the ZIP contents for this version; the repository root on this handoff branch remains the older base checkout.

- File: `oba-mac-core-1.6.7-voice.52.zip`
- Bytes: 1502899
- SHA-256: `83f82bffac3937aab434242b80f9698ecdff4fe2bf3ebd1b147327dd4806a914`
- The ZIP contains its own per-file `PACKAGE-MANIFEST.json`; all ZIP CRCs and package file hashes were checked before handoff.

## On the Mac

Download the ZIP, then verify and extract it in a new directory:

```sh
shasum -a 256 oba-mac-core-1.6.7-voice.52.zip
unzip oba-mac-core-1.6.7-voice.52.zip -d oba-mac-voice52
cd oba-mac-voice52/oba-mac-core
```

Give Mac Codex `docs/docker-mac-quickstart.md`. Follow that guide to configure private host/admin/model credentials and the Mac LAN address, install the native bridge dependencies with Node 24, and run `docker compose up -d --build`. Read `docs/docker-core.md`, `docs/docker-host-bridge.md`, and `docs/docker-validation.md` for the full commands and validation limits. The optional logged-in Doubao Chromium service is documented under `deploy/voice-container/`.

## Included and excluded

Included: the Docker core service, persistent SQLite storage, mobile assistant UI, native Chrome/device bridge, optional Doubao Chromium deployment, build/test scripts, and deployment documentation. The Docker web management page is a minimal core interface.

Not included: Windows account profiles/cookies, database/history, private configuration export, real credentials, OBS scenes/assets, camera management, the complete Electron desktop, or raw protobuf analysis archives. Transfer any intended private configuration separately; do not commit it. Keep the persistent data volume; do not run `down -v`. Compression, hot/cold tiers, and history cleanup were deliberately deferred.

## Verified limits

Windows voice.52 completed a continuous 12-minute real live-room test with 2,161–2,463 online viewers: raw records 4,692/4,692 saved, mobile polls 245/245, no new drops, followed by stop/drain and closure of the managed live-room Chrome. Existing Windows historical drop counters were preserved; they are not copied into a fresh Mac deployment.

The Docker core and its persistence/bridge functions were exercised in Linux amd64 containers on Windows. The pinned image indexes include arm64, but a physical Mac, its real microphone, and macOS permissions still require local verification. Doubao recognition/cancellation was tested through the container audio chain using synthetic speech; this does not certify a Mac physical microphone. Start with a small local test before the first live broadcast, and stop/drain/close every real live-room test to save VPN traffic.

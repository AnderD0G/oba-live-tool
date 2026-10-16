# Persistent Mac voice connection implementation plan

> Execute the user-authorized update in this session, with independent review. User approved independent window and requested develop / feat/mac-desktop workflow.

**Goal:** Keep the Doubao microphone connection independent of ordinary Chrome tabs.

**Architecture:** A small separately packaged Electron app retains the Selkies WebContents, exposes explicit lifecycle controls and narrowly scoped audio permission, and uses the existing local voice backend. Upgrade the Chromium service only after isolated compatibility checks and a cold profile backup.

**Tech Stack:** Existing Electron 36 arm64 runtime, Node built-in test runner, Docker Compose, Selkies native page messages.

**Spec:** ../specs/2026-10-16-voice-connection.md

## Constraints
- Preserve any live collection; restart for the authorized update only after the desktop is confirmed idle.
- Do not start ASR, send a reply, or start broadcasting as part of setup.
- Keep credentials, profiles, backups and generated binaries out of Git.
- Verify exact local-origin permissions, certificate identity, hidden-window persistence and cleanup.
- Physical microphone success and audience isolation are separate from synthetic transport acceptance.

## Review focus
- Refused macOS permission produces a clear state without repeated prompts.
- Docker downtime and reconnect cannot leave a false connected indicator.
- A user pause survives navigation/reconnection in the same process.
- Window close keeps the bridge alive; explicit quit stops all capture.
- No broad certificate bypass, remote navigation, camera permission or logging of audio/text.

## Task 1: Common baseline and Mac branch
- [x] Verify complete source package and remote base branch.
- [x] Import into develop, inspect for private data, commit and push (1bf6022).
- [x] Create isolated feat/mac-desktop workspace from this baseline.

## Task 2: Voice companion
- [x] Write failing behavior tests for origin checks, permission policy and connection state transitions.
- [x] Add the minimal main/preload/state code and dedicated build configuration.
- [x] Pass focused tests, type/build checks and packaged synthetic microphone transport acceptance.
- [x] Independently review privacy scope and hidden-window/quit behavior; extend pin verification to trusted-CA paths.

## Task 3: Upgrade and local install
- [x] Pull candidate arm64 Chromium digest and verify actual microphone_on_start support.
- [x] Stop only idle voice services and back up their profile; record rollback config.
- [x] Runtime-check the candidate; it failed SIGILL before Chromium started, so restore the working pinned image and use the companion's compatible page protocol.
- [x] Package/install/open companion 1.0.1; actual local toolbar and forwarding status verified, no implicit ASR/send.
- [x] Record tests/limits and update launcher/documentation.
- [ ] Commit/push Mac feature branch and merge verified changes into develop as requested.

## Added task: user-approved TK Studio microphone hotkey

The user chose the direct microphone route: TK Studio and Doubao independently consume the physical microphone; OBS supplies video only. Implement a manual input-device toggle via the supported TK Studio hotkey rather than a private API. The installed Studio accepts at most three keys, so use Control + Option + M. It is a toggle with no reliable mute state readback; do not claim mute success or automatically start ASR.

- [x] Bind only Studio input-device Mute / Unmute, then navigate away/back and verify persistence.
- [x] Add fixed-scope native key sender, permission/status checking, concurrency and duplicate-click protection.
- [x] Add an OBA assistant-desk control with truthful expected-route state. User later requested paired start/stop/cancel hotkey linkage and expressly accepted one initial test instead of repeated UI verification.
- [ ] Verify tests, native helper, packaged app and local toggle behavior without going live.
- [ ] Document that audience isolation and other audio sources still require a local recording test.

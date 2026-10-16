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
- [x] Commit/push initial Mac feature delivery (`31f881e`). Final API follow-up and develop integration are tracked in the mobile controls release steps.

## Added task: TK Studio microphone control

The user chose the direct microphone route: TK Studio and Doubao independently consume the physical microphone; OBS supplies video only. A fixed Control + Option + M helper was initially implemented. The user subsequently supplied the existing local service at `http://127.0.0.1:18766/docs`; the active implementation now uses its explicit mute target and actual status. The native helper is retained for compatibility, with no automatic fallback.

- [x] Bind only Studio input-device Mute / Unmute, then navigate away/back and verify persistence.
- [x] Add fixed-scope native key sender, permission/status checking, concurrency and duplicate-click protection.
- [x] Add an OBA assistant-desk control with truthful expected-route state. User later requested paired start/stop/cancel hotkey linkage and expressly accepted one initial test instead of repeated UI verification.
- [x] Verify native helper packaging and initial desktop tests. Verify API mute and restore once against the actual Studio microphone icon, with streaming/recording off; restore the original open state.
- [x] Replace the daily control facade with the fixed local API, mute before ASR and restore the prior state afterward; remove the keyboard permission prompt from desktop and phone.
- [x] Document the external service dependency and distinguish the controlled microphone from other audio sources.
- [x] Run final API regression (162 pass, one platform skip), packaged desktop/phone read-only route acceptance and install voice.54 with existing credentials preserved. Branch integration follows the mobile controls release steps.

# Optional isolated voice container POC

This is an opt-in feasibility probe. It does not replace or stop the Windows
voice service, OBS, existing Chrome, or host microphone.

```sh
docker compose -f deploy/voice-container/compose.yaml up -d --build
node scripts/test-voice-container.mjs
node scripts/test-voice-container.mjs --audio
```

The image builds from public source and the vendored package lock alone. Docker
installs the exact `ws` 8.21.3 dependency with `npm ci --omit=dev --ignore-scripts`;
no Windows `node_modules`, Chrome profile, or login files are copied into it. A
clean Mac checkout or handoff package does not need preinstalled vendor modules.

The optional speech test requires this container's Doubao login. Generate a
nonprivate known-speech WAV (on Windows, run
`powershell -File scripts/test-voice-container-speech.ps1`), then pass its path:

```sh
node scripts/test-voice-container.mjs --recognize --wav <known-speech.wav>
node scripts/test-voice-container.mjs --cancel --wav <known-speech.wav>
```

Open **https://127.0.0.1:13443/** in a local browser, accept the local self-signed
certificate, then log in to Doubao in the remote Chromium. The independent named
volume `oba-voice-poc_profile` preserves that login. No existing Chrome profile is
copied. `down` preserves the volume; do not use `down -v` if the login is needed.

For real use, open the Selkies sidebar and enable its microphone button, allowing
microphone access in the local browser. The optional Mac voice companion can
hold this connection independently of ordinary Chrome tabs and enable forwarding
when its connection is ready. This connection must remain open while speaking.
On macOS, permit that local client to use the microphone in System
Settings. The virtual input is then available to Doubao inside Chromium. Stop or
cancel the recording through the normal voice API; closing the client is not a
replacement for a confirmed stop.

Only the HTTPS desktop is published, on host loopback port 13443. CDP 9223 stays
on the container namespace's loopback; voice HTTP 7799 has no host published
port. The sidecar shares Chromium's network namespace. A future core container
can join this private Compose network and call `http://chromium:7799`; host/LAN
access requires an authenticated proxy or tunnel. Do not publish the raw voice
API: it includes unguarded debug/eval actions. Do not change current host 7799 or
9223 bindings to try this POC.

The `--audio` probe starts a fresh, isolated headless local Chrome with a fixed
440Hz WAV as its fake microphone. It enables Selkies microphone forwarding,
then measures the tone through getUserMedia in **container Chromium**, including
frequency and RMS checks. It does not open a physical host microphone. The basic
probe checks the desktop/CDP/HTTP bridge without recording. These two probes do
not start Doubao ASR. The explicit `--recognize` / `--cancel` modes send only the
supplied known fixture through the logged-in Doubao voice page and confirm the
final recording state. No probe logs in or copies cookies. A passing tone probe
verifies audio transport; speech mode additionally verifies Doubao ASR. Neither
proves actual Mac hardware microphone access or the current user's IAB permission.

The copied bridge still depends on the current Doubao page selectors and uses a
Windows clipboard helper; clipboard failure on Linux is nonfatal. Both the
Chromium and Node base images support amd64/arm64; this Windows machine can only
provide an amd64 runtime verification. The image indexes are pinned to the tested
digests and both include amd64/arm64 manifests. See `verification.json` for the
measured result. The service is not connected to the production core yet.

Official sources:

- https://docs.linuxserver.io/images/docker-chromium/
- https://docs.linuxserver.io/selkies/user-guide/web-client/#audio-and-microphone
- https://docs.linuxserver.io/selkies/user-guide/configuration/#feature-toggles-and-session-start-state

`SELKIES_AUDIO_ENABLED=true` is required even when only sending a microphone.
`SELKIES_AUDIO_ON_START=false` leaves output streaming off without disabling
microphone forwarding. The pinned image does not implement
`SELKIES_MICROPHONE_ON_START`; the Mac companion uses the supported page protocol
instead. Enabling forwarding does not start Doubao recording.

Mac arm64 compatibility note (2026-10-16): the newer image index
`sha256:9761e4dce2375165ab85566d5a58920525d49c49469ed7a08a6d874dcdb1cedc`
includes demand mode but its Selkies executable exited with signal 4 / code 132
on the tested Docker host, before Chromium started. Keep the verified pinned
image above until a candidate passes an actual runtime test, not just an image
manifest architecture check. A cold profile backup was retained locally.

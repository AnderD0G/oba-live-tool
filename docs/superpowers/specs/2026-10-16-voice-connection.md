# Persistent Mac voice connection

The user approved a separate persistent voice window so ordinary Chrome tabs can be closed. Keep the existing OBA desktop, collected data, manual translation/send behavior and Docker login volume. Import the verified complete desktop source to develop first; all subsequent Mac code belongs on feat/mac-desktop.

Provide an independently packaged OBA Voice app with its own stable macOS identity and data directory. It connects only to the loopback Selkies desktop. Closing its window hides it without destroying microphone forwarding; menu commands show it, pause the connection, and explicitly quit. Disable background throttling. Report actual microphone acknowledgement and connection failures, never infer success from sending a command.

Keep microphone permission limited to audio on the exact configured loopback origin. Deny camera and unrelated origins. Pin the current local container certificate rather than globally disabling certificate checks. The user grants the app macOS microphone access once. Container/physical microphone failure must remain visible and must not trigger repeated permission prompts.

Try a newer optional Chromium voice container only after a cold profile backup and an actual arm64 runtime check. The candidate with demand mode failed with SIGILL before Chromium started on this Docker host, so retain the known working pinned image. The companion uses that version's native page protocol to enable microphone forwarding after connection and waits for acknowledgement. A new voice connection never starts Doubao recording itself.

The additional broadcast-mute requirement is separate: muting the livestream must leave the physical microphone available to ASR. Before private Chinese dictation, a future guard must verify all configured broadcast paths are closed, fail closed on uncertainty, and restore the audience microphone only by deliberate action. Use the built-in microphone until DJI RX is connected. No physical-device global mute and no claim that an OBS source mute alone controls TK Studio direct capture. This iteration records the routing requirement; live routing acceptance depends on configuring a verifiable broadcast output.

Acceptance: independent app starts against the upgraded backend, actual virtual-input synthetic tone passes in an isolated profile, normal window close leaves its connection alive, explicit quit destroys it, no Doubao recording/send starts during setup. The physical microphone and audience isolation require an explicit local test and must be reported separately if unverified.

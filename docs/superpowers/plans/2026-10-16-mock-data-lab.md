# Mock data lab

The user approved desktop JSON import and a worker API for realistic simulated live events. The installed voice.57 application and OBS assets remain frozen while this branch is developed.

## Behavior

- A small, initially collapsed desktop panel prepares a JSON batch, starts/stops playback, clears all simulated history, and opens an optional worker endpoint. Mobile can view and process the selected simulated feed, without import or playback controls.
- Workers fetch current audience labels/rules, countries, languages, field definitions and an OpenAPI 3.1 contract before preparing `users[]` and timed `events[]`. Upload prepares data only. Desktop starts playback.
- All simulated facts, classification, translation, replies, sessions, request receipts and historical queries live in RAM. No temporary journal or SQLite file is acceptable. Clear and app exit destroy them. Existing real data stays in the real service.
- Reuse the normal classification/translation/draft pipeline. An immutable manual-only constraint prevents automatic public replies even when real settings use auto. Public replies require a selected authenticated real room and a direct human Send action; the room may belong to the user or somebody else. Worker APIs cannot send or start capture.
- OBS effect configurations/resources are reused read-only; simulated execution state and receipts use RAM. Never publish simulated events on the global real-event bus.
- Real capture and Mock playback are mutually exclusive. Source selection explicitly routes desktop/mobile state, history and row actions. Physical camera/microphone controls remain independent.
- The API is off until enabled on desktop, has its own ephemeral scoped token, validates account/metadata revision/body limits, and cannot modify production configuration. Private network URLs require a reachable local worker; cloud model output can instead be imported as JSON.

## Implementation tasks

1. RAM journal/index injection, immutable manual-only service mode and cancellable timed Mock runtime, with no-file and late-result tests.
2. Strict shared batch contract, live safe metadata, optional scoped API, OpenAPI/overview/example and HTTP contract tests.
3. Active-source integration and authenticated target-bound manual-send adapter; isolated OBS effect adapter with RAM receipts.
4. Collapsed desktop import/API controls, visible simulated-memory provenance on both clients, shared history/row handling without mobile import.
5. Run focused regressions, full project checks and packaged smoke using an owned disposable profile; do not replace the installed frozen release.

## Verification priorities

No simulated facts are written to disk; clear/stop cannot revive old tasks; stale metadata is rejected; workers cannot start/send; actual-room target changes reject a queued send; real capture guards remain unchanged; local and AI translation remain available; desktop and phone show the same selected simulated feed; production app and OBS scene configuration remain unchanged during development.

## Completed candidate verification

- Candidate `1.6.7-mock.1` built for native Mac arm64; installed `voice.58` remains unchanged at `2ba0378`.
- Full suite: 248 passed, 1 platform skip, 0 failed. TypeScript and native packaging passed.
- Owned packaged smoke: 12 checks passed, covering worker auth/prepare-only API, 7 event kinds, audience classification, desktop/Director/phone same RAM feed, stale source write rejection, local-effects option isolated in RAM, stop/history/clear/leave, token revocation, and formal SQLite/JSON exclusion of unique simulated markers. No real capture, provider requests, public sends or live-service writes were performed by this smoke.
- Cross-review resolved selection after unselected clear and delayed hook cancellation; Mock-only OBS text adapter restores owned legacy text on normal cleanup while preserving human edits/replacements.
- Empty real hooks receive optional welcome/like/follow test templates in RAM only; the desktop explicitly controls the simulated local-effects switch.

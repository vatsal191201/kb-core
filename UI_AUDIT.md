# KB Core UI audit — 2026-09-07

Primary viewport: 390 × 844 CSS pixels. Changes applied directly to the static app; no build tooling, framework, dependencies, or media processing added.

## Changes

- **Framing (`styles.css`):** Library cards and detail-sheet media use `object-fit: contain` against the existing neutral dark background. The run wrapper has a definite height of `clamp(160px, 24dvh, 260px)`; its video fills that box with `contain`. This preserves landscape, portrait, and 3:4 frames without depending on decoded video dimensions. Removed conflicting duplicate run video/wrapper/media definitions. Short-screen CSS no longer hides the demo or stop cue.
- **Run layout (`styles.css`):** The spacer fills spare vertical room, keeping the sticky transport deck at the bottom. Side labels can wrap alongside the phase label; long next-exercise names wrap instead of being truncated. Consolidated the duplicate source-player frame rule.
- **Library details (`index.html`, `library.js`):** Fixed a dead detail sheet: JavaScript changed the hidden attribute while the permanent `hidden` class kept it invisible. Its generated content now uses the existing sheet styles, with a sticky close control, contained demo, separated metadata, and wrapping source credit. Opening focuses Close; closing restores card focus. Returning home closes the detail and pauses its video.
- **Equipment gates (`app.js`):** Add/Swap lists only the selected equipment pool, and insertion checks equipment again. Saved sessions containing an exercise outside the selected mode are rejected and regenerated. Existing library and source-list gates remain intact.
- **Session editor (`app.js`, `index.html`, `styles.css`):** Add/Swap reveals and scrolls to the picker. Swap is labelled correctly. Picker and queue counts are populated; first Up and last Down are disabled. Leaving or regenerating closes the picker. Empty sessions disable Start. Removed the initially visible picker placeholder.
- **Timing settings (`app.js`, `index.html`):** Rounds changes now rebuild the queue; regeneration respects the chosen rounds. Intensity selection sets its default rounds and refreshes the focus count. Numeric input no longer rewrites intermediate digits while typing; values normalize on commit. HTML limits match the existing engine limits: 1–6 rounds and 0–30 seconds prep. Timing edits refresh queue durations. Replaced the stale initial library count of 46 with a loading placeholder.
- **Run state (`app.js`, `library.js`):** Rest titles now match the upcoming demo and cue. Prep no longer announces a left side before work starts. Starting resets Pause and closes the remaining-list disclosure. Transport changes while paused keep the demo paused and refresh progress text. Finishing pauses the demo and clears the phase class. Updating the remaining list scrolls its own container, avoiding document jumps.
- **Timer and summary (`app.js`):** Natural transitions preserve the clock origin and catch up across delayed callbacks. History duration now measures active time independently of skips, Back, and pauses. New history entries retain equipment and intensity names, and history displays the intensity. The progress bar exposes its current value and is labelled as interval progress.
- **Offline update (`sw.js`):** Bumped the shell cache from `kbcore-v21` to `kbcore-v22` so the changed CSS and JavaScript are refreshed.

## Verification

Used the existing Python Playwright installation and local headless Chrome against a temporary static HTTP server.

- Audited home, equipment toggles, timing/intensity settings, session editor and picker, library and filters, exercise detail, source list and chapter overlay, prep, work, rest, remaining-list disclosure, summary, and return navigation at 390 × 844.
- Verified the library and picker counts are **50 kettlebell / 49 bodyweight / 99 both**. Checked generated queue IDs and every visible library ID against the selected mode. Checked all seven library filters in all three modes. Checked source-list membership against source equipment metadata and chapter navigation for sources with chapters.
- Exercised Add, Swap, Remove, disabled reorder boundaries, rounds changes, all intensity presets, and rejection of a persisted kettlebell session under bodyweight settings.
- Loaded all 99 posters: **88 at 640 × 360, 10 at 360 × 640, and one at 360 × 480**. Checked every library video uses `contain`; stepped all 99 exercises through the run screen and checked names, rest titles, contained video geometry, no horizontal page overflow, and transport-deck bounds within the viewport.
- Visually reviewed screenshots, including portrait library/detail/run framing, landscape rest framing, and summary. Screenshots and the temporary browser harnesses are in `/tmp/kb-audit/` and `/tmp/kb_*.py`.
- Tested pause/resume, +30 seconds, −10 seconds, Back/Skip while paused, restart button state, End, completion, and history. Simulated natural transitions, unilateral side switching, and an 85-second callback delay. Active-time history excluded a 60-second pause and did not count skipped queue time.
- Offline reload passed; all three equipment counts remained correct. A previously cached poster loaded offline; cached MP4 `Range: bytes=0-99` returned HTTP 206 with the correct 100-byte body and Content-Range.
- JavaScript syntax checks and JSON parsing passed; no browser page errors in the UI audit. Confirmed exactly one base declaration each for `.run__vid` and `.run__vidwrap`.
- Compared SHA-256 hashes with the existing pre-edit backup: all 198 media files plus `exercises.json`, `sources.json`, `segments.json`, and `manifest.json` are unchanged.

## Limits

H.264 decoding and actual playback were not verified in headless Chrome. Framing verification uses computed CSS, element geometry, and decoded poster images. External source-video playback was not tested; the audit verified overlay controls and generated chapter URLs while blocking external requests. Offline media remains available after it has been cached; the app does not precache all 99 clips.

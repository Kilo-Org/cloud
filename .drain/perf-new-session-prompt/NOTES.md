# Perf work notes: new-session prompt with long drafts (Android)

Scratch evidence for drain work item `…-w1`. This directory is measurement scaffolding and
must be deleted before the pull request is opened.

## Measured on this VM (emulator-5554, AVD omp36, API 36, swiftshader)

- `adb shell input text` cost on a plain system `EditText` (Settings search field):
  6000 characters in 16.05 s, i.e. about 2.7 ms per character. The tool dominates any
  host-side wall time, so host timing does not measure the app.
- Device-side timing (`ondevice.py`, `date +%s%N` around `input text` inside one adb shell)
  on the new-session prompt:
  - 100-character chunks at a 2600-2900 character draft: 43-84 ms per chunk
    (0.43-0.84 ms per character).
  - 500-character chunks at a 2900-3837 character draft: 1565-1656 ms per chunk
    (3.1-3.3 ms per character), close to the plain-EditText baseline above.
  - Conclusion: the prompt's per-keystroke JavaScript cost is small at these lengths. Typing
    alone did not reproduce the reported multi-minute freeze, and no per-change cost that
    grows with the draft showed up in this range.
- `dumpsys gfxinfo` during typing reports a janky-frame share above 90% with a 65 ms median
  frame on this emulator, while the host load average was 4-14. Frame statistics from this VM
  are not usable as evidence; take them on a quiet VM.
- One instrumented run (`typing.py`) typed 500-character chunks but only part of each chunk
  landed in the field (221, 486, 737 of 500 per chunk), so its wall times are not evidence.

### The per-character cost rises with the draft's length (decisive)

Same screen, same 100-character chunks, device-side timing, one run
(`app-100x20`; `before=3837` is the draft length the run started from):

| draft (chars) | chunk device time | per character |
|---:|---:|---:|
| ~2600-2900 | 43-84 ms | 0.43-0.84 ms |
| ~3900 | 194 ms | 1.9 ms |
| ~4700 | 403 ms | 4.0 ms |
| ~5400 | 605 ms | 6.1 ms |
| ~5800 | 839 ms | 8.4 ms |

The same 100 characters cost ten times more at a 5800-character draft than at a 2700-character
draft, which is a cost that grows faster than the draft. That is the reported freeze's shape:
typing degrades as the draft grows and the screen stops answering well before the 100,000
character `maxLength`. The field held 5837 characters at the end of the run.

- The last dump of the run read the field before the newest chunks landed (`after=3837`), so a
  fresh dump is needed to prove the final length in the next session.


## Root-cause analysis (read-only, source-level, React Native 0.88.1)

1. RN measures the whole draft on every text change, uncached:
   `ReactTextInputTextWatcher.onTextChanged` pushes `{mostRecentEventCount, opaqueCacheId}`,
   `AndroidTextInputShadowNode::measureContent` calls `measureCachedSpannableById`, and
   `TextLayoutManager.cpp:204` calls JNI `measureText` with no cache (unlike `measure` at
   :190). Java builds a `StaticLayout` over the full text with RN's default
   `BREAK_STRATEGY_HIGH_QUALITY` (`TextAttributeProps.kt:421`).
2. `ReactEditText.updateCachedSpannable()` (`ReactEditText.kt:1150`) copies the whole draft into
   a new `SpannableStringBuilder` and re-spans it on every text change.
3. Every change copies the full text twice and ships it to JS
   (`ReactTextInputTextWatcher.beforeTextChanged` / `dispatchEvent`).
4. App level: `new-session-prompt.tsx` calls `setContentHeight` on every native content-size
   report and the card is not memoized, so toolbar, attachment strip, controls and voice
   surface re-render once per reported line growth. The session chat composer drops reports
   that cannot move the published height (`use-text-height.tsx` `setNativeContentHeight`).
5. `defaultValue={initialPrompt}` copies and diffs the draft on every host commit
   (`BaseTextInputProps.h` holds `std::string text`).
6. JavaScript walks are O(1) for ordinary drafts: `hasVisibleText` returns on the first
   visible code point (measured 0.002 ms on 6000 characters), and `saveDraft` only resets a
   timer (serialization is debounced).
7. `scrollEnabled` is an iOS-only prop in RN 0.88; Android drops it, so the prompt's scroll
   gate has no Android effect today.

## Candidate fix (not started)

Set `textBreakStrategy="simple"` on the prompt input, drop content-size reports that cannot
move the scroll gate, and seed `defaultValue` once per mount. Keep `maxLength` (100,000), the
counter, paste truncation, draft restore, voice insert, share prefill and Start gating.

## Next steps

1. Reproduce the reported freeze: set a ~6000-character draft in one fill/paste on a quiet VM,
   then time `uiautomator dump` and check whether the screen reaches idle.
2. Apply the candidate fix and compare base and head with `ondevice.py` at equal draft lengths.
3. Run the design gate prepared pair, upload it, open the pull request.

## Harness in this directory

- `ondevice.py <label> <chunk> <chunks>` — device-side per-chunk timing plus gfxinfo summary.
- `typing.py <label> <chunk> <chunks>` — host-driven typing with a field-length check per chunk.
- `chunks.py`, `calibrate.py` — earlier variants, kept for reference.
- `signin.py` — fake-account sign-in through the device-code flow.
- `*.txt` — the measurements quoted above.

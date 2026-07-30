# mobile-android: RenameModal autofocus raises the IME — taps at keyboard height type into the field

Symptom: backdrop taps meant to dismiss `RenameModal` do nothing, and the name
field gains stray characters ("bbbb").

Cause: `RenameModal` focuses its field 100ms after mount on Android, raising
the soft keyboard over the bottom half of the screen. Taps at keyboard height
hit IME keys and type into the focused field. The first tap outside the field
may only hide the IME (standard Android behavior) instead of reaching the
modal's backdrop Pressable.

Fix (flow notes):
- To dismiss the modal via backdrop: tap the strip between the dialog bottom
  and the keyboard top (e.g. (800, 740) on the tablet AVD) — this usually
  hides the IME first — then tap the now-exposed backdrop (e.g. (1280, 900)).
  Two taps, assert after each.
- Simpler and deterministic: `driver.back()` — closed both the action sheet
  and the modal in ONE press each on this build (RN Modal `onRequestClose`
  fires even with the IME open). Prefer `driver.back()` over coordinate taps
  for every dismiss-prelude.
- Always verify the field text in the hierarchy before Save; erase via
  `eraseText` (elementClear) and note UiAutomator2 returns the content-desc
  ("Session name") as the element text when the value is empty — treat that
  string as empty.
- `h.tapOn('Save')` once silently no-op'd while the keyboard was animating
  closed; an adb-coordinate tap at the button center worked. If a helper click
  leaves the modal open with no error text, re-tap by bounds.

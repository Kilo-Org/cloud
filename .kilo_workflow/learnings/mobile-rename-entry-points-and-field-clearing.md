# mobile: rename entry points — tray row has NO rename action; use history row or detail header

Symptom: an E2E flow that long-presses the "Active now" tray row to rename gets an action sheet with
only `Copy session ID` / `Cancel` — no `Rename` — and stalls waiting for it.

Cause: by design `RemoteSessionRow` (tray) offers only copy-id; `canManage`/rename exists on the
HISTORY row (`session-row.tsx`, sheet: Copy session ID / Rename / Delete session / Cancel) and on the
session-detail header (pressable title, a11y label `Rename session: <title>`, opens RenameModal).
A live session is hoisted out of history into the tray, so while it is live its only row is the
non-renameable tray row. To rename a live session on device: tray row tap → detail → tap title.

Fix (flow notes, verified on iOS 26.5 simulator):
- History row: `longPressOn: '<title>(.)*'` → tap `Rename` → native Alert.prompt: `eraseText: 40`
  then `inputText: '<new>'`, VERIFY the field value via hierarchy before tapping the alert's
  `Rename` button (this machine's inputText appends/doubles on non-empty fields; erase-first worked
  on both the native prompt and the RN RenameModal field `Session name`).
- Detail header: tap `Rename session:(.)*` → field a11y `Session name` → same erase+input+verify →
  tap `Save`. Tap target `Rename` regex is full-string: `Rename session: <title>` will not match a
  bare `Rename` pattern — the sheet option and the alert button both match `Rename` exactly.

# Android DocumentsUI picker: stale-dump tap race + reliable sonner toast capture

Two Android-emulator techniques confirmed on attach-oom-11fd (2026-07-28):

1. `uiautomator dump` bounds can describe a view the picker has already left (a tap aimed at them hit the wrong
   Recent row). Before a `pnpm dev:mobile:android adb -s <serial> shell input tap`, cross-check
   the same node's bounds with `apps/mobile/e2e/maestro.sh <serial> hierarchy` — only tap when
   both agree. Prefer Maestro flows for navigation and reserve ADB taps for the final pick when sub-second screenshot timing matters.
2. `sonner-native` toasts are catchable deterministically with a wrapped ADB tap immediately followed by burst
   screencaps at +0.5s/+1.2s/+2.2s/+3.5s (`pnpm dev:mobile:android adb -s <serial> exec-out screencap -p > f.png`). A Maestro flow's
   teardown latency (seconds) is too slow — the toast dismisses before the shell regains control. The first
   burst frame usually still shows the picker; the second (+1.2s) reliably showed the toast.
3. Files pushed with `pnpm dev:mobile:android adb -s <serial> push` to /sdcard/Download appear in the picker's Downloads root immediately, but only enter its
   Recent view after being picked once — do not rely on Recent containing a freshly pushed fixture.

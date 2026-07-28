# Android DocumentsUI picker: stale-dump tap race + reliable sonner toast capture

Two Android-emulator techniques confirmed on attach-oom-11fd (2026-07-28):

1. `uiautomator dump` bounds can describe a view the picker has already left (a tap aimed at them hit the wrong
   Recent row). Before an `adb input tap`, cross-check the same node's bounds in a fresh
   `maestro --device <serial> hierarchy` — only tap when both agree. Prefer Maestro flows for navigation and
   reserve adb taps for the final pick when sub-second screenshot timing matters.
2. `sonner-native` toasts are catchable deterministically with an adb tap immediately followed by burst
   screencaps at +0.5s/+1.2s/+2.2s/+3.5s (`adb exec-out screencap -p > f.png`). A `maestro test` flow's
   teardown latency (seconds) is too slow — the toast dismisses before the shell regains control. The first
   burst frame usually still shows the picker; the second (+1.2s) reliably showed the toast.
3. Files `adb push`ed to /sdcard/Download appear in the picker's Downloads root immediately, but only enter its
   Recent view after being picked once — do not rely on Recent containing a freshly pushed fixture.

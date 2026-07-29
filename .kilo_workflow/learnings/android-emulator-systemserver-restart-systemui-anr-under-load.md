# Android emulator SystemServer restart + SystemUI ANR deadlock under host load spikes (2026-07-28)

Observed on attach-oom-11fd r2 while 3 slots were active (host load avg spiked to ~168):

**Symptom chain:** mid-run `adb shell input tap` fails with `Broken pipe (32)` then `Can't find service: input`;
`sys.boot_completed` still reads 1; `uiautomator dump` returns `Killed` (RC=137); qemu process stays alive.
Cause: the guest's system_server restarted under memory/CPU pressure — treat those adb signatures as
"guest rebooting", poll `getprop sys.boot_completed` (bounded loop) instead of assuming an adb wedge.

**Aftermath:** SystemUI can deadlock afterwards: persistent `System UI isn't responding` ANR dialog,
`Wait` taps are no-ops, guest CPU idle (so not starvation), `dumpsys window` shows
`mCurrentFocus=... Application Not Responding: com.android.systemui`, SystemUI in S state, and a shell-user
`kill <pid>` silently does nothing (PID unchanged).

**Recovery (confirmed):** `adb root` works on the kilo AVDs (`restarting adbd as root`), then
`adb shell kill -9 <systemui-pid>`; system_server restarts SystemUI in ~20 s, the ANR dialog clears, and the
app process, adb reverse mappings, login session, and conversation state all survive. No emulator relaunch
(never consume a launch attempt for this). Afterwards Maestro, which also wedges under the load
(`maestro hierarchy` empty/timing out, `maestro test` never writing its first log line), works again.


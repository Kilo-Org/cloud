# background_process tool mangles inline ruby/perl one-liners AND shell for-loops — use a runner script

**Symptom:** `background_process start` with a pipeline containing an inline scripting one-liner
fails immediately: ruby reports `unexpected local variable or method`, perl reports
`Execution of -e aborted due to compilation errors`. A `$VAR=value; ... > "$VAR/file"` prefix also
expands empty in the redirect target (`read-only file system: /file.log`). A plain
`for i in $(seq 1 N); do ...; sleep 8; done > out.log` one-liner fails the same way:
`(eval):32: parse error near 'do'` (observed 2026-07-30, session-list-ux-19e2 iOS E2E r3).

**Cause:** The tool evaluates the command through an extra eval/quoting layer that mangles nested
quotes inside single-quoted one-liner programs, breaks variable scoping for the redirect, and
mis-parses multi-construct shell (for/do/done) on one line.

**Fix:** Write the whole pipeline (including env vars, `cd`, loops, timestamp filter, log path) as
a literal shell script file under `$SCRATCH`, and pass only the script path plus arguments to
`background_process start` (`bash "$SCRATCH/poll.sh" <arg>` worked first try). A plain
`while [ $i -lt N ]` loop inside the script file is fine. A perl per-line timestamp filter that
survives inside the script file:
`perl -ne 'printf "%02d:%02d:%02d %s", (localtime)[2,1,0], $_'`
(macOS awk has no strftime; ruby/perl are preinstalled.)

Observed 2026-07-28 (docs-sync-cli-47f4 repro) and 2026-07-30 (session-list-ux-19e2 iOS E2E r3,
for-loop variant) on this harness (zsh, macOS).

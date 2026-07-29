# background_process tool mangles inline ruby/perl one-liners — use a runner script

**Symptom:** `background_process start` with a pipeline containing an inline scripting one-liner
fails immediately: ruby reports `unexpected local variable or method`, perl reports
`Execution of -e aborted due to compilation errors`. A `$VAR=value; ... > "$VAR/file"` prefix also
expands empty in the redirect target (`read-only file system: /file.log`).

**Cause:** The tool evaluates the command through an extra eval/quoting layer that mangles nested
quotes inside single-quoted one-liner programs and breaks variable scoping for the redirect.

**Fix:** Write the whole pipeline (including env vars, `cd`, timestamp filter, log path) as a
literal shell script file under `$SCRATCH`, `chmod +x` it, and pass only the script path plus
arguments to `background_process start`. That worked first try. A perl per-line timestamp filter
that survives inside the script file:
`perl -ne 'printf "%02d:%02d:%02d %s", (localtime)[2,1,0], $_'`
(macOS awk has no strftime; ruby/perl are preinstalled.)

Observed 2026-07-28 on this harness (zsh, macOS) during the docs-sync-cli-47f4 repro.

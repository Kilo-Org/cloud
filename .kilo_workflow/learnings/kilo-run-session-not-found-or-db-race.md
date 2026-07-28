# kilo run fails at startup: "Session not found" or EffectDrizzleQueryError

Symptom: `kilo run` dies immediately with `Session not found` or `EffectDrizzleQueryError` (local store write race) before doing any work.

Cause: two distinct startup failures. (1) When many CLIs launch concurrently (a fleet of role agents), the local SQLite store races on first write — transient. (2) On macOS, @kilocode/cli 7.4.13–7.4.15 had a fresh-database `Session not found` bug (reproduced with isolated XDG dirs); also triggered when the run inherits a parent kilo's `KILO_*` env — see `nested-kilo-run-env-poisoning.md`.

Fix: re-dispatch the identical command once — the race case starts cleanly on retry. If it persists: strip the env per the nested-run learning, and check the CLI version against the known-bad range.

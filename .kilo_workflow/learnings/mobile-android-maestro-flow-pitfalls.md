# mobile-android-maestro-flow-pitfalls

Symptom: a Maestro iteration flow on Android fails or hangs in ways the exit
code does not reveal.

Cause/fix (three independent traps, all hit in the hermes-mem baseline round):
1. `maestro test` exits 0 even when a flow assertion FAILED (observed on
   maestro 2.7.0, Android). Never trust the exit code; grep the log for
   `FAILED` after every run.
2. Maestro text matching is full-string regex: the Agents list search field is
   `Search sessions...` (with ellipsis), so `visible: 'Search sessions'` never
   matches. Use `Search sessions.*` (and generally re-dump and copy exact
   strings after any UI change).
3. Under parallel-workflow host load (load avg >100) a cold dev-client launch
   can sit on a blank Compose splash for 3-15 min and the emulator throws
   `Process system isn't responding` ANR dialogs. `open-app.yaml`'s 30 s wait
   is too short. A verifier temp flow needs: a 420 s launch wait, a
   `.*isn.t responding.*` → `tapOn: 'Wait'` handler after the launch wait and
   after settle, and 60-120 s waits for list/transcript asserts. `dumpsys
   meminfo` itself can hit its 10 s service timeout under load — retry it.

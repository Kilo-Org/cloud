# extension: Firefox Selenium e2e dies with `UnsupportedOperationError: newSession` under machine load

Symptom: `e2e:firefox` dies mid-run with `UnsupportedOperationError: newSession` after a varying number of passing scenarios (17, then 9), never on a product assertion.

Cause: geckodriver cannot spawn the next per-scenario Firefox instance while the machine is under heavy load (several parallel agent runs; load average >10). Sessions are created and quit per scenario, so the failure point moves with system pressure.

Fix: retry the command; do not patch product code or the harness for this. A green full run (33/33) followed on the third attempt once load dipped. Verified 2026-07-27.

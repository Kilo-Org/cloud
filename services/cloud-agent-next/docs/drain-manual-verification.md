# Sandbox drain verification — 2026-11-11

Manual runs used the real local Worker, Durable Objects, Docker sandbox, wrapper,
Kilo CLI, credential proxy, gateway, usage meter, and callback delivery. Only model
inference was deterministic (`kilo/fake-deterministic`). No deployment was performed.

| Harness | Scenario | Result | Duration |
|---|---|---|---|
| v2 `0.0.0-v2-85` | `cold-hot echo:manual-v2-final` | Cold reply and three warm turns; same container | 10.2 s |
| v2 | `drain-linked-child task:manualfg1:manualchild2` | No callback during the eight-second child hold; completed after release | 17.7 s |
| v2 | `drain-background-child background-task:manualbg2:manualchild3` | Parent replied while child was held; callback waited for release | 19.7 s |
| v2 | `queue-while-busy _` | All three messages completed; FIFO delivery | 68.8 s |
| v2 | `interrupt-mid-stream _` | Stop settled with `interrupted` | 10.9 s |
| v1 `7.8.17` | `cold-hot echo:manual-v1` | Cold reply and three warm turns; same container | 32.4 s |
| v1 | `queue-while-busy _` | All three messages completed; FIFO delivery | 70.5 s |
| v1 | `interrupt-mid-stream _` | Stop settled with `interrupted` | 10.7 s |

The v1 runs used the default image with the generated v2 configuration temporarily
moved aside. They also verified the updated sandbox setup defaults without explicit
usage-meter selection or an `E2E_FUNDED` override. The v2 configuration was restored
afterwards. Sequential runs left no sandbox primary or proxy containers behind.

## Fixes verified

- Keep the usage meter enabled; skipping it prevents compute admission.
- Seed missing compute SKUs with loopback-only synthetic prices, without overwriting
  existing rates or admission settings. Repeated seeding inserts nothing.
- Fund new local driver users by default in the sandbox setup environment.
- Read native v2 assistant snapshots in harness text/progress assertions.
- Reclaim exclusively owned sandbox families before deleting their native ownership proof.

The updated setup script was rerun successfully. Supporting checks passed: 707
E2E-harness unit tests, 170 v1 turn tests from `origin/main`, service typecheck,
service/seed lint, duplication check, ShellCheck, formatting, and `git diff --check`.

This is focused acceptance, not the entire scenario matrix or a production-timer
test. Reproduction commands are in [the E2E guide](../test/e2e/README.md#kilo-v2-drain-checks).

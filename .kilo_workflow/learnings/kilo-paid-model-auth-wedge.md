# PAID_MODEL_AUTH_REQUIRED wedges every kilo run

Symptom: every `kilo run` on a paid model (`kilo/x-ai/grok-4.5`, `kilo/moonshotai/kimi-k3`, ...) fails immediately or stalls with `PAID_MODEL_AUTH_REQUIRED`; retries and model pinning change nothing.

Cause: the kilo gateway auth for paid models has expired or was never established on this machine. No non-interactive dispatch can fix it.

Fix: a human (or an interactive session with a TTY) runs `kilo auth login` once. Do not route around it by switching to `kilo-auto/free` — it is rate-limited and prohibited by the workflow. If a run is unattended when this hits, it is a blocker report, not something to retry through.

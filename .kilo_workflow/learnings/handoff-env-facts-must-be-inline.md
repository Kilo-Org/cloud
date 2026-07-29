# Role agent wastes steps on auto-rejected .env reads

Symptom: a reviewer or verifier logs `permission requested: read (apps/mobile/.env); auto-rejecting` and burns steps retrying env files it can never read.

Cause: the secrets rule correctly blocks `.env` reads, but a handoff that cites `.env` facts invites the attempt.

Fix: state every sanitized env value inline in the handoff and tell the agent explicitly that it is not permitted to read `.env` / `.env.*` / `.dev.vars` and should treat the handoff table as authoritative.

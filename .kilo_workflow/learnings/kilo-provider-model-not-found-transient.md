# ProviderModelNotFoundError for a model that worked minutes ago — transient catalog, retry same model

Symptom: a dispatched role agent dies almost immediately with `EXITCODE=1` and no sentinel:

```
ERROR (#…): failed {
  error: { providerID: "kilo", modelID: "x-ai/grok-4.5",
           suggestions: [], modelsEmpty: false,
           _tag: "ProviderModelNotFoundError" }
}
Error: Model not found: kilo/x-ai/grok-4.5.
INFO (#…): event disconnected
```

The round is void (no verdict line). Observed 2026-07-28 on `plan-reviewer`, roughly 35 minutes
after four earlier rounds had run successfully on the same pinned model.

Cause: a transient degraded model catalog on the gateway, **not** a retired model. The tell is
`modelsEmpty: false` together with `suggestions: []` — the catalog responded and contained
models, just not this one. A genuinely removed model would not come back on its own; this does.

Fix: discard the void round and redispatch on the **same** model. `WORKFLOW.md` forbids
substituting another model on stall or error, and this is exactly the case the rule exists for —
switching would silently change the role's assigned model and invalidate the review. A
redispatch about a minute later ran cleanly.

Before redispatching, confirm the model is actually back rather than guessing, because
`kilo/x-ai/grok-4.5` now backs **three** roles — `starter`, `orchestrator` and `e2e-verifier`.
If it were truly gone, intake, orchestration, and E2E verification would be blocked. Planning and
implementation on their own models could continue, except a defect section's repro gate — that
gate is the planner's first act and dispatches an `e2e-verifier` on `grok-4.5`, so defect planning
stalls too. Do not use an E2E verifier as an availability probe (it needs a slot bundle, stack,
and devices). Cheapest confirmation: a throwaway probe with an explicit log, or the next real
dispatch of a `grok-4.5` role (whose `$LOG` comes from `dispatch-role.sh` / `launch-interactive.sh`):

```bash
LOG=/tmp/grok-probe.log
kilo run 'ping' --model kilo/x-ai/grok-4.5 --variant high --auto >"$LOG" 2>&1
grep -c "ProviderModelNotFoundError\|Model not found" "$LOG"   # want 0
wc -l < "$LOG"; stat -f "%Sm" -t "%H:%M:%S" "$LOG"             # want growth, recent mtime
```

Escalate to an infrastructure blocker — and never a model substitution — only if repeated
redispatches keep failing with this signature, which would mean the model really is gone. Three
consecutive void rounds is the standing threshold.

Related: `kilo-run-startup-crash-transient.md` (startup crash, exit 1, credential write) and the
mid-run stream stall (exit 0, reported VOID by `await-role.sh`). All three are void rounds with
different causes; only this one is provider-side.

"""Shared driver pieces still used by the router study.

The historical census study paths were removed in the gateway cutover.
Only the pinned resources, the native input bound, and outcome
classification remain.
"""

import json
from pathlib import Path
import sqlite3

import modern_eval
import study

RESOURCES = {"step_limit": 60, "wall_seconds": 1800, "action_timeout_seconds": 180, "run_cost_limit_usd": "3", "max_output_tokens": 16384, "run_token_limit": 2 ** 63 - 1}


class NativeInputBound:
    def __init__(self):
        self.previous = None
        self.native = None

    def bound(self, messages):
        if self.previous is not None and self.native is not None and messages[:len(self.previous)] == self.previous:
            appended = messages[len(self.previous):]
            return sum(self.native) + sum(len(json.dumps(message, ensure_ascii=False).encode("utf-8")) + 512 for message in appended)
        return len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) + 4096

    def observe(self, messages, usage):
        self.previous = json.loads(json.dumps(messages))
        values = (usage.get("prompt_tokens"), usage.get("completion_tokens"))
        self.native = values if all(type(value) is int and value >= 0 for value in values) else None


def classify(ledger_out, run, result, timed_out):
    with sqlite3.connect(Path(ledger_out) / "budget.sqlite") as db:
        rows = [row for row in study.request_rows(db) if row["run"] == run]
    unknown = [row for row in rows if row["state"] == "accounted_unknown"]
    if any(row["state"] not in {"settled", "accounted_unknown"} for row in rows):
        return "transport_unknown"
    if unknown:
        return "provider_unavailable" if all(modern_eval.route_unavailable(study.load(row["receipt"])) for row in unknown) else "transport_unknown"
    if result.get("exit_status") == "ProviderRefused":
        return "provider_refused"
    if timed_out or result.get("exit_status") in {"BudgetLimited", "LimitsExceeded", "TimeExceeded"}:
        return "budget_limited"
    return "completed" if result.get("exit_status") in {"Submitted", "RepeatedFormatError"} else "infra_invalid"

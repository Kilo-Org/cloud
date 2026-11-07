
from contextlib import contextmanager, nullcontext
import copy
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shlex
import signal
import sqlite3
import subprocess
import tarfile
import time
import uuid
from decimal import Decimal, InvalidOperation
from typing import NamedTuple

import text_tariffs

os.environ["MSWEA_SILENT_STARTUP"] = "1"

HERE = Path(__file__).resolve().parent
ISOLATION = ["--rm", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=6g", "--cpus=2"]
PUBLIC_FIELDS = ("instance_id", "repo", "base_commit", "problem_statement", "image")


class BudgetLimited(RuntimeError):
    def __init__(self, message, diagnostics=None):
        super().__init__(message)
        self.diagnostics = diagnostics or {}


class ProviderRefused(RuntimeError):
    pass


def load(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def config():
    return load(HERE / "study.json")


def verify_pins():
    import minisweagent
    import swebench

    for module, key in [(minisweagent, "mini_revision"), (swebench, "swebench_revision")]:
        root = Path(module.__file__).resolve().parent
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True)
        if result.stdout.strip() != config()[key]:
            raise RuntimeError(f"Unpinned dependency: {key}")
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], check=True, capture_output=True, text=True)
        if dirty.stdout.strip():
            raise RuntimeError(f"Modified dependency: {key}")


def prepare(out):
    from datasets import load_dataset

    cfg = config()
    if (out / "panel.json").exists():
        raise RuntimeError("Panel is frozen; select a new artifact directory rather than overwrite it")
    rows = list(load_dataset(cfg["dataset"], revision=cfg["dataset_revision"], split="test"))
    families = sorted(cfg["families"], key=lambda family: digest([cfg["seed"], family]))
    selected = []
    private = []
    for index, family in enumerate(families):
        split = "discovery" if index < cfg["discovery_families"] else "validation" if index < cfg["discovery_families"] + cfg["validation_families"] else "holdout"
        candidates = sorted((row for row in rows if row["repo"] == family), key=lambda row: digest([cfg["seed"], row["instance_id"]]))
        if len(candidates) < cfg["tasks_per_family"]:
            raise RuntimeError(f"Insufficient public tasks for {family}")
        for row in candidates[:cfg["tasks_per_family"]]:
            private.append(row)
            selected.append({**{key: row[key] for key in PUBLIC_FIELDS}, "split": split, "fixture_sha256": digest(row), "created_at": row["created_at"]})
    panel = {"config_sha256": digest(cfg), "dataset_revision": cfg["dataset_revision"], "seed": cfg["seed"], "tasks": selected, "selection": "sha256(seed,family), sha256(seed,instance_id), before inference; no outcome-based replacements"}
    save(out / "panel.json", panel)
    save(out / "evaluator" / "tasks.json", private)
    os.chmod(out / "evaluator", 0o700)
    os.chmod(out / "evaluator" / "tasks.json", 0o600)
    initialize_ledger(out / "budget.sqlite")
    print(json.dumps({"panel_sha256": digest(panel), "tasks": [(r["instance_id"], r["split"]) for r in selected]}))


def amend_resources(out):
    cfg = config()
    old_cfg = {**cfg, "max_input_tokens": 32768, "run_cost_limit_usd": "1"}
    panel = load(out / "panel.json")
    plan = load(out / "execution-plan.json")
    if panel["config_sha256"] != digest(old_cfg):
        raise RuntimeError("Amendment applies only to the exact unexecuted v1 preregistration")
    with sqlite3.connect(out / "budget.sqlite") as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] or any((out / "rollouts").glob("*/result.json")):
            raise RuntimeError("Resource amendment forbidden after any study request or model outcome")
        save(out / "preregistration-v1" / "config.json", old_cfg)
        save(out / "preregistration-v1" / "panel.json", panel)
        save(out / "preregistration-v1" / "execution-plan.json", plan)
        old_panel_hash, old_plan_hash = digest(panel), digest(plan)
        panel["config_sha256"] = digest(cfg)
        plan["panel_sha256"] = digest(panel)
        save(out / "panel.json", panel)
        save(out / "execution-plan.json", plan)
        db.execute("UPDATE metadata SET value=? WHERE key='config_sha256'", (digest(cfg),))
        save(out / "resource-amendment-v1-v2.json", {"paid_calls_before_amendment": 0, "reason": "Parent-approved before inference: free transcript of six 5KB observations exceeded v1 conservative input bound at steps3-5; v2 gives every candidate98304 input bound and1.25USD/run (108x1.25=135<=140) without changing tasks, splits, order, models, step/output/global/total limits", "old_config_sha256": digest(old_cfg), "new_config_sha256": digest(cfg), "old_panel_sha256": old_panel_hash, "new_panel_sha256": digest(panel), "old_execution_plan_sha256": old_plan_hash, "new_execution_plan_sha256": digest(plan), "fixture_reuse": "Existing baseline/gold, image, audit and sanitized runtime receipts reused explicitly: task inputs/images/sanitization unchanged; no false claim of fresh grading", "reused_evidence_sha256": digest(evidence_manifest(out))})
    print(json.dumps({"config_sha256": digest(cfg), "panel_sha256": digest(panel), "execution_plan_sha256": digest(plan)}))


def execution_plan(out):
    panel, _ = check_panel(out)
    cfg = config()
    runs = []
    for split in ["discovery", "validation", "holdout"]:
        phase = []
        for task in panel["tasks"]:
            if task["split"] != split:
                continue
            for candidate in cfg["candidates"]:
                for repetition in range(2 if split == "discovery" else 1):
                    phase.append({"instance_id": task["instance_id"], "repo": task["repo"], "split": split, "candidate": candidate["label"], "model": candidate["model"], "effort": candidate["effort"], "repetition": repetition})
        runs.extend(sorted(phase, key=lambda run: digest([cfg["seed"], run])))
    plan = {"panel_sha256": digest(panel), "runs": runs}
    path = out / "execution-plan.json"
    if path.exists() and load(path) != plan:
        raise RuntimeError("Frozen execution plan changed")
    if not path.exists():
        save(path, plan)
    return plan


def exclusion_authorization(authorization, cfg):
    if not isinstance(authorization, dict) or authorization.get("authorized") is not True:
        raise RuntimeError("Exact user-authorized frontier-opus exclusion required")
    candidate = next((candidate for candidate in cfg["candidates"] if candidate["label"] == "frontier-opus"), None)
    expected = {"authorized": True, "action": "exclude-candidate", "candidate": "frontier-opus", "model": candidate["model"] if candidate else None, "reasoning_effort": candidate["effort"] if candidate else None, "user_approval": "Continue without Opus", "total_cap_usd": cfg["total_cost_limit_usd"], "new_study_cap_usd": cfg["study_cost_limit_usd"], "per_run_cap_usd": cfg["run_cost_limit_usd"]}
    if candidate is None or any(authorization.get(key) != value for key, value in expected.items()) or not authorization.get("reason"):
        raise RuntimeError("Exact user-authorized frontier-opus exclusion required")
    return candidate


def candidate_exclusion(out, cfg=None, required=False):
    cfg = config() if cfg is None else cfg
    path = Path(out) / "candidate-exclusion-v1.json"
    if not path.exists():
        if required:
            raise RuntimeError("User-authorized candidate exclusion manifest is required")
        return None
    manifest = load(path)
    if not isinstance(manifest, dict):
        raise RuntimeError("Invalid candidate exclusion manifest")
    authorization = manifest.get("authorization", {})
    candidate = exclusion_authorization(authorization, cfg)
    panel, plan = load(Path(out) / "panel.json"), load(Path(out) / "execution-plan.json")
    if type(manifest.get("version")) is not int or manifest["version"] != 1 or manifest.get("application") != "prospective-unrun-only" or manifest.get("excluded_candidates") != [candidate] or manifest.get("authorization_sha256") != digest(authorization) or manifest.get("reason") != authorization["reason"]:
        raise RuntimeError("Invalid candidate exclusion scope or authorization")
    expected = {"original_config_sha256": digest(cfg), "original_panel_sha256": digest(panel), "original_execution_plan_sha256": digest(plan)}
    if any(manifest.get(key) != value for key, value in expected.items()) or panel["config_sha256"] != digest(cfg) or plan["panel_sha256"] != digest(panel):
        raise RuntimeError("Candidate exclusion does not match the original frozen configuration/panel/plan")
    return manifest


def active_candidates(out, cfg=None):
    cfg = config() if cfg is None else cfg
    manifest = candidate_exclusion(out, cfg)
    excluded = {candidate["label"] for candidate in manifest["excluded_candidates"]} if manifest else set()
    return [candidate for candidate in cfg["candidates"] if candidate["label"] not in excluded]


def scope_digest(out, cfg=None):
    manifest = candidate_exclusion(out, cfg)
    return digest(manifest) if manifest else None


def next_execution_row(out, plan, cfg=None):
    active = {candidate["label"] for candidate in active_candidates(out, cfg)}
    return next((row for row in plan["runs"] if row["candidate"] in active and not (Path(out) / "rollouts" / f"{row['instance_id']}--{row['candidate']}--{row['repetition']}" / "result.json").exists()), None)


def exclude_candidate(out, approval_path):
    cfg = config()
    authorization = load(approval_path)
    candidate = exclusion_authorization(authorization, cfg)
    path = out / "candidate-exclusion-v1.json"
    with (out / ".writer.lock").open("a") as lock, sqlite3.connect(out / "budget.sqlite") as db:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.exists():
            raise RuntimeError("Versioned candidate exclusion already exists; never overwrite it")
        rows = assert_ledger_ready(db)
        panel, plan = check_panel(out)[0], execution_plan(out)
        archive = out / "candidate-exclusion-v1" / "prior"
        if not (archive / "budget.sqlite").is_file():
            raise RuntimeError("Immutable pre-exclusion archive is required")
        with sqlite3.connect(archive / "budget.sqlite") as prior:
            if request_rows(prior) != rows:
                raise RuntimeError("Exclusion requires a consistent immutable pre-cutover ledger archive")
        completed = {str(file.relative_to(out)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted((out / "rollouts").glob("*/result.json"))}
        archived_files = {str(file.relative_to(archive)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(archive.rglob("*")) if file.is_file()}
        manifest = {"version": 1, "application": "prospective-unrun-only", "excluded_candidates": [candidate], "authorization": authorization, "authorization_sha256": digest(authorization), "original_config_sha256": digest(cfg), "original_panel_sha256": digest(panel), "original_execution_plan_sha256": digest(plan), "reason": authorization["reason"], "quality_scope": "Provider refusal exclusion, not cognitive failure; historical outcomes and all costs/unknown holds remain recorded", "cutover": {"request_count": len(rows), "ledger_rows_sha256": digest(rows), "completed_results_sha256": completed}, "archived_files_sha256": archived_files}
        save(path, manifest)
        candidate_exclusion(out, cfg, required=True)
    print(json.dumps({"exclusion_manifest_sha256": digest(manifest), "active_candidates": [item["label"] for item in active_candidates(out)], "request_count": len(rows), "terminal_results": len(completed)}))


def initialize_ledger(path):
    cfg = config()
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, run TEXT NOT NULL, bound TEXT NOT NULL, actual TEXT, tokens INTEGER, state TEXT NOT NULL, receipt TEXT NOT NULL)")
        if "token_bound" not in {column[1] for column in db.execute("PRAGMA table_info(requests)")}:
            db.execute("ALTER TABLE requests ADD COLUMN token_bound INTEGER")
        values = {"config_sha256": digest(cfg), "prior_committed_usd": cfg["prior_committed_usd"], "prior_unknown_bound_usd": cfg["prior_unknown_bound_usd"], "prior_unknown_included": "true", "study_cap_usd": cfg["study_cost_limit_usd"], "total_cap_usd": cfg["total_cost_limit_usd"]}
        for key, value in values.items():
            db.execute("INSERT OR IGNORE INTO metadata VALUES (?, ?)", (key, value))
            if db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()[0] != value:
                raise RuntimeError("Budget ledger/config mismatch")


UNKNOWN_POLICY = "hold-full-bound-abort-failed-run-v1"


def request_rows(db):
    cursor = db.execute("SELECT * FROM requests ORDER BY id")
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor]


def held_cost(row):
    bound = Decimal(row["bound"])
    actual = Decimal(row["actual"]) if row["actual"] is not None else None
    if not bound.is_finite() or bound < 0 or actual is not None and (not actual.is_finite() or actual < 0):
        raise RuntimeError("Invalid ledger money; inference stopped")
    if row["state"] == "settled":
        if actual is None or actual > bound:
            raise RuntimeError("Settled cost missing or over bound; inference stopped")
        return actual
    return max(bound, actual) if actual is not None else bound


def accounting_enabled(db):
    row = db.execute("SELECT value FROM metadata WHERE key='unknown_accounting_policy'").fetchone()
    return row is not None and row[0] == UNKNOWN_POLICY


def assert_ledger_ready(db, run=None):
    rows = request_rows(db)
    enabled = accounting_enabled(db)
    for row in rows:
        if run == row["run"] and row["state"] in {"unknown", "accounted_unknown", "breach"}:
            raise RuntimeError("Unsettled/unknown failed run may never dispatch again")
        held_cost(row)
        if row["state"] == "settled":
            continue
        if row["state"] != "accounted_unknown" or not enabled:
            raise RuntimeError("Unsettled/unknown, in-flight or breached request: inference stopped")
        if Decimal(row["bound"]) <= 0 or held_cost(row) > Decimal(row["bound"]) or type(row.get("token_bound")) is not int or row["token_bound"] <= 0:
            raise RuntimeError("Accounted unknown lacks its full money/token hold")
        audit = db.execute("SELECT new_row FROM accounting_audit WHERE request_id=? ORDER BY created_at DESC, id DESC LIMIT 1", (row["id"],)).fetchone()
        if audit is None or json.loads(audit[0]) != row:
            raise RuntimeError("Accounted unknown does not match immutable accounting audit")
    return rows


def create_accounting_audit(db):
    db.execute("CREATE TABLE IF NOT EXISTS accounting_audit (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, created_at REAL NOT NULL, authorization_sha256 TEXT NOT NULL, old_row TEXT NOT NULL, new_row TEXT NOT NULL)")
    db.execute("CREATE TRIGGER IF NOT EXISTS accounting_audit_no_update BEFORE UPDATE ON accounting_audit BEGIN SELECT RAISE(ABORT, 'accounting audit is append-only'); END")
    db.execute("CREATE TRIGGER IF NOT EXISTS accounting_audit_no_delete BEFORE DELETE ON accounting_audit BEGIN SELECT RAISE(ABORT, 'accounting audit is append-only'); END")


def record_accounting(db, old_row, new_row, authorization_hash):
    db.execute("INSERT INTO accounting_audit VALUES (?, ?, ?, ?, ?, ?)", (uuid.uuid4().hex, old_row["id"], time.time(), authorization_hash, json.dumps(old_row, sort_keys=True), json.dumps(new_row, sort_keys=True)))


def account_unknowns(out, approval_path):
    approval = load(approval_path)
    cfg = config()
    required = {"authorized": True, "action": "hold-unknown-bounds", "total_cap_usd": cfg["total_cost_limit_usd"], "prior_committed_including_unknown_usd": cfg["prior_committed_usd"], "new_study_cap_usd": cfg["study_cost_limit_usd"], "per_run_cap_usd": cfg["run_cost_limit_usd"]}
    if any(approval.get(key) != value for key, value in required.items()):
        raise RuntimeError("Exact user-authorized accounting-only approval required")
    archive = out / "accounting-amendment-v3" / "prior-v2"
    if not (archive / "budget.sqlite").is_file():
        raise RuntimeError("Consistent pre-amendment ledger archive required")
    archived_approval = load(archive / "approval.json")
    archived_source_hash = hashlib.sha256((archive / "source" / "study.py").read_bytes()).hexdigest()
    if archived_source_hash != archived_approval["code_sha256"] or load(archive / "source" / "study.json") != cfg:
        raise RuntimeError("Archived source/config do not match the prior approved version")
    with sqlite3.connect(archive / "budget.sqlite") as archived:
        archived_rows = request_rows(archived)
    with (out / ".writer.lock").open("a") as lock, sqlite3.connect(out / "budget.sqlite") as db:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db.execute("BEGIN IMMEDIATE")
        before = request_rows(db)
        expected_metadata = {"config_sha256": digest(cfg), "prior_committed_usd": cfg["prior_committed_usd"], "prior_unknown_bound_usd": cfg["prior_unknown_bound_usd"], "study_cap_usd": cfg["study_cost_limit_usd"], "total_cap_usd": cfg["total_cost_limit_usd"]}
        metadata = dict(db.execute("SELECT key,value FROM metadata"))
        if any(metadata.get(key) != value for key, value in expected_metadata.items()):
            raise RuntimeError("Accounting amendment may not alter financial/configuration baselines")
        unknown = [row for row in before if row["state"] == "unknown"]
        if before != archived_rows or len(before) != approval["expected_request_count"] or sorted(row["id"] for row in unknown) != sorted(approval["expected_unknown_ids"]) or any(row["state"] not in {"settled", "unknown"} for row in before):
            raise RuntimeError("Accounting amendment requires the exact archived ledger and unknown IDs")
        if "token_bound" not in {column[1] for column in db.execute("PRAGMA table_info(requests)")}:
            db.execute("ALTER TABLE requests ADD COLUMN token_bound INTEGER")
        create_accounting_audit(db)
        changes = []
        authorization_hash = digest(approval)
        for old_row in unknown:
            receipt = load(old_row["receipt"])
            if receipt["local_request_id"] != old_row["id"] or receipt["run"] != old_row["run"] or held_cost(old_row) > Decimal(receipt["reservation_usd"]):
                raise RuntimeError("Unknown identity/reservation mismatch or known over-bound charge")
            input_tokens, output_tokens = receipt["input_token_bound"], receipt["request"]["max_tokens"]
            if type(input_tokens) is not int or type(output_tokens) is not int or input_tokens <= 0 or output_tokens != cfg["max_output_tokens"]:
                raise RuntimeError("Unknown conservative token bound missing")
            token_bound = input_tokens + output_tokens
            new_row = {**old_row, "state": "accounted_unknown", "bound": str(held_cost(old_row)), "token_bound": token_bound}
            db.execute("UPDATE requests SET state=?, bound=?, token_bound=? WHERE id=? AND state='unknown'", (new_row["state"], new_row["bound"], token_bound, old_row["id"]))
            record_accounting(db, old_row, new_row, authorization_hash)
            changes.append({"original": old_row, "new": new_row, "receipt_sha256": hashlib.sha256(Path(old_row["receipt"]).read_bytes()).hexdigest()})
        db.execute("INSERT INTO metadata VALUES ('unknown_accounting_policy', ?)", (UNKNOWN_POLICY,))
        db.execute("INSERT INTO metadata VALUES ('unknown_accounting_authorization_sha256', ?)", (authorization_hash,))
        after = assert_ledger_ready(db)
        archived_files = {str(path.relative_to(archive)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(archive.rglob("*")) if path.is_file()}
        amendment = {"policy": UNKNOWN_POLICY, "authorization": approval, "authorization_sha256": authorization_hash, "prior_source_sha256": archived_source_hash, "archived_files_sha256": archived_files, "before_rows_sha256": digest(before), "after_rows_sha256": digest(after), "request_count": len(after), "changed_rows": changes, "known_settled_usd": str(sum((held_cost(row) for row in after if row["state"] == "settled"), Decimal(0))), "retained_unknown_usd": str(sum((held_cost(row) for row in after if row["state"] == "accounted_unknown"), Decimal(0)))}
        db.execute("INSERT INTO metadata VALUES ('accounting_amendment_v3', ?)", (json.dumps(amendment, sort_keys=True),))
    save(out / "accounting-amendment-v3" / "amendment.json", amendment)
    print(json.dumps(amendment))


def reserve(out, run, bound, token_bound, *, cfg=None, ledger_out=None):
    cfg = config() if cfg is None else cfg
    ledger_out = Path(out if ledger_out is None else ledger_out)
    if not (ledger_out / "budget.sqlite").is_file():
        raise RuntimeError("An existing authoritative budget ledger is required")
    request_id = uuid.uuid4().hex
    with sqlite3.connect(ledger_out / "budget.sqlite", isolation_level=None) as db:
        db.execute("BEGIN IMMEDIATE")
        rows = assert_ledger_ready(db, run)
        if "experiment_id" in cfg and not run.startswith(cfg["experiment_id"] + "--"):
            raise RuntimeError("Calibration requests require a new experiment-prefixed run identity")
        spent = sum((held_cost(row) for row in rows), Decimal(0))
        run_spent = sum((held_cost(row) for row in rows if row["run"] == run), Decimal(0))
        tokens = sum((row["tokens"] if row["state"] == "settled" else row["token_bound"]) or 0 for row in rows if row["run"] == run)
        if ledger_out != Path(out):
            metadata = dict(db.execute("SELECT key,value FROM metadata"))
            for key, cfg_key in [("prior_committed_usd", "prior_committed_usd"), ("study_cap_usd", "study_cost_limit_usd"), ("total_cap_usd", "total_cost_limit_usd"), ("prior_unknown_bound_usd", "prior_unknown_bound_usd")]:
                if metadata.get(key) != cfg[cfg_key]:
                    raise RuntimeError("Shared ledger financial baseline mismatch")
            if metadata.get("config_sha256") != digest(config()):
                raise RuntimeError("Shared ledger original configuration mismatch")
        caps = []
        if spent + bound > Decimal(cfg["study_cost_limit_usd"]):
            caps.append("study_money_reservation")
        if Decimal(cfg["prior_committed_usd"]) + spent + bound > Decimal(cfg["total_cost_limit_usd"]):
            caps.append("aggregate_money_reservation")
        if run_spent + bound > Decimal(cfg["run_cost_limit_usd"]):
            caps.append("run_money_reservation")
        if tokens + token_bound > cfg["run_token_limit"]:
            caps.append("run_token_reservation")
        experiment_spent = None
        if "experiment_id" in cfg:
            experiment_spent = sum((held_cost(row) for row in rows if row["run"].startswith(cfg["experiment_id"] + "--")), Decimal(0))
            if experiment_spent + bound > Decimal(cfg["experiment_cost_limit_usd"]):
                caps.append("experiment_money_reservation")
        if caps:
            raise BudgetLimited("BudgetLimited: reservation exceeds global, study, run, or token cap", {"caps": caps, "study_settled_plus_held_usd": str(spent), "prior_committed_usd": cfg["prior_committed_usd"], "run_settled_plus_held_usd": str(run_spent), "experiment_settled_plus_held_usd": str(experiment_spent) if experiment_spent is not None else None, "run_settled_plus_held_tokens": tokens, "next_money_bound_usd": str(bound), "next_token_bound": token_bound})
        receipt = str(out / "receipts" / f"{request_id}.json")
        db.execute("INSERT INTO requests (id, run, bound, actual, tokens, state, receipt, token_bound) VALUES (?, ?, ?, NULL, NULL, 'reserved', ?, ?)", (request_id, run, str(bound), receipt, token_bound))
        db.execute("COMMIT")
    return request_id, Path(receipt)


def rate(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise RuntimeError("Invalid numeric API rate")
    try:
        result = Decimal(str(value))
    except InvalidOperation as error:
        raise RuntimeError("Invalid numeric API rate") from error
    if not result.is_finite() or result < 0:
        raise RuntimeError("Invalid numeric API rate")
    return result


def base_prices(pricing):
    return rate(pricing["prompt"]), rate(pricing["completion"])


def routing_number(per_token):
    return text_tariffs.routing_number(per_token)


def effective_prices(pricing):
    """Legacy listing helper for obsolete callers; never a full-charge bound.

    New paid execution uses endpoint_ceiling/text_tariffs only. This keeps
    the old prompt-side maximum shape so unmigrated listing checks fail or
    pass on tariff validity, not on a silently different interpretation.
    """
    parsed, _ = text_tariffs.parse_pricing(pricing)
    maxima = text_tariffs.component_maxima(parsed)
    prompt = max(maxima.get(key, Decimal(0)) for key in ("prompt", "input_cache_read", "input_cache_write", "input_cache_write_1h"))
    completion = maxima.get("completion", Decimal(0))
    if prompt <= 0 or completion <= 0:
        raise RuntimeError("Require explicit positive token pricing")
    return prompt, completion


FINANCIAL_QUOTE_POLICY = text_tariffs.FINANCIAL_QUOTE_POLICY


def endpoint_ceiling(endpoints, cfg):
    """Complete text-only quote. cfg must carry the per-candidate identity.

    Required cfg keys: max_input_tokens, max_output_tokens,
    byok_fee_ceiling_fraction, candidate {model, effort} (or model/effort),
    and variant_catalog (loaded dict) for variant= labels. Optional:
    model_architecture (raw listing architecture for modality evidence),
    routing_context, account_policy. Unchecked bound overrides reject.
    """
    return text_tariffs.endpoint_quote(endpoints, cfg)


def financial_prices(candidate):
    """Validate a complete quote; returns (upstream_bound, attempt_bound).

    These are per-attempt charge bounds in USD, not per-token prices. The
    old token-only pair no longer exists and must not be used as a charge.
    """
    quote = text_tariffs.validate_quote(candidate)
    return Decimal(quote["upstream_bound_usd"]), Decimal(quote["attempt_bound_usd"])


def routing_max_price(candidate):
    quote = text_tariffs.validate_quote(candidate)
    calculated = {"prompt": routing_number(quote["routing_prompt_per_token"]), "completion": routing_number(quote["routing_completion_per_token"])}
    if calculated != quote["routing_max_price"]:
        raise RuntimeError("Serialized routing caps do not match the exact paired witness")
    return calculated


def catalog(out, *, cfg=None):
    import requests
    cfg = config() if cfg is None else cfg

    if not os.environ.get("OPENROUTER_API_KEY"):
        raise RuntimeError("Authenticated direct catalog requires host-only OPENROUTER_API_KEY")
    headers = {"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"}
    authentication = requests.get("https://openrouter.ai/api/v1/auth/key", headers=headers, timeout=60, allow_redirects=False)
    authentication.raise_for_status()
    account = authentication.json()["data"]
    save(out / "auth-check.json", {"checked_at": time.time(), "http_status": authentication.status_code, "is_free_tier": account.get("is_free_tier"), "limit_remaining": account.get("limit_remaining"), "note": "GET only; no inference, key, or account label retained"})
    response = requests.get("https://openrouter.ai/api/v1/models", headers=headers, timeout=60, allow_redirects=False)
    response.raise_for_status()
    data = response.json()
    models = {model["id"]: model for model in data["data"]}
    chosen = []
    endpoint_snapshots = {}
    for candidate in cfg["candidates"]:
        model = models.get(candidate["model"])
        if model is None:
            raise RuntimeError(f"Unavailable exact model ID: {candidate['model']}")
        # The model listing is preserved verbatim as evidence only. It is not
        # interpreted as a tariff ceiling; endpoint evidence decides quoting.
        pricing = model["pricing"]
        if ":" in candidate["model"]:
            raise RuntimeError("Model routing variants/plugins are not allowed")
        endpoint_url = f"https://openrouter.ai/api/v1/models/{candidate['model']}/endpoints"
        endpoint_response = requests.get(endpoint_url, headers=headers, timeout=60, allow_redirects=False)
        endpoint_response.raise_for_status()
        endpoint_body = endpoint_response.json()
        if endpoint_body["data"]["id"] != candidate["model"]:
            raise RuntimeError("Endpoint quote model identity mismatch")
        snapshot_hash = digest(endpoint_body)
        snapshot = {"source": endpoint_url, "fetched_at": time.time(), "body_sha256": snapshot_hash, "body": endpoint_body}
        save(out / "pricing-endpoints" / f"{snapshot_hash}.json", snapshot)
        quote = {**endpoint_ceiling(endpoint_body["data"]["endpoints"], {**cfg, "candidate": candidate, "model_architecture": model.get("architecture")}), "endpoint_snapshot_sha256": snapshot_hash, "source": endpoint_url}
        chosen.append({**candidate, "pricing": pricing, "context_length": model["context_length"], "supported_parameters": model["supported_parameters"], "model_architecture": model.get("architecture"), "financial_quote": quote, "quote_fetched_at": snapshot["fetched_at"]})
        endpoint_snapshots[candidate["model"]] = snapshot_hash
    new_pricing = {"fetched_at": time.time(), "source": "https://openrouter.ai/api/v1/models", "models": chosen, "financial_quote_policy": FINANCIAL_QUOTE_POLICY}
    previous_path = out / "pricing.json"
    if previous_path.exists():
        previous = load(previous_path)
        save(out / "pricing-snapshots" / f"{digest(previous)}.json", previous)
        prior_archive = out / "pricing-amendment-v5" / "prior"
        if prior_archive.exists() and not (out / "pricing-amendment-v5" / "amendment.json").exists():
            save(out / "pricing-amendment-v5" / "amendment.json", {"policy": FINANCIAL_QUOTE_POLICY, "old_pricing_sha256": digest(previous), "new_pricing_sha256": digest(new_pricing), "endpoint_snapshot_sha256": endpoint_snapshots, "application": "Prospective unrun frozen-plan rows only; all24 prior outcomes/holds unchanged; no rejected-row retry; v4 full-universe financial caps were NOT paid-cleared or used", "advertised_prices": "Preserved verbatim; current single-endpoint paired BASE tariff is routing cap, financial max covers ALL base/cache/tier fees over selector closure intersect BOTH base caps", "privacy": "Eligibility unproven by metadata; deny/require_parameters/no-fallback unchanged", "archived_files_sha256": {str(path.relative_to(prior_archive)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(prior_archive.rglob("*")) if path.is_file()}})
    save(previous_path, new_pricing)


def check_panel(out):
    panel = load(out / "panel.json")
    if panel["config_sha256"] != digest(config()):
        raise RuntimeError("Configuration changed after task freeze")
    private = load(out / "evaluator" / "tasks.json")
    if {r["instance_id"]: digest(r) for r in private} != {r["instance_id"]: r["fixture_sha256"] for r in panel["tasks"]}:
        raise RuntimeError("Evaluator tasks changed after freeze")
    return panel, private


def blackhole_network(container):
    container.reload()
    pid = str(container.attrs["State"]["Pid"])
    for command in [["ip", "route", "add", "default", "dev", "lo"], ["iptables", "-A", "OUTPUT", "!", "-d", "127.0.0.0/8", "-j", "DROP"]]:
        subprocess.run(["sudo", "nsenter", "-t", pid, "-n", *command], check=True, capture_output=True)
    proof = {}
    for key, command in [("routes", ["ip", "-j", "route"]), ("interfaces", ["ip", "-j", "addr"]), ("output_filter", ["iptables", "-S", "OUTPUT"])]:
        proof[key] = subprocess.run(["sudo", "nsenter", "-t", pid, "-n", *command], check=True, capture_output=True, text=True).stdout
    if any(interface["ifname"] != "lo" for interface in json.loads(proof["interfaces"])):
        raise RuntimeError("An external network interface exists in isolated namespace")
    proof["external_egress"] = "No external interface; non-loopback destinations DROP, enabling real connect timeouts without network access"
    return proof


def isolated_create_container(test_spec, client, run_id, logger):
    container = client.containers.create(image=test_spec.image, name=f"repo-eval-{uuid.uuid4().hex}", user="root", detach=True, command="sleep 1800", network_mode="none", cap_drop=["ALL"], security_opt=["no-new-privileges"], pids_limit=256, mem_limit="6g", nano_cpus=2000000000)
    inspect = container.attrs
    proof = {"container_id": container.id, "image": inspect["Image"], "requested_image": test_spec.image, "network": inspect["HostConfig"]["NetworkMode"], "mounts": inspect["Mounts"], "cap_drop": inspect["HostConfig"]["CapDrop"], "security_opt": inspect["HostConfig"]["SecurityOpt"]}
    save(Path(logger.log_file).parent / "isolation.json", proof)
    if proof["network"] != "none" or proof["mounts"] or proof["cap_drop"] != ["ALL"] or proof["image"] != test_spec.image:
        container.remove(force=True)
        raise RuntimeError("Actual evaluator isolation differs from pinned contract")
    original_start = container.start
    def start_isolated():
        original_start()
        proof.update(blackhole_network(container))
        save(Path(logger.log_file).parent / "isolation.json", proof)
    container.start = start_isolated
    return container


def copy_evaluator_file(container, source, destination):
    destination = Path(destination)
    payload = Path(source).read_bytes()
    archive_bytes = io.BytesIO()
    with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
        entry = tarfile.TarInfo(destination.name)
        entry.uid = entry.gid = 0
        entry.uname = entry.gname = "root"
        entry.mode = 0o600
        entry.size = len(payload)
        archive.addfile(entry, io.BytesIO(payload))
    created = container.exec_run(["mkdir", "-p", str(destination.parent)], user="root")
    if created.exit_code != 0 or not container.put_archive(str(destination.parent), archive_bytes.getvalue()):
        raise RuntimeError("Cannot copy private evaluator input into the isolated container")


def repair_images(out):
    import docker
    import requests

    task_id = "pylint-dev__pylint-4661"
    path = out / "images" / f"{task_id}.json"
    record = load(path)
    if record.get("offline_dependency_repair"):
        return
    metadata = requests.get("https://pypi.org/pypi/appdirs/1.4.4/json", timeout=60).json()
    wheel = next(file for file in metadata["urls"] if file["filename"].endswith("py2.py3-none-any.whl"))
    response = requests.get(wheel["url"], timeout=60)
    response.raise_for_status()
    if hashlib.sha256(response.content).hexdigest() != wheel["digests"]["sha256"]:
        raise RuntimeError("Public pinned dependency wheel digest mismatch")
    directory = out / "infrastructure" / "appdirs-1.4.4"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / wheel["filename"]).write_bytes(response.content)
    recipe = f"FROM {record['repo_digests'][0]}\nCOPY {wheel['filename']} /study-deps/{wheel['filename']}\nRUN /opt/miniconda3/envs/testbed/bin/python -m pip install --no-index --no-deps /study-deps/{wheel['filename']} && rm -rf /study-deps\n"
    (directory / "Dockerfile").write_text(recipe)
    image, logs = docker.from_env(timeout=1800).images.build(path=str(directory), network_mode="none", rm=True)
    save(directory / "build.json", {"wheel_url": wheel["url"], "wheel_sha256": wheel["digests"]["sha256"], "recipe": recipe, "logs": list(logs), "derived_image_id": image.id})
    save(path, {**record, "id": image.id, "source_image_id": record["id"], "offline_dependency_repair": {"package": "appdirs", "version": "1.4.4", "wheel_sha256": wheel["digests"]["sha256"]}})


def audit_images(out):
    import docker

    _, private = check_panel(out)
    client = docker.from_env(timeout=1800)
    for task in private:
        record = load(out / "images" / f"{task['instance_id']}.json")
        container = client.containers.create(image=record["id"], command="sleep 1800", network_mode="none", cap_drop=["ALL"], security_opt=["no-new-privileges"], mem_limit="6g", nano_cpus=2000000000, pids_limit=256)
        needles = [task["patch"], task["test_patch"], task["FAIL_TO_PASS"]]
        script = """import json,os,pathlib
needles = [s.encode() for s in json.loads(NEEDLES) if isinstance(s,str) and len(s)>16]
hits=[]
scanned=0
for root,dirs,files in os.walk('/'):
    if root=='/':
        dirs[:]=[d for d in dirs if d not in {'proc','sys','dev','testbed'}]
    for name in files:
        path=pathlib.Path(root)/name
        try:
            if path.is_symlink() or not path.is_file() or path.stat().st_size>4194304:
                continue
            data=path.read_bytes()
            scanned+=1
            if any(needle in data for needle in needles) or name in {'test.patch','gold.patch','eval.sh','.git-credentials','.netrc','id_rsa','id_ed25519'}:
                hits.append(str(path))
        except (PermissionError,OSError):
            continue
print(json.dumps({'scanned_files':scanned,'forbidden_hits':hits,'scope':'regular non-symlink files <=4MiB outside /testbed and pseudo-filesystems; exact gold/test-patch/F2P payloads and credential/evaluator filenames'}))
""".replace("NEEDLES", repr(json.dumps(needles)))
        try:
            container.start()
            result = container.exec_run(["bash", "-lc", f"python -c {shlex.quote(script)}"])
            if result.exit_code != 0:
                raise RuntimeError("Image leakage audit execution failed")
            audit = json.loads(result.output.decode())
            audit.update(image_id=record["id"], instance_id=task["instance_id"])
            save(out / "image-audits" / f"{task['instance_id']}.json", audit)
            if audit["forbidden_hits"]:
                raise RuntimeError(f"Image has evaluator/credential leakage: {task['instance_id']}")
        finally:
            container.remove(force=True)


def pinned_image(client, out, task):
    path = out / "images" / f"{task['instance_id']}.json"
    if path.exists():
        return client.images.get(load(path)["id"])
    client.images.pull(task["image"])
    image = client.images.get(task["image"])
    save(path, {"image": task["image"], "id": image.id, "repo_digests": image.attrs.get("RepoDigests", [])})
    return image


def pin_images(out):
    import docker

    _, private = check_panel(out)
    client = docker.from_env(timeout=1800)
    for task in private:
        pinned_image(client, out, task)


def evaluate(out, task_id, patch=None, label="baseline"):
    import docker
    import swebench.harness.run_evaluation as harness
    from swebench.harness.utils import make_test_spec

    _, private = check_panel(out)
    task = next(row for row in private if row["instance_id"] == task_id)
    client = docker.from_env(timeout=1800)
    image = pinned_image(client, out, task)
    prediction = {"instance_id": task_id, "model_name_or_path": label, "model_patch": task["patch"] if label == "gold" else patch or ""}
    run_id = f"repo-{label}-{uuid.uuid4().hex}"
    previous_create, previous_copy = harness.create_container, harness.copy_to_container
    harness.create_container = isolated_create_container
    harness.copy_to_container = copy_evaluator_file
    previous = Path.cwd()
    os.chdir(out)
    try:
        result = harness.run_instance(make_test_spec({**task, "image": image.id}), prediction, client, run_id, timeout=900, skip_patch=not prediction["model_patch"])
    finally:
        harness.create_container, harness.copy_to_container = previous_create, previous_copy
        os.chdir(previous)
    receipt = {"run_id": run_id, "instance_id": task_id, "label": label, "result": result}
    save(out / "evaluations" / f"{run_id}.json", receipt)
    return receipt


def validate(out, ids):
    panel, _ = check_panel(out)
    selected = [task for task in panel["tasks"] if not ids or task["instance_id"] in ids]
    for task in selected:
        baseline = evaluate(out, task["instance_id"], label="baseline")
        gold = evaluate(out, task["instance_id"], label="gold")
        baseline_report = baseline["result"][1] if baseline["result"] else None
        gold_report = gold["result"][1] if gold["result"] else None
        baseline_case = baseline_report.get(task["instance_id"], {}) if baseline_report else {}
        gold_case = gold_report.get(task["instance_id"], {}) if gold_report else {}
        counts = {}
        for label, case in [("baseline", baseline_case), ("gold", gold_case)]:
            statuses = case.get("tests_status", {})
            counts[label] = {f"{kind}_{state}": len(statuses.get(kind, {}).get(state, [])) for kind in ["FAIL_TO_PASS", "PASS_TO_PASS"] for state in ["failure", "success"]}
        passed = baseline_case.get("resolved") is False and gold_case.get("resolved") is True and counts["baseline"]["FAIL_TO_PASS_failure"] > 0 and counts["baseline"]["FAIL_TO_PASS_success"] == 0 and counts["baseline"]["PASS_TO_PASS_failure"] == 0 and counts["gold"]["FAIL_TO_PASS_failure"] == 0 and counts["gold"]["PASS_TO_PASS_failure"] == 0
        save(out / "fixtures" / f"{task['instance_id']}.json", {"eligible": passed, "counts": counts, "image_id": load(out / "images" / f"{task['instance_id']}.json")["id"], "baseline": baseline, "gold": gold})
        print(json.dumps({"task": task["instance_id"], "baseline_resolved": baseline_case.get("resolved"), "gold_resolved": gold_case.get("resolved"), "eligible": passed}))


def solver_environment(task, out, *, cfg=None):
    from minisweagent.environments.docker import DockerEnvironment
    import docker

    image_record = load(out / "images" / f"{task['instance_id']}.json")
    cfg = config() if cfg is None else cfg
    env = DockerEnvironment(image=image_record["id"], cwd="/testbed", run_args=ISOLATION, timeout=cfg.get("action_timeout_seconds", 60))
    network_proof = blackhole_network(docker.from_env().containers.get(env.container_id))
    setup = env.execute({"command": f"rm -f /root/.gitconfig && git config --global --add safe.directory /testbed && git checkout --detach {shlex.quote(task['base_commit'])} && git reset --hard {shlex.quote(task['base_commit'])} && tracked=$(mktemp) && git ls-files -z > \"$tracked\" && rm -rf .git && git init -q && git add -f --pathspec-from-file=\"$tracked\" --pathspec-file-nul && rm \"$tracked\" && git write-tree && rm -f /root/.gitconfig"})
    if setup["returncode"] != 0:
        env.cleanup()
        raise RuntimeError(f"Solver snapshot setup failed: {setup['output']}")
    env.study_base_tree = setup["output"].strip().splitlines()[-1]
    if len(env.study_base_tree) != 40 or any(char not in "0123456789abcdef" for char in env.study_base_tree):
        env.cleanup()
        raise RuntimeError("Could not establish commit-free base tree")

    inspect = docker.from_env().containers.get(env.container_id).attrs
    if inspect["HostConfig"]["NetworkMode"] != "none" or inspect["Mounts"] or any("KEY=" in value or "TOKEN=" in value or "SECRET=" in value for value in inspect["Config"]["Env"]):
        env.cleanup()
        raise RuntimeError("Solver isolation audit failed")
    save(out / "isolation" / f"{env.container_id}.json", {"container_id": env.container_id, "image": inspect["Image"], "network": inspect["HostConfig"]["NetworkMode"], "mounts": inspect["Mounts"], "cap_drop": inspect["HostConfig"]["CapDrop"], "security_opt": inspect["HostConfig"]["SecurityOpt"], "base_commit": task["base_commit"], "git_history_replaced": True, **network_proof})
    return env


def agent_settings(cfg=None):
    import minisweagent
    import yaml

    settings = yaml.safe_load((Path(minisweagent.__file__).parent / "config" / "default.yaml").read_text())
    cfg = config() if cfg is None else cfg
    settings["agent"].update(step_limit=cfg["step_limit"], cost_limit=0, wall_time_limit_seconds=cfg["wall_seconds"])
    settings["agent"]["instance_template"] += "\nStudy safety rules: Do not create git commits, change git configuration, set author/committer identities, fetch remote history, or seek external solutions. Work only on the provided public snapshot and issue. Gold patches, hidden evaluation patches/tests, hints and expected-test lists are unavailable and must not be sought. Submit working-tree changes without committing.\n"
    return settings


def http_request_timeout(cfg):
    value = cfg.get("http_request_timeout_seconds", 180)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("http_request_timeout_seconds must be positive and finite")
    return value


@contextmanager
def http_deadline(deadline, http_request_timeout_seconds=180):
    remaining = min(http_request_timeout({"http_request_timeout_seconds": http_request_timeout_seconds}), deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError("WallTimeLimited before HTTP dispatch")
    def abort(signum, frame):
        raise TimeoutError("WallTimeLimited total HTTP deadline")
    previous_handler = signal.signal(signal.SIGALRM, abort)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, remaining)
    try:
        yield remaining
    finally:
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        signal.signal(signal.SIGALRM, previous_handler)


def partial_generation_id(text):
    decoder = json.JSONDecoder()
    try:
        position = len(text) - len(text.lstrip())
        if text[position] != "{":
            return None
        position += 1
        while True:
            position += len(text[position:]) - len(text[position:].lstrip())
            key, position = decoder.raw_decode(text, position)
            position += len(text[position:]) - len(text[position:].lstrip())
            if text[position] != ":":
                return None
            position += 1
            position += len(text[position:]) - len(text[position:].lstrip())
            value, position = decoder.raw_decode(text, position)
            if key == "id" and isinstance(value, str) and value.startswith("gen-") and len(value) <= 256 and all(char.isalnum() or char in "-_" for char in value):
                return value
            position += len(text[position:]) - len(text[position:].lstrip())
            if text[position] != ",":
                return None
            position += 1
    except (json.JSONDecodeError, IndexError):
        return None


def _check_contract_freshness(contract):
    fetched = contract.get("quote_fetched_at")
    if isinstance(fetched, bool) or not isinstance(fetched, (int, float)) or not math.isfinite(fetched) or not 0 <= time.time() - fetched <= contract["quote_max_age_seconds"]:
        raise RuntimeError("Quote source is expired or unbound at dispatch; quote again")
    policy = contract.get("account_policy") or {}
    captured = policy.get("captured_at")
    if isinstance(captured, bool) or not isinstance(captured, (int, float)) or not math.isfinite(captured) or not 0 <= time.time() - captured <= contract["account_policy_max_age_seconds"]:
        raise RuntimeError("Account policy evidence is expired or unbound at dispatch; recapture account state")


def completion_http(payload, deadline, receipt, receipt_path, *, admission=None, contract=None, http_request_timeout_seconds=180):
    """Authoritative final guard, then exact-byte dispatch.

    Admission is mandatory and the receipt must be unused. The payload is
    validated and hash-bound before admission; quote and account-policy
    freshness are checked before admission and again after it yields,
    immediately before the receipt is marked and the exact bytes are sent.
    Rejections after admission leave dispatch_entered untouched.
    """
    if contract is None:
        raise RuntimeError("Paid dispatch requires the approved final request contract")
    if admission is None:
        raise RuntimeError("Paid dispatch requires transport admission; there is no unadmitted dispatch path")
    if receipt.get("dispatch_entered") is not False:
        raise RuntimeError("Receipt was already dispatched or is not in a reserved state; one reservation funds one dispatch")
    raw = text_tariffs.validate_final_payload(payload, contract)
    if receipt.get("request_sha256") != text_tariffs.request_bytes_sha256(raw):
        raise RuntimeError("Final request bytes do not match the receipt-bound request hash")
    _check_contract_freshness(contract)
    import requests

    with admission():
        _check_contract_freshness(contract)
        if receipt.get("dispatch_entered") is not False:
            raise RuntimeError("Receipt was already dispatched or is not in a reserved state; one reservation funds one dispatch")
        timer = http_deadline(deadline) if http_request_timeout_seconds == 180 else http_deadline(deadline, http_request_timeout_seconds)
        with timer as remaining:
            receipt["dispatch_entered"] = True
            save(receipt_path, receipt)
            response = requests.post("https://openrouter.ai/api/v1/chat/completions", headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"}, data=raw, stream=True, timeout=(min(15, remaining), remaining), allow_redirects=False)
            try:
                receipt.update(http_status=response.status_code, provider_request_id=response.headers.get("x-request-id"), openrouter_request_id=response.headers.get("x-openrouter-request-id"), provider_generation_id=response.headers.get("x-generation-id"))
                save(receipt_path, receipt)
                body = bytearray()
                for chunk in response.iter_content(chunk_size=4096):
                    body.extend(chunk)
                    if len(body) > 8388608:
                        raise RuntimeError("Response exceeds bounded text-only receipt size")
                    if not receipt.get("generation_id"):
                        generation = partial_generation_id(body[:65536].decode("utf-8", errors="replace"))
                        if generation:
                            receipt["generation_id"] = generation
                            save(receipt_path, receipt)
                return response, json.loads(body)
            finally:
                response.close()


def require_paid_callbacks(reservation, transport_admission, state_guard, input_bounder):
    if reservation is None or transport_admission is None or state_guard is None or input_bounder is None:
        raise RuntimeError("Paid queries require the campaign reservation, transport admission, state guard and input bounder; there is no legacy default reserve path")


class ChargeEvidence(NamedTuple):
    complete: bool
    actual: Decimal | None
    known_floor: Decimal
    fee_breach: bool
    billing_mode: str


def _charge_money(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        return None
    return result if result.is_finite() and result >= 0 else None


def charge_evidence(usage, fee_fraction):
    """Typed billing evidence: completeness is separate from known charges.

    Only an affirmative boolean is_byok settles either mode. Missing, null
    or non-boolean flags are ambiguous: known fee/upstream amounts still
    floor the retained liability, but nothing settles and the non-BYOK
    breakdown is never summed into its own total.
    """
    if not isinstance(usage, dict):
        return ChargeEvidence(False, None, Decimal(0), False, "missing-usage")
    cost = _charge_money(usage.get("cost"))
    details = usage.get("cost_details") if isinstance(usage.get("cost_details"), dict) else {}
    upstream = _charge_money(details.get("upstream_inference_cost"))
    flag = usage.get("is_byok")
    known = [value for value in (cost, upstream) if value is not None]
    if flag is True and cost is not None and upstream is not None:
        known.append(cost + upstream)
    floor = max(known) if known else Decimal(0)
    if flag is True:
        if cost is not None and upstream is not None:
            return ChargeEvidence(True, cost + upstream, floor, cost > fee_fraction * upstream, "byok")
        return ChargeEvidence(False, None, floor, False, "byok-incomplete")
    if flag is False:
        if cost is not None:
            return ChargeEvidence(True, cost, floor, False, "non-byok")
        return ChargeEvidence(False, None, floor, False, "non-byok-incomplete")
    return ChargeEvidence(False, None, floor, False, "ambiguous")


def build_payload(candidate, prepared_messages, contract, cfg):
    """Outbound payload with independently deep-copied approval controls."""
    return {"model": candidate["model"], "messages": prepared_messages, "max_tokens": cfg["max_output_tokens"], **copy.deepcopy(contract["resolved_variant"]), "usage": {"include": True}, "stream": False, "plugins": copy.deepcopy(contract["plugins"]), "provider": copy.deepcopy(contract["provider"])}


def _variant_catalog(cfg):
    catalog = cfg.get("variant_catalog")
    if isinstance(catalog, (str, Path)):
        return load(catalog)
    return catalog


def paid_model(out, run, candidate, deadline=None, *, cfg=None, ledger_out=None, input_bounder=None, reservation=None, transport_admission=None, state_guard=None):
    from minisweagent.exceptions import FormatError
    from minisweagent.models.openrouter_textbased_model import OpenRouterTextbasedModel
    cfg = config() if cfg is None else cfg
    request_timeout = http_request_timeout(cfg)
    overrun_policy = cfg.get("token_overrun_policy")
    if overrun_policy not in (None, "settle-known-v1"):
        raise ValueError("Unsupported token_overrun_policy")
    ledger_out = Path(out if ledger_out is None else ledger_out)
    deadline = deadline if deadline is not None else time.monotonic() + cfg["wall_seconds"]

    class ReservedOpenRouterModel(OpenRouterTextbasedModel):
        def query(self, messages, **kwargs):
            require_paid_callbacks(reservation, transport_admission, state_guard, input_bounder)
            diagnostics = {"input_token_bound": None, "native_prompt_tokens": None, "native_completion_tokens": None}
            prepared = self._prepare_messages_for_api(messages)
            input_bound = input_bounder.bound(prepared)
            diagnostics["input_token_bound"] = input_bound
            if input_bound > min(cfg["max_input_tokens"], candidate["context_length"] - cfg["max_output_tokens"]):
                diagnostics.update(caps=["input_token_bound"], configured_input_bound=cfg["max_input_tokens"], candidate_context_length=candidate["context_length"])
                save(out / "resource-limits" / run / f"{uuid.uuid4().hex}.json", diagnostics)
                raise BudgetLimited("BudgetLimited: conservative input token cap", diagnostics)
            quote = text_tariffs.validate_quote(candidate)
            routing_max_price(candidate)
            fee_fraction = rate(quote["fee_fraction"])
            if cfg.get("byok_fee_ceiling_fraction") is not None and rate(cfg["byok_fee_ceiling_fraction"]) != fee_fraction:
                raise RuntimeError("Configured BYOK fee allowance differs from the quoted fee fraction")
            amounts = text_tariffs.attempt_reservation(quote, estimated_input_tokens=input_bound)
            bound, upstream_reservation, fee_reservation = amounts["bound_usd"], amounts["upstream_usd"], amounts["fee_usd"]
            contract_cfg = {**cfg, "variant_catalog": _variant_catalog(cfg)}
            contract = text_tariffs.request_contract(candidate, contract_cfg, quote_fetched_at=candidate.get("quote_fetched_at"), quote_max_age_seconds=cfg.get("quote_max_age_seconds", 7200))
            payload = build_payload(candidate, prepared, contract, cfg)
            request_raw = text_tariffs.validate_final_payload(payload, contract)
            if time.monotonic() >= deadline:
                raise TimeoutError("WallTimeLimited before reservation")
            try:
                request_id, receipt_path = reservation(out, run, bound, input_bound + cfg["max_output_tokens"], cfg=cfg, ledger_out=ledger_out)
            except BudgetLimited as error:
                error.diagnostics.update(diagnostics)
                save(out / "resource-limits" / run / f"{uuid.uuid4().hex}.json", error.diagnostics)
                raise
            receipt = {"local_request_id": request_id, "run": run, "reservation_usd": str(bound), "upstream_reservation_usd": str(upstream_reservation), "token_reservation_usd": str(upstream_reservation), "byok_fee_ceiling_fraction": str(fee_fraction), "fee_reservation_usd": str(fee_reservation), "reservation_components": {key: str(value) if isinstance(value, Decimal) else value for key, value in amounts.items()}, "input_token_bound": input_bound, "request_sha256": text_tariffs.request_bytes_sha256(request_raw), "request": payload, "router_variant": candidate["effort"], "request_contract": contract, "financial_quote": quote, "status": "reserved", "dispatch_entered": False, "started_at": time.time()}
            save(receipt_path, receipt)
            observed_actual = None
            known_floor = Decimal(0)
            token_breach = False
            fee_breach = False
            try:
                transport_options = {"contract": contract, "admission": lambda: transport_admission(ledger_out, run, request_id, cfg)}
                if "http_request_timeout_seconds" in cfg:
                    transport_options["http_request_timeout_seconds"] = request_timeout
                response, body = completion_http(payload, deadline, receipt, receipt_path, **transport_options)
                receipt["response"] = body
                usage = body.get("usage", {})
                prompt_tokens = usage.get("prompt_tokens")
                completion_tokens = usage.get("completion_tokens")
                token_breach = any(value is not None and (type(value) is not int or value < 0 or value > upper) for value, upper in [(prompt_tokens, input_bound), (completion_tokens, cfg["max_output_tokens"])])
                evidence = charge_evidence(usage, fee_fraction)
                fee_breach, known_floor = evidence.fee_breach, evidence.known_floor
                observed_actual = evidence.actual if evidence.complete else None
                receipt["charge_evidence"] = {"complete": evidence.complete, "actual_usd": str(evidence.actual) if evidence.actual is not None else None, "known_floor_usd": str(evidence.known_floor), "fee_breach": evidence.fee_breach, "billing_mode": evidence.billing_mode}
                save(receipt_path, receipt)
                response.raise_for_status()
                if not evidence.complete:
                    raise RuntimeError("Incomplete or ambiguous provider billing evidence; known charges stay held")
                actual = evidence.actual
                counts_valid = type(prompt_tokens) is int and type(completion_tokens) is int and prompt_tokens >= 0 and completion_tokens >= 0
                token_overrun = counts_valid and (prompt_tokens > input_bound or completion_tokens > cfg["max_output_tokens"])
                money_valid = not fee_breach and actual.is_finite() and 0 <= actual <= bound
                if not money_valid or not counts_valid or token_overrun and overrun_policy != "settle-known-v1":
                    raise RuntimeError("Provider cost/token bound violation")
                with (state_guard(ledger_out) if state_guard is not None else nullcontext()), sqlite3.connect(ledger_out / "budget.sqlite") as db:
                    changed = db.execute("UPDATE requests SET actual=?, tokens=?, state='settled' WHERE id=? AND state='reserved'", (str(actual), prompt_tokens + completion_tokens, request_id)).rowcount
                    if changed != 1:
                        raise RuntimeError("Reservation changed before settlement")
            except BaseException as error:
                dispatched = receipt["dispatch_entered"]
                retained_bound = max(bound, known_floor, observed_actual if observed_actual is not None else Decimal(0))
                state = "breach" if token_breach or fee_breach or known_floor > bound or observed_actual is not None and observed_actual > bound else "unknown"
                if not dispatched:
                    retained_bound, observed_actual, state = Decimal(0), Decimal(0), "settled"
                with (state_guard(ledger_out) if state_guard is not None else nullcontext()), sqlite3.connect(ledger_out / "budget.sqlite") as db:
                    db.execute("BEGIN IMMEDIATE")
                    old_row = next(row for row in request_rows(db) if row["id"] == request_id)
                    cancelled_before_dispatch = not dispatched and old_row["state"] == "settled" and old_row["actual"] is not None and Decimal(old_row["actual"]) == 0
                    if old_row["state"] != "reserved" and not cancelled_before_dispatch:
                        raise
                    if state == "unknown" and cfg.get("allow_unknown_auto_accounting") is True and accounting_enabled(db):
                        state = "accounted_unknown"
                    db.execute("UPDATE requests SET state=?, bound=?, actual=?, tokens=? WHERE id=? AND state='reserved'", (state, str(retained_bound), str(observed_actual) if observed_actual is not None else None, 0 if not dispatched else None, request_id))
                    if state == "accounted_unknown":
                        authorization_hash = db.execute("SELECT value FROM metadata WHERE key='unknown_accounting_authorization_sha256'").fetchone()[0]
                        new_row = next(row for row in request_rows(db) if row["id"] == request_id)
                        record_accounting(db, old_row, new_row, authorization_hash)
                receipt.update(status=state if dispatched else "not_dispatched", retained_bound_usd=str(retained_bound), known_floor_usd=str(known_floor) if dispatched else "0", observed_actual_usd=str(observed_actual) if observed_actual is not None else None, error_type=type(error).__name__, finished_at=time.time())
                save(receipt_path, receipt)
                if isinstance(error, BudgetLimited):
                    error.diagnostics.update(diagnostics)
                    save(out / "resource-limits" / run / f"{uuid.uuid4().hex}.json", error.diagnostics)
                raise
            receipt.update(status="settled", actual_usd=str(actual), finished_at=time.time())
            if token_overrun:
                receipt.update(token_estimate_overrun=True, native_prompt_tokens=prompt_tokens, native_completion_tokens=completion_tokens, token_overrun_policy=overrun_policy)
            save(receipt_path, receipt)
            if input_bounder is not None:
                input_bounder.observe(prepared, usage)
            for choice in body.get("choices", []):
                if choice.get("native_finish_reason") == "refusal" or choice.get("finish_reason") == "content_filter" or (choice.get("message") or {}).get("refusal"):
                    receipt["provider_refused"] = True
                    save(receipt_path, receipt)
                    raise ProviderRefused("Provider refused the request; do not retry or request format recovery")
            if input_bounder is not None and any(choice.get("finish_reason") == "length" or choice.get("native_finish_reason") in {"max_tokens", "length"} for choice in body.get("choices", [])):
                diagnostics.update(caps=["output_token_limit"], native_prompt_tokens=prompt_tokens, native_completion_tokens=completion_tokens)
                save(out / "resource-limits" / run / f"{uuid.uuid4().hex}.json", diagnostics)
                raise BudgetLimited("BudgetLimited: per-call output cap", diagnostics)
            try:
                actions = self._parse_actions(body)
            except FormatError as error:
                error.messages[0].setdefault("extra", {}).update(cost=float(actual), response=body)
                raise
            message = dict(body["choices"][0]["message"])
            message["extra"] = {"actions": actions, "response": body, "cost": float(actual), "timestamp": time.time()}
            return message

    return ReservedOpenRouterModel(model_name=candidate["model"], **agent_settings(cfg)["model"])


def evidence_manifest(out):
    paths = [out / "smoke.json", out / "smoke-trajectory.json", out / "environment-freeze.txt"]
    for directory in ["images", "fixtures", "image-audits", "runtime-preflight"]:
        paths.extend(sorted((out / directory).glob("*.json")))
    return {str(path.relative_to(out)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def solve(out, task_id, candidate_label, repetition, approval_path):
    panel, _ = check_panel(out)
    pricing = load(out / "pricing.json")
    approval = load(approval_path)
    plan = execution_plan(out)
    if approval.get("authorized") is not True or approval.get("panel_sha256") != digest(panel) or approval.get("pricing_sha256") != digest(pricing) or approval.get("execution_plan_sha256") != digest(plan):
        raise RuntimeError("Missing parent clearance for exact frozen panel, run plan and direct pricing")
    if approval.get("code_sha256") != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
        raise RuntimeError("Parent clearance is not bound to this exact driver source")
    exclusion = candidate_exclusion(out, required=True)
    if approval.get("exclusion_manifest_sha256") != digest(exclusion):
        raise RuntimeError("Paid phase approval does not bind the authorized candidate exclusion")
    active = {candidate["label"] for candidate in active_candidates(out)}
    if candidate_label not in active:
        raise RuntimeError("Candidate is prospectively excluded by the user's authorization")
    if approval.get("evidence_sha256") != digest(evidence_manifest(out)):
        raise RuntimeError("Parent clearance is not bound to the exact images, fixtures, audits and runtime proof")
    if time.time() - pricing["fetched_at"] > 86400:
        raise RuntimeError("Pricing snapshot older than one day; refresh and obtain new parent clearance")
    if not os.environ.get("OPENROUTER_API_KEY"):
        raise RuntimeError("No OpenRouter key on host; do not put credentials in containers")
    initialize_ledger(out / "budget.sqlite")
    with sqlite3.connect(out / "budget.sqlite") as db:
        if accounting_enabled(db):
            authorization_hash = db.execute("SELECT value FROM metadata WHERE key='unknown_accounting_authorization_sha256'").fetchone()[0]
            if approval.get("accounting_authorization_sha256") != authorization_hash:
                raise RuntimeError("Paid phase approval does not bind the authorized unknown-hold policy")
    task = next(row for row in panel["tasks"] if row["instance_id"] == task_id)
    for row in panel["tasks"]:
        if not load(out / "fixtures" / f"{row['instance_id']}.json")["eligible"]:
            raise RuntimeError("All frozen panel fixtures must baseline-fail and gold-pass before inference")
        audit = load(out / "image-audits" / f"{row['instance_id']}.json")
        if audit["forbidden_hits"] or audit["image_id"] != load(out / "images" / f"{row['instance_id']}.json")["id"]:
            raise RuntimeError("All pinned images require a clean host-only leakage audit")
        runtime = load(out / "runtime-preflight" / f"{row['instance_id']}.json")
        if not runtime["valid"] or runtime["image_id"] != audit["image_id"]:
            raise RuntimeError("All sanitized solver snapshots require a working import and public test")
    if repetition not in range(2 if task["split"] == "discovery" else 1):
        raise RuntimeError("Repetition outside preregistered protocol")
    if task["split"] != "discovery" and approval.get(f"release_{task['split']}") is not True:
        raise RuntimeError("Validation/holdout require explicit staged release after discovery selection freeze")
    if task["split"] != "discovery":
        rule_key = "discovery_rule_sha256" if task["split"] == "validation" else "holdout_rule_sha256"
        rule_hash = approval.get(rule_key, "")
        if len(rule_hash) != 64 or any(char not in "0123456789abcdef" for char in rule_hash):
            raise RuntimeError("Phase release requires a previously frozen decision-rule digest")
        rule_file = out / ("discovery-rule.json" if task["split"] == "validation" else "holdout-rule.json")
        if digest(load(rule_file)) != rule_hash:
            raise RuntimeError("Phase decision-rule artifact does not match parent clearance")
        if load(rule_file).get("exclusion_manifest_sha256") != digest(exclusion):
            raise RuntimeError("Frozen phase rule does not match the authorized candidate scope")
    candidate = next(row for row in pricing["models"] if row["label"] == candidate_label)
    run = f"{task_id}--{candidate_label}--{repetition}"
    next_row = next_execution_row(out, plan)
    if next_row is None or (next_row["instance_id"], next_row["candidate"], next_row["repetition"]) != (task_id, candidate_label, repetition):
        raise RuntimeError("Only the next row of the frozen phase-ordered execution plan may run")
    return rollout(out, task, candidate, repetition, approval, run)


def rollout(out, task, candidate, repetition, approval, run, *, cfg=None, ledger_out=None, metadata_extra=None):
    from minisweagent.agents.default import DefaultAgent

    cfg = config() if cfg is None else cfg
    ledger_out = Path(out if ledger_out is None else ledger_out)
    task_id, candidate_label = task["instance_id"], candidate["label"]
    run_dir = out / "rollouts" / run
    run_dir.mkdir(parents=True, exist_ok=False)
    save(run_dir / "approval.json", approval)
    started = time.time()
    metadata = {"run": run, "instance_id": task_id, "candidate": candidate_label, "repetition": repetition, "split": task["split"], "approval_sha256": digest(approval), "code_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), **(metadata_extra or {})}
    try:
        env = solver_environment(task, out, cfg=cfg)
    except Exception as error:
        save(run_dir / "result.json", {**metadata, "elapsed_seconds": time.time() - started, "status": "infra_invalid", "result": {"exit_status": type(error).__name__, "message": str(error)}})
        save(run_dir / "evaluation.json", {"grade_valid": False, "reason": "infra_invalid"})
        raise
    deadline = time.monotonic() + cfg["wall_seconds"]
    original_execute = env.execute
    def execute_before_deadline(action, cwd="", *, timeout=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("WallTimeLimited before action execution")
        output = original_execute(action, cwd, timeout=min(timeout or env.config.timeout, cfg.get("action_timeout_seconds", 60), remaining))
        if output.get("extra", {}).get("exception_type") == "TimeoutExpired":
            raise TimeoutError("ActionTimeLimited: container command may still be running")
        return output
    env.execute = execute_before_deadline
    result = {}
    try:
        agent = DefaultAgent(paid_model(out, run, candidate, deadline, cfg=cfg, ledger_out=ledger_out), env, **agent_settings(cfg)["agent"], output_path=run_dir / "trajectory.json")
        try:
            result = agent.run(task=task["problem_statement"])
        except Exception as error:
            result = {"exit_status": type(error).__name__, "message": str(error), "resource_limit": getattr(error, "diagnostics", None)}
        with sqlite3.connect(ledger_out / "budget.sqlite") as db:
            stopped = db.execute("SELECT COUNT(*) FROM requests WHERE state NOT IN ('settled','accounted_unknown') OR (run=? AND state='accounted_unknown')", (run,)).fetchone()[0] > 0
        timed_out = result.get("exit_status") == "TimeoutError" or time.monotonic() >= deadline
        limited = timed_out or result.get("exit_status") in {"BudgetLimited", "LimitsExceeded", "TimeExceeded"}
        refused = result.get("exit_status") == "ProviderRefused"
        status = "transport_unknown" if stopped else "provider_refused" if refused else "budget_limited" if limited else "completed" if result.get("exit_status") in {"Submitted", "RepeatedFormatError"} else "infra_invalid"
        patch = None
        if not timed_out and not stopped and not refused:
            patch_result = original_execute({"command": f"git add -N . && git diff --binary {env.study_base_tree}"})
            if patch_result["returncode"] != 0:
                status = "infra_invalid"
                result = {"exit_status": "PatchCaptureError", "message": patch_result["exception_info"]}
            else:
                patch = patch_result["output"]
                (run_dir / "prediction.patch").write_text(patch)
                save(run_dir / "prediction.json", {"instance_id": task_id, "model_name_or_path": candidate_label, "model_patch": patch})
        save(run_dir / "result.json", {**metadata, "elapsed_seconds": time.time() - started, "status": status, "result": result, "resources": resource_summary(out, ledger_out, run, cfg, result, wall_exhausted=time.monotonic() >= deadline)})
    finally:
        import docker
        try:
            docker.from_env().containers.get(env.container_id).remove(force=True)
        except docker.errors.NotFound:
            pass
    evaluation = evaluate(out, task_id, patch=patch, label=run) if patch is not None else {"grade_valid": False, "reason": status}
    save(run_dir / "evaluation.json", evaluation)
    print(json.dumps({"run": run, "result": result, "evaluation": evaluation}))
    if stopped:
        raise RuntimeError("STOP: globally unresolved/breached request; preserve receipts and ledger")
    if refused:
        raise ProviderRefused("STOP: provider refusal; preserve the settled receipt and do not retry")


def resource_summary(out, ledger_out, run, cfg, result, *, wall_exhausted=False):
    with sqlite3.connect(ledger_out / "budget.sqlite") as db:
        rows = [row for row in request_rows(db) if row["run"] == run]
    receipts = [load(row["receipt"]) for row in rows]
    usage = [receipt.get("response", {}).get("usage", {}) for receipt in receipts]
    native_prompt = [value.get("prompt_tokens") for value in usage]
    native_completion = [value.get("completion_tokens") for value in usage]
    events = [load(path) for path in sorted((out / "resource-limits" / run).glob("*.json"))]
    caps = sorted({cap for event in events for cap in event.get("caps", [])})
    if result.get("exit_status") == "LimitsExceeded":
        caps.append("agent_step_limit")
    if wall_exhausted or result.get("exit_status") == "TimeExceeded" or "WallTimeLimited" in str(result):
        caps.append("wall_timeout")
    if "ActionTimeLimited" in str(result):
        caps.append("action_timeout")
    if any(row["state"] == "breach" for row in rows):
        caps.append("provider_money_or_token_bound_breach")
    return {
        "configured": {key: cfg[key] for key in ("step_limit", "max_input_tokens", "max_output_tokens", "run_token_limit", "wall_seconds", "run_cost_limit_usd")},
        "action_timeout_seconds": cfg.get("action_timeout_seconds", 60),
        "http_request_timeout_seconds": http_request_timeout(cfg),
        "caps_fired": sorted(set(caps)),
        "request_ids": [row["id"] for row in rows],
        "request_count": len(rows),
        "input_token_bounds": [receipt["input_token_bound"] for receipt in receipts],
        "native_prompt_tokens": native_prompt,
        "native_completion_tokens": native_completion,
        "request_money_bounds_usd": [receipt["reservation_usd"] for receipt in receipts],
        "native_cost_usd": [value.get("cost") for value in usage],
        "missing_native_usage_requests": sum(prompt is None or completion is None for prompt, completion in zip(native_prompt, native_completion)),
        "settled_plus_held_usd": str(sum((held_cost(row) for row in rows), Decimal(0))),
        "settled_plus_held_tokens": sum((row["tokens"] if row["state"] == "settled" else row["token_bound"]) or 0 for row in rows),
        "token_estimate_overruns": sum(receipt.get("token_estimate_overrun") is True for receipt in receipts),
        "limit_events": events,
    }


def smoke(out, task_id):
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.models.test_models import DeterministicModel, make_output

    panel, _ = check_panel(out)
    task = next(row for row in panel["tasks"] if row["instance_id"] == task_id)
    env = solver_environment(task, out)
    try:
        model = DeterministicModel(outputs=[make_output("Inspect public snapshot", [{"command": "test -z \"$(git remote -v)\" && test -z \"$(git for-each-ref)\" && test ! -f /root/.ssh/id_rsa && test ! -S /var/run/docker.sock && python -c 'import os; assert not any(k for k in os.environ if k.endswith((\"API_KEY\", \"TOKEN\", \"SECRET\"))); print(\"credential-free, no git history or remotes\")'"}], 0), make_output("Submit unchanged smoke", [{"command": "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"}], 0)], cost_per_call=0)
        agent = DefaultAgent(model, env, **agent_settings()["agent"], output_path=out / "smoke-trajectory.json")
        result = agent.run(task=task["problem_statement"])
        if result.get("exit_status") != "Submitted" or not any("credential-free, no git history or remotes" in str(message.get("content")) and "<returncode>0</returncode>" in str(message.get("content")) for message in agent.messages):
            raise RuntimeError("Deterministic isolation smoke failed")
        save(out / "smoke.json", {"result": result, "paid_http_calls": 0, "meaning": "Official mini agent control flow and isolated real public snapshot only; deterministic smoke is NOT a model solve"})
        print(json.dumps(result))
    finally:
        env.cleanup()


def runtime_preflight(out):
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.models.test_models import DeterministicModel
    import docker

    panel, _ = check_panel(out)
    modules = {"psf/requests": "requests", "pytest-dev/pytest": "pytest", "pylint-dev/pylint": "pylint", "pydata/xarray": "xarray", "sphinx-doc/sphinx": "sphinx", "matplotlib/matplotlib": "matplotlib"}
    summary = []
    for task in panel["tasks"]:
        env = solver_environment(task, out)
        try:
            imported = env.execute({"command": f"python -c 'import {modules[task['repo']]}; print(\"public-import-ok\")'"}, timeout=180)
            fixture = load(out / "fixtures" / f"{task['instance_id']}.json")
            baseline = fixture["baseline"]["result"][1][task["instance_id"]]
            public_tests = baseline.get("tests_status", {}).get("PASS_TO_PASS", {}).get("success", [])
            if public_tests:
                public_test = next((name for name in public_tests if task["repo"] == "psf/requests" and "test_connect_timeout" in name), public_tests[0])
            else:
                collected = env.execute({"command": "python -m pytest --collect-only -q tests/lint/unittest_lint.py"}, timeout=180)
                public_test = next((line.strip() for line in collected["output"].splitlines() if line.startswith("tests/") and "::" in line), None)
            tested = env.execute({"command": f"python -m pytest -q {shlex.quote(public_test)}"}, timeout=180) if public_test else {"returncode": -1, "output": "No pre-existing public test collected"}
            clean_patch = env.execute({"command": f"git add -N . && git diff --name-only {env.study_base_tree}"})
            paths = env.execute({"command": "git ls-files"})["output"].splitlines()
            source_file = next(path for path in paths if path.endswith(".py") and not path.startswith(("test", "doc")))
            deliberate = env.execute({"command": f"printf '\\n_STUDY_SMOKE_SENTINEL = 1\\n' >> {shlex.quote(source_file)} && git diff --name-only {env.study_base_tree}"})
            patch_clean = clean_patch["returncode"] == 0 and not clean_patch["output"].strip() and deliberate["returncode"] == 0 and deliberate["output"].splitlines() == [source_file]
            agent = DefaultAgent(DeterministicModel(outputs=[]), env, **agent_settings()["agent"])
            agent.extra_template_vars = {"task": task["problem_statement"]}
            messages = [{"role": role, "content": agent._render_template(agent_settings()["agent"][template])} for role, template in [("system", "system_template"), ("user", "instance_template")]]
            prompt_bound = len(json.dumps(messages, ensure_ascii=False).encode()) + 4096
            replay_bounds = []
            for index in range(6):
                messages.extend([{"role": "assistant", "content": "Inspect source.\\n```mswea_bash_command\\ncat source.py\\n```"}, {"role": "user", "content": "<returncode>0</returncode><output>" + "x" * 5000 + "</output>"}])
                replay_bounds.append(len(json.dumps(messages, ensure_ascii=False).encode()) + 4096)
            receipt = {"instance_id": task["instance_id"], "image_id": load(out / "images" / f"{task['instance_id']}.json")["id"], "import": imported, "public_test": public_test, "test": tested, "initial_input_bound": prompt_bound, "six_step_5kb_observation_bounds": replay_bounds, "public_test_patch_clean": patch_clean, "after_public_test_changed_paths": clean_patch["output"], "deliberate_source_change_paths": deliberate["output"], "valid": imported["returncode"] == 0 and tested["returncode"] == 0 and patch_clean}
            save(out / "runtime-preflight" / f"{task['instance_id']}.json", receipt)
            summary.append({key: receipt[key] for key in ["instance_id", "valid", "initial_input_bound", "six_step_5kb_observation_bounds"]})
        finally:
            docker.from_env().containers.get(env.container_id).remove(force=True)
    save(out / "runtime-preflight.json", summary)
    print(json.dumps(summary))








from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
from contextlib import contextmanager
from decimal import Decimal
import fcntl
import hashlib
import json
import math
import multiprocessing
import os
from pathlib import Path
import sqlite3
import time
import uuid

import census_analysis
import census_panel
import modern_eval
import study

HERE = Path(__file__).resolve().parent
MANIFEST = "census-manifest-v1.json"
TIMEOUT_AMENDMENT = "census-amendment-v2.json"
OVERRUN_AMENDMENT = "census-amendment-v3.json"
OVERRUN_POLICY = "settle-known-v1"
SOURCE_FILES = ("census.py", "census_panel.py", "census_analysis.py", "census-panel.json", "modern-panel.json", "modern_panel.py", "modern_eval.py", "study.py", "study.json", "calibration.py", "analyze.py")
CANDIDATES = [
    {"label": "efficient-grok", "model": "x-ai/grok-4.7", "effort": "low"},
    {"label": "efficient-haiku", "model": "anthropic/claude-haiku-5.5", "effort": "high"},
    {"label": "efficient-kimi", "model": "moonshotai/kimi-k3", "effort": "high"},
    {"label": "frontier-sol", "model": "openai/gpt-6.1-sol", "effort": "high"},
    {"label": "frontier-kimi", "model": "moonshotai/kimi-k3.1-pro", "effort": "high"},
]
RESOURCES = {"step_limit": 60, "wall_seconds": 1800, "action_timeout_seconds": 180, "run_cost_limit_usd": "3", "max_output_tokens": 16384, "run_token_limit": 2 ** 63 - 1, "byok_fee_ceiling_fraction": "0.06"}
GLOBAL_CAPS = {"experiment_money_reservation", "aggregate_money_reservation"}


def source_hashes():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def frozen_write(path, value):
    path = Path(path)
    if path.exists():
        if study.load(path) != value:
            raise RuntimeError(f"Frozen artifact changed: {path.name}")
        return value
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        stream.write(json.dumps(value, sort_keys=True, indent=2) + "\n")
    return value


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


@contextmanager
def writer(ledger_out):
    with (Path(ledger_out) / ".writer.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


@contextmanager
def batch_writer(ledger_out):
    ledger_out = Path(ledger_out)
    with (ledger_out / ".census-dispatch.lock").open("a+") as dispatch, (ledger_out / ".writer.lock").open("a+") as lock:
        fcntl.flock(dispatch, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(ledger_out / "budget.sqlite") as db:
            db.execute("BEGIN IMMEDIATE")
            ready_rows(db)
            db.execute("UPDATE census_claims SET state='interrupted' WHERE state='active'")
        fcntl.flock(lock, fcntl.LOCK_SH)
        yield


def amendment_tables(db):
    db.execute("CREATE TABLE IF NOT EXISTS census_cap_audit (id TEXT PRIMARY KEY, created_at REAL NOT NULL, authorization_sha256 TEXT NOT NULL, authorization TEXT NOT NULL, old_metadata TEXT NOT NULL, new_metadata TEXT NOT NULL, request_rows_sha256 TEXT NOT NULL, user_authorization_sha256 TEXT NOT NULL, user_authorization TEXT NOT NULL)")
    for operation in ("UPDATE", "DELETE"):
        db.execute(f"CREATE TRIGGER IF NOT EXISTS census_cap_audit_no_{operation.lower()} BEFORE {operation} ON census_cap_audit BEGIN SELECT RAISE(ABORT, 'cap audit is append-only'); END")


def user_cap_authorization(text):
    authorization = json.loads(text)
    if authorization.get("authorized") is not True or authorization.get("action") != "raise-aggregate-cap" or any(study.rate(authorization.get(key)) != Decimal(value) for key, value in [("previous_total_cap_usd", "150"), ("total_cap_usd", "250"), ("census_cap_usd", "120"), ("per_run_cap_usd", "3")]):
        raise RuntimeError("The unchanged user authorization must raise aggregate150 to250 with census120 and run3")
    return authorization


def amend_cap(ledger_out, approval_path, user_authorization_path):
    ledger_out = Path(ledger_out).resolve(strict=True)
    user_bytes = Path(user_authorization_path).read_bytes()
    user_text = user_bytes.decode("utf-8")
    user_cap_authorization(user_text)
    user_hash = hashlib.sha256(user_bytes).hexdigest()
    approval = study.load(approval_path)
    required = {"authorized": True, "action": "amend-census-aggregate-cap-v1", "user_authorization_sha256": user_hash}
    if any(approval.get(key) != value for key, value in required.items()):
        raise RuntimeError("Parent execution approval must bind the unchanged user authorization file hash")
    with writer(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite") as db:
        db.execute("BEGIN IMMEDIATE")
        amendment_tables(db)
        previous = db.execute("SELECT authorization_sha256,new_metadata,user_authorization_sha256 FROM census_cap_audit ORDER BY created_at DESC,id DESC LIMIT 1").fetchone()
        metadata = dict(db.execute("SELECT key,value FROM metadata"))
        if previous:
            if previous[0] != study.digest(approval) or json.loads(previous[1]) != metadata or previous[2] != user_hash:
                raise RuntimeError("A different cap amendment already exists")
            cap_metadata(db)
            return {"authorization_sha256": previous[0], "user_authorization_sha256": user_hash, "metadata": metadata}
        rows = study.assert_ledger_ready(db)
        if metadata.get("config_sha256") != study.digest(study.config()) or study.rate(metadata.get("total_cap_usd")) != Decimal("150"):
            raise RuntimeError("Amendment requires the original authoritative ledger")
        if approval.get("ledger_metadata_sha256") != study.digest(metadata) or approval.get("request_rows_sha256") != study.digest(rows):
            raise RuntimeError("Approval must bind current metadata and every historical request")
        new = {**metadata, "total_cap_usd": "250", "census_cap_usd": "120", "census_cap_authorization_sha256": study.digest(approval), "census_user_authorization_sha256": user_hash}
        db.executemany("INSERT OR REPLACE INTO metadata VALUES (?,?)", new.items())
        db.execute("INSERT INTO census_cap_audit VALUES (?,?,?,?,?,?,?,?,?)", (uuid.uuid4().hex, time.time(), study.digest(approval), json.dumps(approval, sort_keys=True), json.dumps(metadata, sort_keys=True), json.dumps(new, sort_keys=True), study.digest(rows), user_hash, user_text))
    return {"authorization_sha256": study.digest(approval), "user_authorization_sha256": user_hash, "metadata": new}


def cap_metadata(db):
    metadata = dict(db.execute("SELECT key,value FROM metadata"))
    audit = db.execute("SELECT authorization_sha256,authorization,new_metadata,user_authorization_sha256,user_authorization FROM census_cap_audit ORDER BY created_at DESC,id DESC LIMIT 1").fetchone()
    if not audit or study.digest(json.loads(audit[1])) != audit[0] or json.loads(audit[2]) != metadata or metadata.get("total_cap_usd") != "250" or metadata.get("census_cap_usd") != "120" or metadata.get("config_sha256") != study.digest(study.config()):
        raise RuntimeError("Missing or invalid append-audited census cap amendment")
    if hashlib.sha256(audit[4].encode("utf-8")).hexdigest() != audit[3] or json.loads(audit[1]).get("user_authorization_sha256") != audit[3] or metadata.get("census_user_authorization_sha256") != audit[3]:
        raise RuntimeError("Cap amendment lost its exact user authorization byte binding")
    user_cap_authorization(audit[4])
    return metadata


def runtime_tables(db):
    db.execute("CREATE TABLE IF NOT EXISTS census_claims (run TEXT PRIMARY KEY, driver TEXT NOT NULL, state TEXT NOT NULL, claimed_at REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS census_stops (experiment TEXT PRIMARY KEY, caps TEXT NOT NULL, created_at REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS census_dispatch (request_id TEXT PRIMARY KEY, run TEXT NOT NULL, state TEXT NOT NULL)")


def ready_rows(db, driver=None, run=None):
    rows = study.request_rows(db)
    for row in rows:
        study.held_cost(row)
        if row["state"] == "settled":
            continue
        if row["state"] == "reserved" and driver is not None:
            claim = db.execute("SELECT driver,state FROM census_claims WHERE run=?", (row["run"],)).fetchone()
            if claim == (driver, "active") and row["actual"] is None and Decimal(row["bound"]) > 0 and type(row["token_bound"]) is int and row["token_bound"] > 0:
                continue
        if row["state"] == "accounted_unknown" and study.accounting_enabled(db) and row["run"] != run:
            audit = db.execute("SELECT new_row FROM accounting_audit WHERE request_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (row["id"],)).fetchone()
            if Decimal(row["bound"]) > 0 and study.held_cost(row) <= Decimal(row["bound"]) and type(row["token_bound"]) is int and row["token_bound"] > 0 and audit and json.loads(audit[0]) == row:
                continue
        raise RuntimeError("Unresolved or breached request stops all new dispatch")
    return rows


@contextmanager
def dispatch_guard(ledger_out):
    with (Path(ledger_out) / ".census-admission.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


@contextmanager
def dispatch_admission(ledger_out, run, request_id, cfg):
    with dispatch_guard(ledger_out), sqlite3.connect(Path(ledger_out) / "budget.sqlite", timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        owned = db.execute("SELECT run,state FROM census_dispatch WHERE request_id=?", (request_id,)).fetchone()
        try:
            if owned != (run, "reserved"):
                raise RuntimeError("Only a never-dispatched owned reservation may enter transport")
            metadata = cap_metadata(db)
            rows = ready_rows(db, cfg["driver_id"], run)
            request = next((row for row in rows if row["id"] == request_id), None)
            claim = db.execute("SELECT driver,state FROM census_claims WHERE run=?", (run,)).fetchone()
            if request is None or request["run"] != run or request["state"] != "reserved" or claim != (cfg["driver_id"], "active"):
                raise RuntimeError("Dispatch requires its active claim and live reservation")
            stopped = db.execute("SELECT caps FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone()
            caps = json.loads(stopped[0]) if stopped else []
            if Decimal(metadata["prior_committed_usd"]) + sum((study.held_cost(row) for row in rows), Decimal(0)) > Decimal(metadata["total_cap_usd"]):
                caps.append("aggregate_money_reservation")
            if sum((study.held_cost(row) for row in rows if row["run"].startswith(cfg["experiment_id"] + "--")), Decimal(0)) > Decimal(metadata["census_cap_usd"]):
                caps.append("experiment_money_reservation")
            if sum((study.held_cost(row) for row in rows if row["run"] == run), Decimal(0)) > Decimal(cfg["run_cost_limit_usd"]):
                caps.append("run_money_reservation")
            if caps:
                raise study.BudgetLimited("Final dispatch admission denied by global stop or caps", {"caps": sorted(set(caps))})
        except BaseException:
            if owned == (run, "reserved"):
                db.execute("UPDATE requests SET bound='0',actual='0',tokens=0,state='settled' WHERE id=? AND run=? AND state='reserved' AND actual IS NULL", (request_id, run))
                db.execute("UPDATE census_dispatch SET state='cancelled' WHERE request_id=?", (request_id,))
                db.commit()
            raise
        db.execute("UPDATE census_dispatch SET state='entered' WHERE request_id=?", (request_id,))
        db.commit()
    yield


def reserve(out, run, bound, token_bound, *, cfg, ledger_out):
    ledger_out = Path(ledger_out)
    request_id = uuid.uuid4().hex
    with dispatch_guard(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite", isolation_level=None, timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        metadata = cap_metadata(db)
        rows = ready_rows(db, cfg["driver_id"], run)
        claim = db.execute("SELECT driver,state FROM census_claims WHERE run=?", (run,)).fetchone()
        if claim != (cfg["driver_id"], "active") or not run.startswith(cfg["experiment_id"] + "--"):
            raise RuntimeError("Only a claimed frozen census run may reserve")
        if db.execute("SELECT 1 FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone():
            raise study.BudgetLimited("Census cap previously stopped dispatch", {"caps": ["experiment_money_reservation"]})
        if not Decimal(bound).is_finite() or bound <= 0 or type(token_bound) is not int or token_bound <= 0:
            raise RuntimeError("Invalid reservation")
        spent = sum((study.held_cost(row) for row in rows), Decimal(0))
        run_spent = sum((study.held_cost(row) for row in rows if row["run"] == run), Decimal(0))
        experiment_spent = sum((study.held_cost(row) for row in rows if row["run"].startswith(cfg["experiment_id"] + "--")), Decimal(0))
        caps = []
        if Decimal(metadata["prior_committed_usd"]) + spent + bound > Decimal(metadata["total_cap_usd"]):
            caps.append("aggregate_money_reservation")
        if experiment_spent + bound > Decimal(metadata["census_cap_usd"]):
            caps.append("experiment_money_reservation")
        if run_spent + bound > Decimal(cfg["run_cost_limit_usd"]):
            caps.append("run_money_reservation")
        if caps:
            if GLOBAL_CAPS.intersection(caps):
                db.execute("INSERT OR IGNORE INTO census_stops VALUES (?,?,?)", (cfg["experiment_id"], json.dumps(caps), time.time()))
                db.execute("COMMIT")
            raise study.BudgetLimited("Census reservation exceeds cap", {"caps": caps, "next_money_bound_usd": str(bound), "next_token_bound": token_bound, "run_settled_plus_held_usd": str(run_spent), "experiment_settled_plus_held_usd": str(experiment_spent)})
        receipt = Path(out) / "receipts" / f"{request_id}.json"
        db.execute("INSERT INTO requests (id,run,bound,actual,tokens,state,receipt,token_bound) VALUES (?,?,?,NULL,NULL,'reserved',?,?)", (request_id, run, str(bound), str(receipt), token_bound))
        db.execute("INSERT INTO census_dispatch VALUES (?,?,'reserved')", (request_id, run))
        db.execute("COMMIT")
    return request_id, receipt


def effective_config(ledger_out, experiment_id):
    if not modern_eval.SAFE_NAME.fullmatch(experiment_id):
        raise RuntimeError("Unsafe experiment identity")
    exclusion = study.candidate_exclusion(ledger_out, required=True)
    candidates = study.active_candidates(ledger_out)
    if candidates != CANDIDATES:
        raise RuntimeError("Census must retain the exact authorized five candidates in fixed order")
    return {**study.config(), **RESOURCES, "max_input_tokens": 1, "candidates": candidates, "experiment_id": experiment_id, "experiment_cost_limit_usd": "120", "input_bound_policy": "native-anchored-v1", "exclusion_manifest_sha256": study.digest(exclusion)}


def attempted_run_ids(out, plan, rows):
    planned = [row["run"] for row in plan["runs"]]
    prefix = plan["experiment_id"] + "--"
    observed = {row["run"] for row in rows if row["run"].startswith(prefix)}
    observed.update(path.name for path in (Path(out) / "rollouts").glob(prefix + "*") if path.is_dir())
    return [run for run in planned if modern_eval.attempted(out, rows, run)] + sorted(observed - set(planned))


def timeout_attempt_snapshot(out, runs, rows):
    out = Path(out).resolve()
    selected = set(runs)
    requests = [row for row in rows if row["run"] in selected]
    paths = [path for run in runs for path in (out / "rollouts" / run).rglob("*") if path.is_file()]
    paths.extend(Path(row["receipt"]) for row in requests)
    files = {}
    for path in paths:
        path = path.resolve(strict=True)
        if not path.is_relative_to(out):
            raise RuntimeError("Attempted-run amendment evidence escaped its experiment root")
        files[str(path.relative_to(out))] = modern_eval.file_sha256(path)
    return {"request_rows_sha256": study.digest(requests), "files_sha256": files}


def validate_timeout_amendment(out, manifest, amendment, rows, plan, *, creating=False):
    if not isinstance(amendment, dict) or amendment.get("schema") != "census-amendment-v2":
        raise RuntimeError("Invalid census timeout amendment")
    raw = amendment.get("user_authorization_raw")
    if not isinstance(raw, str) or hashlib.sha256(raw.encode("utf-8")).hexdigest() != amendment.get("user_authorization_sha256"):
        raise RuntimeError("Timeout amendment lost the exact user authorization file hash")
    user = json.loads(raw)
    if user.get("authorized") is not True or user.get("schema") != "router-headroom-census-amendment-v2" or user.get("action") != "amend-census-request-timeout-v1" or user.get("change") != {"http_request_timeout_seconds": {"from": 180, "to": 600}}:
        raise RuntimeError("Exact prospective180-to600 user authorization required")
    observed = user.get("observed_before_amendment", {})
    if observed.get("tasks_attempted") != 1 or observed.get("runs_attempted") != 5 or observed.get("outcomes_used_for_task_selection") is not False:
        raise RuntimeError("Timeout authorization must identify the observed first task and five attempts")
    original_sources = manifest["source_sha256"]
    amended_sources = amendment.get("to_source_sha256")
    if not isinstance(amended_sources, dict) or set(amended_sources) != set(SOURCE_FILES):
        raise RuntimeError("Timeout amendment permits only the exact approved driver source transition")
    changed = {name for name in original_sources if original_sources[name] != amended_sources.get(name)}
    if set(original_sources) != set(SOURCE_FILES) or amendment.get("from_source_sha256") != original_sources or not {"study.py", "census.py"}.issubset(changed) or changed - {"study.py", "census.py", "census_panel.py"}:
        raise RuntimeError("Timeout amendment permits only the exact approved driver source transition")
    before = manifest["resources"]
    after = {**before, "http_request_timeout_seconds": 600}
    if before != RESOURCES or before.get("http_request_timeout_seconds", 180) != 180 or amendment.get("from_resources") != before or amendment.get("to_resources") != after:
        raise RuntimeError("Timeout amendment may change only the HTTP request timeout")
    required = {"authorized": True, "action": "amend-census-request-timeout-v1", "user_authorization_sha256": amendment["user_authorization_sha256"], "census_manifest_sha256": study.digest(manifest), "to_source_sha256": amended_sources}
    approval = amendment.get("authorization", {})
    if any(approval.get(key) != value for key, value in required.items()) or amendment.get("authorization_sha256") != study.digest(approval) or amendment.get("census_manifest_sha256") != study.digest(manifest):
        raise RuntimeError("Parent timeout execution approval does not bind this manifest, user file and source")
    first_task = plan["runs"][0]["instance_id"] if plan["runs"] else None
    expected = [row["run"] for row in plan["runs"] if row["instance_id"] == first_task]
    actual = attempted_run_ids(out, plan, rows)
    if len(expected) != 5 or amendment.get("attempted_runs") != expected or (creating and actual != expected) or not set(expected).issubset(actual):
        raise RuntimeError("Timeout amendment attempted set differs from the authorized first task")
    if amendment.get("attempted_snapshot") != timeout_attempt_snapshot(out, expected, rows):
        raise RuntimeError("Pre-amendment attempted-run evidence or ledger rows changed")
    return amendment


def overrun_settlement(row, receipt):
    usage = (receipt.get("response") or {}).get("usage") or {}
    prompt_tokens, completion_tokens = usage.get("prompt_tokens"), usage.get("completion_tokens")
    request = receipt.get("request") or {}
    status = receipt.get("http_status")
    if row.get("state") != "breach" or receipt.get("local_request_id") != row.get("id") or receipt.get("run") != row.get("run") or receipt.get("status") != "breach" or receipt.get("dispatch_entered") is not True or receipt.get("error_type") != "RuntimeError" or type(status) is not int or not 200 <= status < 300:
        raise RuntimeError("Only a dispatched successful-response breach may be settled")
    if any(type(value) is not int or value < 0 for value in (prompt_tokens, completion_tokens)) or type(receipt.get("input_token_bound")) is not int or type(request.get("max_tokens")) is not int:
        raise RuntimeError("Breach usage counts are invalid; keep the breach")
    if prompt_tokens <= receipt["input_token_bound"] and completion_tokens <= request["max_tokens"]:
        raise RuntimeError("Breach is not a token-estimate overrun")
    if isinstance(usage.get("cost"), bool) or usage.get("cost") is None:
        raise RuntimeError("Breach has no known provider charge")
    if usage.get("is_byok") is True:
        fee = study.rate(usage["cost"])
        upstream = study.rate((usage.get("cost_details") or {}).get("upstream_inference_cost"))
        if fee > study.rate(receipt.get("byok_fee_ceiling_fraction")) * upstream:
            raise RuntimeError("Breach exceeds the BYOK fee ceiling")
        actual = fee + upstream
    else:
        actual = study.rate(usage["cost"])
    bound = study.rate(row.get("bound"))
    if study.rate(receipt.get("reservation_usd")) != bound or row.get("actual") is None or study.rate(row["actual"]) != actual or actual > bound:
        raise RuntimeError("Breach charge is not a known charge within its money reservation")
    return {**row, "state": "settled", "tokens": prompt_tokens + completion_tokens}


def overrun_audits(ledger_out, request_id, authorization_hash):
    with sqlite3.connect((Path(ledger_out) / "budget.sqlite").resolve().as_uri() + "?mode=ro", uri=True) as db:
        return [(json.loads(old), json.loads(new)) for old, new in db.execute("SELECT old_row,new_row FROM accounting_audit WHERE request_id=? AND authorization_sha256=? ORDER BY created_at,id", (request_id, authorization_hash))]


def validate_overrun_amendment(out, ledger_out, manifest, timeout, amendment, rows, plan, *, creating=False):
    if not isinstance(amendment, dict) or amendment.get("schema") != "census-amendment-v3":
        raise RuntimeError("Invalid census token-overrun amendment")
    raw = amendment.get("user_authorization_raw")
    if not isinstance(raw, str) or hashlib.sha256(raw.encode("utf-8")).hexdigest() != amendment.get("user_authorization_sha256"):
        raise RuntimeError("Token-overrun amendment lost the exact user authorization file hash")
    user = json.loads(raw)
    observed = user.get("observed_before_amendment") or {}
    if user.get("schema") != "router-headroom-census-amendment-v3" or user.get("authorized") is not True or user.get("action") != "amend-census-token-overrun-v1" or type(observed.get("runs_attempted")) is not int:
        raise RuntimeError("Exact token-overrun user authorization required")
    settlement = amendment.get("settlement") or {}
    request_id = observed.get("breach_request_id")
    old_row, new_row = settlement.get("old_row"), settlement.get("new_row")
    if settlement.get("request_id") != request_id or settlement.get("run") != observed.get("breach_run") or not isinstance(old_row, dict) or old_row.get("id") != request_id or old_row.get("run") != settlement.get("run"):
        raise RuntimeError("Token-overrun amendment must settle exactly the named breach request")
    receipt_path = Path(old_row["receipt"])
    if modern_eval.file_sha256(receipt_path) != settlement.get("receipt_sha256") or overrun_settlement(old_row, study.load(receipt_path)) != new_row:
        raise RuntimeError("Named breach receipt no longer proves a token-only overrun")
    if study.rate(new_row["actual"]) != study.rate(observed.get("known_charge_usd")) or study.rate(new_row["bound"]) != study.rate(observed.get("money_reservation_usd")):
        raise RuntimeError("Named breach charge or reservation differs from the user authorization")
    current = next((row for row in rows if row["id"] == request_id), None)
    if creating:
        if current != old_row:
            raise RuntimeError("Named breach request changed before settlement")
        rows = [new_row if row["id"] == request_id else row for row in rows]
    elif current != new_row or overrun_audits(ledger_out, request_id, amendment["user_authorization_sha256"]) != [(old_row, new_row)]:
        raise RuntimeError("Named breach settlement lacks its exact append-only audit")
    from_sources, to_sources = timeout["to_source_sha256"], amendment.get("to_source_sha256")
    if amendment.get("from_source_sha256") != from_sources or not isinstance(to_sources, dict) or set(to_sources) != set(SOURCE_FILES):
        raise RuntimeError("Token-overrun amendment permits only the exact approved driver source transition")
    changed = sorted(name for name in SOURCE_FILES if from_sources[name] != to_sources[name])
    if changed != ["census.py", "study.py"] or amendment.get("changed_source_files") != changed:
        raise RuntimeError("Token-overrun amendment permits only the exact approved driver source transition")
    before = timeout["to_resources"]
    if amendment.get("from_resources") != before or amendment.get("to_resources") != {**before, "token_overrun_policy": OVERRUN_POLICY}:
        raise RuntimeError("Token-overrun amendment may only add the token overrun policy")
    required = {"authorized": True, "action": "amend-census-token-overrun-v1", "user_authorization_sha256": amendment["user_authorization_sha256"], "census_manifest_sha256": study.digest(manifest), "timeout_amendment_sha256": study.digest(timeout), "to_source_sha256": to_sources, "breach_request_id": request_id}
    approval = amendment.get("authorization", {})
    if any(approval.get(key) != value for key, value in required.items()) or amendment.get("authorization_sha256") != study.digest(approval) or amendment.get("census_manifest_sha256") != study.digest(manifest) or amendment.get("timeout_amendment_sha256") != study.digest(timeout):
        raise RuntimeError("Parent token-overrun execution approval does not bind this manifest, amendment chain, user file, source and request")
    attempted = amendment.get("attempted_runs")
    actual = attempted_run_ids(out, plan, rows)
    if not isinstance(attempted, list) or len(attempted) != observed["runs_attempted"] or settlement["run"] not in attempted or not set(timeout["attempted_runs"]).issubset(attempted) or (creating and actual != attempted) or not set(attempted).issubset(actual):
        raise RuntimeError("Token-overrun amendment attempted set differs from the authorized observation")
    if amendment.get("attempted_snapshot") != timeout_attempt_snapshot(out, attempted, rows):
        raise RuntimeError("Pre-amendment attempted-run evidence or ledger rows changed")
    return amendment


def load_amendment(out, name):
    path = Path(out) / name
    return study.load(path) if path.exists() else None


def active_amendment(out):
    for name in (OVERRUN_AMENDMENT, TIMEOUT_AMENDMENT):
        amendment = load_amendment(out, name)
        if amendment is not None:
            return name, amendment
    return None, None


def amendment_chain(out, ledger_out, manifest, rows, plan, *, pending_timeout=None, pending_overrun=None):
    timeout = pending_timeout if pending_timeout is not None else load_amendment(out, TIMEOUT_AMENDMENT)
    overrun = pending_overrun if pending_overrun is not None else load_amendment(out, OVERRUN_AMENDMENT)
    chain = []
    if timeout is not None:
        chain.append(validate_timeout_amendment(out, manifest, timeout, rows, plan, creating=pending_timeout is not None))
    if overrun is not None:
        if timeout is None:
            raise RuntimeError("Token-overrun amendment requires the applied timeout amendment")
        chain.append(validate_overrun_amendment(out, ledger_out, manifest, timeout, overrun, rows, plan, creating=pending_overrun is not None))
    if chain and chain[-1]["to_source_sha256"] != source_hashes():
        raise RuntimeError("Census driver source differs from the authorized source transition chain")
    return chain


def amend_timeout(out, panel_out, ledger_out, user_authorization_path, approval_path):
    out, panel_out, ledger_out = modern_eval.separate_roots(out, panel_out, ledger_out)
    path = out / TIMEOUT_AMENDMENT
    user_raw = Path(user_authorization_path).read_bytes()
    approval = study.load(approval_path)
    with writer(ledger_out), dispatch_guard(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite") as db:
        db.execute("BEGIN IMMEDIATE")
        if path.exists():
            raise RuntimeError("Timeout amendment already exists; never overwrite it")
        rows = ready_rows(db)
        manifest = study.load(out / MANIFEST)
        cfg = effective_config(ledger_out, manifest["experiment_id"])
        plan = study.load(out / "execution-plan.json")
        attempted = attempted_run_ids(out, plan, rows)
        amendment = {"schema": "census-amendment-v2", "census_manifest_sha256": study.digest(manifest), "user_authorization_sha256": hashlib.sha256(user_raw).hexdigest(), "user_authorization_raw": user_raw.decode("utf-8"), "authorization": approval, "authorization_sha256": study.digest(approval), "from_source_sha256": manifest["source_sha256"], "to_source_sha256": source_hashes(), "from_resources": manifest["resources"], "to_resources": {**manifest["resources"], "http_request_timeout_seconds": 600}, "attempted_runs": attempted, "attempted_snapshot": timeout_attempt_snapshot(out, attempted, rows)}
        validate_timeout_amendment(out, manifest, amendment, rows, plan, creating=True)
        validate_manifest(out, panel_out, ledger_out, pending_amendment=amendment)
        if execution_plan(study.load(panel_out / "panel.json")["tasks"], cfg) != plan:
            raise RuntimeError("Timeout amendment cannot alter the frozen execution plan")
        db.executemany("UPDATE census_claims SET state='interrupted' WHERE run=? AND state='active'", ((row["run"],) for row in plan["runs"] if row["run"] not in attempted))
        frozen_write(path, amendment)
    return amendment


def amend_overrun(out, panel_out, ledger_out, user_authorization_path, approval_path):
    out, panel_out, ledger_out = modern_eval.separate_roots(out, panel_out, ledger_out)
    path = out / OVERRUN_AMENDMENT
    user_raw = Path(user_authorization_path).read_bytes()
    user_hash = hashlib.sha256(user_raw).hexdigest()
    observed = json.loads(user_raw).get("observed_before_amendment") or {}
    approval = study.load(approval_path)
    with writer(ledger_out), dispatch_guard(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite") as db:
        db.execute("BEGIN IMMEDIATE")
        if path.exists():
            raise RuntimeError("Token-overrun amendment already exists; never overwrite it")
        timeout = load_amendment(out, TIMEOUT_AMENDMENT)
        if timeout is None:
            raise RuntimeError("Token-overrun amendment requires the applied timeout amendment")
        manifest = study.load(out / MANIFEST)
        plan = study.load(out / "execution-plan.json")
        rows = study.request_rows(db)
        target = next((row for row in rows if row["id"] == observed.get("breach_request_id")), None)
        if target is None:
            raise RuntimeError("Named breach request is absent from the authoritative ledger")
        receipt_path = Path(target["receipt"])
        new_row = overrun_settlement(target, study.load(receipt_path))
        projected = [new_row if row["id"] == target["id"] else row for row in rows]
        attempted = attempted_run_ids(out, plan, projected)
        sources = source_hashes()
        amendment = {"schema": "census-amendment-v3", "census_manifest_sha256": study.digest(manifest), "timeout_amendment_sha256": study.digest(timeout), "user_authorization_sha256": user_hash, "user_authorization_raw": user_raw.decode("utf-8"), "authorization": approval, "authorization_sha256": study.digest(approval), "from_source_sha256": timeout["to_source_sha256"], "to_source_sha256": sources, "changed_source_files": sorted(name for name in SOURCE_FILES if timeout["to_source_sha256"][name] != sources[name]), "from_resources": timeout["to_resources"], "to_resources": {**timeout["to_resources"], "token_overrun_policy": OVERRUN_POLICY}, "settlement": {"request_id": target["id"], "run": target["run"], "old_row": target, "new_row": new_row, "receipt_sha256": modern_eval.file_sha256(receipt_path)}, "attempted_runs": attempted, "attempted_snapshot": timeout_attempt_snapshot(out, attempted, projected)}
        validate_manifest(out, panel_out, ledger_out, pending_overrun=amendment)
        study.create_accounting_audit(db)
        if db.execute("UPDATE requests SET state='settled', tokens=? WHERE id=? AND state='breach'", (new_row["tokens"], target["id"])).rowcount != 1:
            raise RuntimeError("Named breach request changed during settlement")
        study.record_accounting(db, target, new_row, user_hash)
        ready_rows(db)
        db.executemany("UPDATE census_claims SET state='interrupted' WHERE run=? AND state='active'", ((row["run"],) for row in plan["runs"] if row["run"] not in attempted))
        frozen_write(path, amendment)
    return amendment


def execution_plan(tasks, cfg):
    return {"experiment_id": cfg["experiment_id"], "runs": [{"run": f"{cfg['experiment_id']}--{task['instance_id']}--{candidate['label']}--0", "instance_id": task["instance_id"], "repo": task["repo"], "candidate": candidate["label"], "model": candidate["model"], "effort": candidate["effort"], "repetition": 0, "phase": "census"} for task in tasks for candidate in cfg["candidates"]]}


def inputs(panel_out, cfg, *, source_transition=None):
    options = {"source_transition": source_transition} if source_transition is not None else {}
    panel, private = census_panel.check_panel(panel_out, **options)
    evidence = {task["instance_id"]: census_panel.task_evidence(panel_out, task, **options) for task in private}
    plan = execution_plan(panel["tasks"], cfg)
    sources = source_hashes() if source_transition is None else source_transition["from_source_sha256"]
    return {"panel_sha256": study.digest(panel), "evidence_sha256": study.digest(evidence), "execution_plan_sha256": study.digest(plan), "exclusion_manifest_sha256": cfg["exclusion_manifest_sha256"], "source_sha256": sources}, panel, private, plan


def freeze(out, panel_out, ledger_out, experiment_id, approval_path):
    out, panel_out, ledger_out = modern_eval.separate_roots(out, panel_out, ledger_out)
    cfg = effective_config(ledger_out, experiment_id)
    frozen, panel, private, plan = inputs(panel_out, cfg)
    approval = study.load(approval_path)
    with writer(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite") as db:
        db.execute("BEGIN IMMEDIATE")
        metadata = cap_metadata(db)
        rows = ready_rows(db)
        runtime_tables(db)
        required = {"authorized": True, "action": "freeze-census-v1", "experiment_id": experiment_id, "resources": RESOURCES, "census_cap_authorization_sha256": metadata["census_cap_authorization_sha256"], **frozen}
        if any(approval.get(key) != value for key, value in required.items()):
            raise RuntimeError("Freeze authorization must bind exact panel/evidence/plan/source/resources/scope/cap amendment")
        if any(row["run"].startswith(experiment_id + "--") for row in rows) or (out / "rollouts").exists() or (out / MANIFEST).exists():
            raise RuntimeError("Census freeze must precede every experiment attempt")
        for task in private:
            source = panel_out / "images" / f"{task['instance_id']}.json"
            destination = out / "images" / source.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as stream:
                stream.write(source.read_bytes())
        manifest = {"version": 1, "purpose": "router-headroom-census", "experiment_id": experiment_id, "experiment_root": str(out), "panel_root": str(panel_out), "ledger_root": str(ledger_out), "resources": RESOURCES, "configuration_sha256": study.digest(cfg), "original_metadata": metadata, "historical_request_ids": [row["id"] for row in rows], "historical_rows_sha256": study.digest(rows), "authorization": approval, "authorization_sha256": study.digest(approval), **frozen}
        frozen_write(out / "execution-plan.json", plan)
        frozen_write(out / MANIFEST, manifest)
    return manifest


def validate_manifest(out, panel_out, ledger_out, *, pending_amendment=None, pending_overrun=None):
    out, panel_out, ledger_out = modern_eval.separate_roots(out, panel_out, ledger_out)
    manifest = study.load(out / MANIFEST)
    if manifest.get("purpose") != "router-headroom-census" or [manifest.get(key) for key in ("experiment_root", "panel_root", "ledger_root")] != [str(out), str(panel_out), str(ledger_out)]:
        raise RuntimeError("Census roots changed")
    cfg = effective_config(ledger_out, manifest["experiment_id"])
    with sqlite3.connect(ledger_out / "budget.sqlite") as db:
        rows = study.request_rows(db)
    chain = amendment_chain(out, ledger_out, manifest, rows, study.load(out / "execution-plan.json"), pending_timeout=pending_amendment, pending_overrun=pending_overrun)
    transition = {"from_source_sha256": manifest["source_sha256"], "to_source_sha256": chain[-1]["to_source_sha256"]} if chain else None
    frozen, panel, private, plan = inputs(panel_out, cfg, source_transition=transition)
    required = {"authorized": True, "action": "freeze-census-v1", "experiment_id": cfg["experiment_id"], "resources": RESOURCES, "census_cap_authorization_sha256": manifest["original_metadata"]["census_cap_authorization_sha256"], **frozen}
    if any(manifest.get(key) != value for key, value in frozen.items()) or any(manifest["authorization"].get(key) != value for key, value in required.items()) or manifest["authorization_sha256"] != study.digest(manifest["authorization"]) or manifest["configuration_sha256"] != study.digest(cfg) or study.load(out / "execution-plan.json") != plan:
        raise RuntimeError("Census frozen inputs changed")
    with sqlite3.connect(ledger_out / "budget.sqlite") as db:
        metadata = cap_metadata(db)
        rows = study.request_rows(db)
    historical = [row for row in rows if row["id"] in set(manifest["historical_request_ids"])]
    if metadata != manifest["original_metadata"] or study.digest(historical) != manifest["historical_rows_sha256"]:
        raise RuntimeError("Historical ledger changed after census freeze")
    for task in private:
        name = f"{task['instance_id']}.json"
        if study.load(out / "images" / name) != study.load(panel_out / "images" / name):
            raise RuntimeError("Frozen paid-run image identity changed")
    for amendment in chain:
        cfg = {**cfg, **amendment["to_resources"]}
    return manifest, cfg, plan, panel["tasks"], {task["instance_id"]: task for task in private}, rows


def shared_pricing(directory, cfg):
    pricing = study.load(Path(directory) / "pricing.json")
    if [(model["label"], model["model"], model["effort"]) for model in pricing["models"]] != [(candidate["label"], candidate["model"], candidate["effort"]) for candidate in cfg["candidates"]]:
        raise RuntimeError("Pricing candidate scope changed")
    contexts = []
    snapshots = []
    for model in pricing["models"]:
        quote = model["financial_quote"]
        snapshot = study.load(Path(directory) / "pricing-endpoints" / f"{quote['endpoint_snapshot_sha256']}.json")
        if study.digest(snapshot["body"]) != quote["endpoint_snapshot_sha256"] or snapshot["body"]["data"]["id"] != model["model"]:
            raise RuntimeError("Endpoint snapshot identity mismatch")
        endpoints = snapshot["body"]["data"]["endpoints"]
        provisional = study.endpoint_ceiling(endpoints, cfg)
        tags = set(provisional["financial_endpoint_tags"])
        contexts.extend(min(endpoint["context_length"] - cfg["max_output_tokens"], endpoint.get("max_prompt_tokens") or endpoint["context_length"]) for endpoint in endpoints if endpoint["tag"] in tags)
        snapshots.append((model, endpoints, provisional))
    bound = min(contexts)
    if type(bound) is not int or bound <= 0:
        raise RuntimeError("No shared input context after reserving output")
    effective = {**cfg, "max_input_tokens": bound}
    for model, endpoints, provisional in snapshots:
        expected = study.endpoint_ceiling(endpoints, effective)
        if expected["financial_endpoint_tags"] != provisional["financial_endpoint_tags"]:
            raise RuntimeError("Shared context changed quoted reachable endpoint scope")
        quote = model["financial_quote"]
        if any(quote.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Batch financial quote does not reproduce at shared context")
        study.financial_prices(model)
        study.routing_max_price(model)
    if pricing.get("shared_input_bound") != bound:
        raise RuntimeError("Shared context bound changed")
    return pricing, effective


def quote(out, panel_out, ledger_out, batch_id):
    _, cfg, _, _, _, _ = validate_manifest(out, panel_out, ledger_out)
    directory = modern_eval.batch_directory(out, batch_id)
    directory.mkdir(parents=True, exist_ok=False)
    study.catalog(directory, cfg=cfg)
    pricing = study.load(directory / "pricing.json")
    contexts = []
    for model in pricing["models"]:
        endpoints = study.load(directory / "pricing-endpoints" / f"{model['financial_quote']['endpoint_snapshot_sha256']}.json")["body"]["data"]["endpoints"]
        tags = set(model["financial_quote"]["financial_endpoint_tags"])
        contexts.extend(min(endpoint["context_length"] - cfg["max_output_tokens"], endpoint.get("max_prompt_tokens") or endpoint["context_length"]) for endpoint in endpoints if endpoint["tag"] in tags)
    bound = min(contexts)
    for model in pricing["models"]:
        quote_record = model["financial_quote"]
        endpoints = study.load(directory / "pricing-endpoints" / f"{quote_record['endpoint_snapshot_sha256']}.json")["body"]["data"]["endpoints"]
        model["financial_quote"] = {**quote_record, **study.endpoint_ceiling(endpoints, {**cfg, "max_input_tokens": bound})}
    pricing["shared_input_bound"] = bound
    study.save(directory / "pricing.json", pricing)
    shared_pricing(directory, cfg)
    return {"batch_id": batch_id, "pricing_sha256": study.digest(pricing), "shared_input_bound": bound, "fetched_at": pricing["fetched_at"]}


def normalized_results(out, rows, plan):
    results = {}
    for item in plan["runs"]:
        directory = Path(out) / "rollouts" / item["run"]
        result_path, evaluation_path = directory / "result.json", directory / "evaluation.json"
        if not result_path.exists():
            continue
        result = study.load(result_path)
        evaluation = study.load(evaluation_path) if evaluation_path.exists() else {}
        report = evaluation.get("result")
        case = report[1].get(item["instance_id"], {}) if isinstance(report, list) and len(report) > 1 and isinstance(report[1], dict) else {}
        status = result["status"]
        resolved = False if status in {"budget_limited", "transport_unknown"} else case.get("resolved")
        if status == "completed" and type(resolved) is not bool:
            status = "infra_invalid"
        billed = [row for row in rows if row["run"] == item["run"]]
        if status == "completed" and not billed:
            status = "infra_invalid"
        known = sum((study.rate(row["actual"]) for row in billed if row["actual"] is not None), Decimal(0))
        upper = sum((study.held_cost(row) for row in billed), Decimal(0))
        results[(item["instance_id"], item["candidate"])] = {"status": status, "resolved": resolved, "known": str(known), "cost": str(known) if all(row["state"] == "settled" for row in billed) else None, "upper": str(upper), "elapsed": result.get("elapsed_seconds"), "caps_fired": result.get("resources", {}).get("caps_fired", []), "hiddenGradeValid": type(case.get("resolved")) is bool}
    return results


def confirmation(out, panel_out, ledger_out):
    with writer(ledger_out), sqlite3.connect(Path(ledger_out) / "budget.sqlite") as db:
        manifest, cfg, plan, tasks, _, rows = validate_manifest(out, panel_out, ledger_out)
        ready_rows(db)
        stopped = db.execute("SELECT 1 FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone()
        if not stopped and any(not modern_eval.attempted(out, rows, row["run"]) for row in plan["runs"]):
            raise RuntimeError("First pass must finish or hit its cap before confirmation freezes")
        current = census_analysis.confirmation_plan(tasks, cfg["candidates"], normalized_results(out, rows, plan), cfg["experiment_id"])
        current["census_manifest_sha256"] = study.digest(manifest)
        if any(modern_eval.attempted(out, rows, row["run"]) for row in current["runs"]) and not (Path(out) / "confirmation-plan.json").exists():
            raise RuntimeError("Confirmation plan must freeze before repetition1")
        return frozen_write(Path(out) / "confirmation-plan.json", current)


def active_plan(out, manifest, cfg, plan, tasks, rows, phase):
    if phase == "census":
        if (Path(out) / "confirmation-plan.json").exists():
            raise RuntimeError("First pass is closed after confirmation freeze")
        return plan
    frozen = study.load(Path(out) / "confirmation-plan.json")
    expected = census_analysis.confirmation_plan(tasks, cfg["candidates"], normalized_results(out, rows, plan), cfg["experiment_id"])
    expected["census_manifest_sha256"] = study.digest(manifest)
    if frozen != expected:
        raise RuntimeError("Confirmation plan or bound first-pass results changed")
    repos = {task["instance_id"]: task["repo"] for task in tasks}
    return {**frozen, "runs": [{**row, "repo": repos[row["instance_id"]], "phase": "confirmation"} for row in frozen["runs"]]}


def check_batch(approval, batch_id, manifest, plan, pricing, phase, *, amendment=None):
    runs = approval.get("runs", [])
    order = [row["run"] for row in plan["runs"]]
    if not isinstance(runs, list) or not runs or runs[0] not in order:
        raise RuntimeError("Batch must contain a nonempty frozen run slice")
    start = order.index(runs[0])
    if runs != order[start:start + len(runs)]:
        raise RuntimeError("Batch is not a contiguous task-major slice")
    selected = [row for row in plan["runs"] if row["run"] in set(runs)]
    selected_tasks = {row["instance_id"] for row in selected}
    if [row["run"] for row in plan["runs"] if row["instance_id"] in selected_tasks] != runs:
        raise RuntimeError("Batches must align to entire task blocks")
    required = {"authorized": True, "action": "census-batch-v1", "phase": phase, "batch_id": batch_id, "census_manifest_sha256": study.digest(manifest), "plan_sha256": study.digest(plan), "pricing_sha256": study.digest(pricing), "source_sha256": source_hashes(), "accounting_authorization_sha256": manifest["original_metadata"].get("unknown_accounting_authorization_sha256"), "exclusion_manifest_sha256": manifest["exclusion_manifest_sha256"]}
    if amendment is not None:
        required.update(census_amendment_sha256=study.digest(amendment), resources=amendment["to_resources"])
    if any(approval.get(key) != value for key, value in required.items()):
        raise RuntimeError("Exact batch/plan/pricing/source/accounting/scope approval required")
    if not 0 <= time.time() - pricing["fetched_at"] <= modern_eval.PRICING_MAX_AGE_SECONDS:
        raise RuntimeError("Stale/future pricing; quote a new batch")
    return selected


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


def model_factory(out, run, candidate, deadline, *, cfg, ledger_out):
    shared_candidate = {**candidate, "context_length": cfg["max_input_tokens"] + cfg["max_output_tokens"]}
    return study.paid_model(out, run, shared_candidate, deadline, cfg=cfg, ledger_out=ledger_out, input_bounder=NativeInputBound(), reservation=reserve, transport_admission=dispatch_admission, state_guard=dispatch_guard)


def worker(out, ledger_out, task, private, candidate, row, approval, cfg, manifest, batch_id):
    with (Path(ledger_out) / ".writer.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        with sqlite3.connect(Path(ledger_out) / "budget.sqlite", timeout=60) as db:
            claim = db.execute("SELECT driver,state FROM census_claims WHERE run=?", (row["run"],)).fetchone()
            if claim != (cfg["driver_id"], "active"):
                return {"run": row["run"], "status": "interrupted"}
            if time.time() + cfg["lease_required_seconds"] > cfg["lease_deadline"]:
                db.execute("DELETE FROM census_claims WHERE run=?", (row["run"],))
                return {"run": row["run"], "status": "lease_checkpoint"}
        try:
            return modern_eval.rollout(out, ledger_out, task, private, candidate, row, approval, cfg, manifest, batch_id, model_factory=model_factory, classifier=classify)
        except modern_eval.RunStopped as error:
            return {"run": row["run"], "status": error.status}
        finally:
            with sqlite3.connect(Path(ledger_out) / "budget.sqlite", timeout=60) as db:
                db.execute("UPDATE census_claims SET state='finished' WHERE run=?", (row["run"],))


def run_batch(out, panel_out, ledger_out, batch_id, approval_path, lease_deadline, phase="census", concurrency=4, *, executor_factory=None, clock=time.time):
    if type(concurrency) is not int or not 1 <= concurrency <= 4:
        raise RuntimeError("Concurrency must be1..4")
    if isinstance(lease_deadline, bool) or not isinstance(lease_deadline, (int, float)) or not math.isfinite(lease_deadline):
        raise RuntimeError("Lease deadline must be a finite Unix epoch")
    out, panel_out, ledger_out = modern_eval.separate_roots(out, panel_out, ledger_out)
    if not os.environ.get("OPENROUTER_API_KEY"):
        raise RuntimeError("A host-only OpenRouter key is required before dispatch")
    with batch_writer(ledger_out):
        manifest, cfg, first, tasks, private, rows = validate_manifest(out, panel_out, ledger_out)
        plan = active_plan(out, manifest, cfg, first, tasks, rows, phase)
        directory = modern_eval.batch_directory(out, batch_id)
        pricing, cfg = shared_pricing(directory, cfg)
        approval = study.load(approval_path)
        _, amendment = active_amendment(out)
        selected = check_batch(approval, batch_id, manifest, plan, pricing, phase, amendment=amendment)
        driver_id = uuid.uuid4().hex
        cfg["driver_id"] = driver_id
        cfg["lease_deadline"] = lease_deadline
        required = cfg["wall_seconds"] + census_panel.config()["evaluator_timeout_seconds"] + modern_eval.LEASE_MARGIN_SECONDS
        cfg["lease_required_seconds"] = required
        completed, pending, stopped = [], {}, None
        factory = executor_factory or (lambda: ProcessPoolExecutor(max_workers=concurrency, mp_context=multiprocessing.get_context("spawn")))
        with factory() as executor:
            while True:
                while stopped is None and len(pending) < concurrency:
                    with dispatch_guard(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite", timeout=60) as db:
                        db.execute("BEGIN IMMEDIATE")
                        current_rows = ready_rows(db, driver_id)
                        metadata = cap_metadata(db)
                        full_caps = []
                        if sum((study.held_cost(row) for row in current_rows if row["run"].startswith(cfg["experiment_id"] + "--")), Decimal(0)) >= Decimal(metadata["census_cap_usd"]):
                            full_caps.append("experiment_money_reservation")
                        if Decimal(metadata["prior_committed_usd"]) + sum((study.held_cost(row) for row in current_rows), Decimal(0)) >= Decimal(metadata["total_cap_usd"]):
                            full_caps.append("aggregate_money_reservation")
                        if full_caps:
                            db.execute("INSERT OR IGNORE INTO census_stops VALUES (?,?,?)", (cfg["experiment_id"], json.dumps(full_caps), clock()))
                        stop = db.execute("SELECT caps FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone()
                        claims = {row[0] for row in db.execute("SELECT run FROM census_claims WHERE driver=?", (driver_id,))}
                        next_item = next((row for row in plan["runs"] if row["run"] not in claims and not modern_eval.attempted(out, current_rows, row["run"])), None)
                        if next_item is not None:
                            db.execute("DELETE FROM census_claims WHERE run=? AND driver<>?", (next_item["run"], driver_id))
                        if stop:
                            stopped = "cap"
                        elif next_item is None or next_item["run"] not in approval["runs"]:
                            stopped = "batch_complete"
                        elif clock() + required > lease_deadline:
                            stopped = "lease_checkpoint"
                        elif clock() - pricing["fetched_at"] > modern_eval.PRICING_MAX_AGE_SECONDS:
                            stopped = "pricing_expired"
                        else:
                            db.execute("INSERT INTO census_claims VALUES (?,?,'active',?)", (next_item["run"], driver_id, clock()))
                    if stopped is not None:
                        break
                    task = next(task for task in tasks if task["instance_id"] == next_item["instance_id"])
                    candidate = next(model for model in pricing["models"] if model["label"] == next_item["candidate"])
                    future = executor.submit(worker, out, ledger_out, task, private[task["instance_id"]], candidate, next_item, approval, cfg, manifest, batch_id)
                    pending[future] = next_item
                if not pending:
                    break
                finished, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in finished:
                    row = pending.pop(future)
                    try:
                        result = future.result()
                        completed.append(result)
                        if result["status"] in {"lease_checkpoint", "interrupted"}:
                            stopped = result["status"]
                    except Exception as error:
                        completed.append({"run": row["run"], "status": "infra_invalid", "error": str(error)})
                        stopped = "infra_invalid"
        return {"stopped": stopped, "completed": completed, "claimed": len(completed), "batch_tasks": len({row["instance_id"] for row in selected})}


def token_overrun_counts(out, rows, plans, candidates):
    settled = (load_amendment(out, OVERRUN_AMENDMENT) or {}).get("settlement", {}).get("request_id")
    counts = {}
    for phase, plan in plans.items():
        labels = {row["run"]: row["candidate"] for row in plan["runs"]}
        counts[phase] = {candidate["label"]: 0 for candidate in candidates}
        for row in rows:
            receipt = Path(row["receipt"])
            if row["run"] in labels and (row["id"] == settled or receipt.is_file() and study.load(receipt).get("token_estimate_overrun") is True):
                counts[phase][labels[row["run"]]] += 1
    return counts


def analyze(out, panel_out, ledger_out):
    with writer(ledger_out), sqlite3.connect(Path(ledger_out) / "budget.sqlite") as db:
        manifest, cfg, first, tasks, _, rows = validate_manifest(out, panel_out, ledger_out)
        frozen = active_plan(out, manifest, cfg, first, tasks, rows, "confirmation")
        capped = db.execute("SELECT 1 FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone() is not None
        if not capped and any(not modern_eval.attempted(out, rows, row["run"]) for row in frozen["runs"]):
            raise RuntimeError("Confirmation must finish or hit the shared census cap before final analysis")
        report = census_analysis.analyze(tasks, cfg["candidates"], normalized_results(out, rows, first), normalized_results(out, rows, frozen))
        report["census_manifest_sha256"] = study.digest(manifest)
        report["confirmation_plan_sha256"] = study.digest(study.load(Path(out) / "confirmation-plan.json"))
        report["capped"] = capped
        report["tokenEstimateOverruns"] = token_overrun_counts(out, rows, {"firstPass": first, "confirmation": frozen}, cfg["candidates"])
        report["scope"] = {"efficient": "three preregistered efficient candidates", "frontier": "two preregistered frontier candidates excluding Opus; not certification of the production Frontier pool", "combined": "five-model information-only comparison", "cumulative_token_cap": "non-binding 2**63-1; money and per-call/context/step/time limits remain binding"}
        study.save(Path(out) / "census-analysis.json", report)
        return report







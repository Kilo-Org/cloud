import argparse
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import time
import tempfile

# Legacy import ceiling recorded in old ledger metadata. It is audit metadata
# only and never by itself permission for new inference.
CAP = Decimal("250")
CANDIDATE_CAP = 10
SCHEMA = "router-campaign-ledger-v2"
# Programme policy ceiling for cumulative new inference. Historical totals are
# never constants: they derive from the immutable imported rows (origin snapshot).
MAX_CUMULATIVE_NEW_USD = Decimal("100")
PILOT_CAP_USD = Decimal("60")
RUN_CAP_USD = Decimal("60")
PROSPECTIVE_SCHEMA = "router-capped-exploration-allowance-v1"
AMENDMENT_SCHEMA = "router-capped-exploration-amendment-v1"
FINANCING_SCHEMA = "router-cost-forecast-v1"
# Stored v4 financing manifests stay readable for audit. They never authorize v5 dispatch.
LEGACY_FINANCING_SCHEMA = "router-financing-manifest-v1"
MANIFEST_VERSION = 5


def grant_tables(db):
    db.execute("CREATE TABLE IF NOT EXISTS campaign_prospective_grant (id TEXT PRIMARY KEY,approval_json TEXT NOT NULL,approval_bytes BLOB NOT NULL,approval_sha256 TEXT NOT NULL,historical_rows_json TEXT NOT NULL,created REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS campaign_prospective_candidates (grant_id TEXT NOT NULL,router TEXT NOT NULL CHECK(router IN ('efficient','frontier')),fingerprint TEXT UNIQUE NOT NULL,PRIMARY KEY(grant_id,router))")
    db.execute("CREATE TABLE IF NOT EXISTS campaign_prospective_amendments (id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,approval_json TEXT NOT NULL,approval_bytes BLOB NOT NULL,approval_sha256 TEXT NOT NULL,created REAL NOT NULL)")
    for table in ("campaign_prospective_grant", "campaign_prospective_candidates", "campaign_prospective_amendments"):
        for operation in ("UPDATE", "DELETE"):
            db.execute(f"CREATE TRIGGER IF NOT EXISTS {table}_no_{operation.lower()} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'append-only'); END")
    db.execute("CREATE TRIGGER IF NOT EXISTS campaign_one_grant BEFORE INSERT ON campaign_prospective_grant WHEN EXISTS (SELECT 1 FROM campaign_prospective_grant) BEGIN SELECT RAISE(ABORT,'prospective grant is create-only'); END")
    for operation in ("UPDATE", "DELETE"):
        db.execute(f"CREATE TRIGGER IF NOT EXISTS campaign_historical_no_{operation.lower()} BEFORE {operation} ON requests WHEN EXISTS (SELECT 1 FROM campaign_legacy_rows WHERE request_id=OLD.id) AND EXISTS (SELECT 1 FROM campaign_prospective_grant) BEGIN SELECT RAISE(ABORT,'historical commitments are immutable'); END")


def financing_tables(db):
    db.execute("CREATE TABLE IF NOT EXISTS campaign_financing_plans (sha256 TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,authorization_sha256 TEXT NOT NULL,financing_json TEXT NOT NULL,created REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS campaign_financing_rows (plan_sha256 TEXT NOT NULL,run TEXT NOT NULL,phase TEXT NOT NULL,envelope_usd TEXT NOT NULL,PRIMARY KEY(plan_sha256,run))")
    for table in ("campaign_financing_plans", "campaign_financing_rows"):
        for operation in ("UPDATE", "DELETE"):
            db.execute(f"CREATE TRIGGER IF NOT EXISTS {table}_no_{operation.lower()} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'append-only'); END")


def _table(db, name):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _amendments(db, grant_id):
    if not _table(db, "campaign_prospective_amendments"):
        return []
    result = []
    for identifier, approval_json, approval_bytes, approval_sha in db.execute("SELECT id,approval_json,approval_bytes,approval_sha256 FROM campaign_prospective_amendments WHERE grant_id=? ORDER BY created,id", (grant_id,)):
        if hashlib.sha256(approval_bytes).hexdigest() != approval_sha or json.loads(approval_bytes) != json.loads(approval_json):
            raise ValueError("Prospective amendment bytes no longer match their bound hash")
        result.append({**json.loads(approval_json), "approval_sha256": approval_sha})
    return result


def effective_authorization(db, grant_id=None):
    """One authorization view for freeze/validate/run/Budget.

    Origin is the immutable historical-row snapshot captured at grant time.
    Amendments only raise the cumulative new allowance; they never re-baseline
    the origin, so new spending before an amendment stays inside the allowance.
    """
    if not _table(db, "campaign_prospective_grant"):
        if grant_id is not None:
            raise ValueError("Prospective grant is missing")
        return None
    record = db.execute("SELECT id,approval_json,approval_bytes,historical_rows_json,approval_sha256 FROM campaign_prospective_grant").fetchone()
    if record is None:
        if grant_id is not None:
            raise ValueError("Prospective grant is missing")
        return None
    identifier, approval_json, approval_bytes, historical_json, approval_sha = record
    if grant_id is not None and identifier != grant_id:
        raise ValueError("Prospective grant identity changed")
    if hashlib.sha256(approval_bytes).hexdigest() != approval_sha or json.loads(approval_bytes) != json.loads(approval_json):
        raise ValueError("Prospective authorization bytes no longer match their bound hash")
    approval = json.loads(approval_json)
    historical = json.loads(historical_json)
    current = {row["id"]: row for row in rows(db)}
    if any(current.get(row["id"]) != row for row in historical):
        raise ValueError("Immutable historical commitment changed")
    origin = sum((held(row) for row in historical), Decimal(0))
    if money(approval["committed_upper_baseline_usd"]) != origin:
        raise ValueError("Grant baseline no longer equals its origin snapshot commitments")
    cumulative = money(approval["additional_cap_usd"])
    amendments = _amendments(db, identifier)
    prior_sha = approval_sha
    for amendment in amendments:
        if amendment.get("prior_approval_sha256") != prior_sha:
            raise ValueError("Prospective amendment chain does not bind its predecessor")
        raised = money(amendment["cumulative_additional_cap_usd"])
        if raised <= cumulative or raised > MAX_CUMULATIVE_NEW_USD:
            raise ValueError("Prospective amendment must only raise the cumulative allowance within the programme ceiling")
        cumulative, prior_sha = raised, amendment["approval_sha256"]
    if cumulative <= 0 or cumulative > MAX_CUMULATIVE_NEW_USD:
        raise ValueError("Cumulative new authorization is outside the programme ceiling")
    legacy = money(metadata(db)["total_cap_usd"])
    return {"grant_id": identifier, "approval_sha256": approval_sha, "effective_approval_sha256": prior_sha, "amendment_sha256": [item["approval_sha256"] for item in amendments], "amendments": amendments, "candidate_slots": approval["candidate_slots"], "historical_unknown_policy": approval["historical_unknown_policy"], "origin_commitments_usd": str(origin), "origin_snapshot_sha256": digest(historical), "committed_upper_baseline_usd": str(origin), "additional_cap_usd": str(cumulative), "cumulative_additional_cap_usd": str(cumulative), "legacy_total_cap_usd": str(legacy), "effective_ceiling_usd": str(min(legacy, origin + cumulative)), "historical_rows": historical, "approval": approval}


def authorization_summary(authorization):
    return {key: value for key, value in authorization.items() if key not in {"historical_rows", "approval", "amendments"}}


def prospective_grant(db, grant_id=None):
    authorization = effective_authorization(db, grant_id)
    if authorization is None:
        return None
    return {**authorization["approval"], "approval_sha256": authorization["approval_sha256"], "additional_cap_usd": authorization["additional_cap_usd"], "effective_approval_sha256": authorization["effective_approval_sha256"], "origin_snapshot_sha256": authorization["origin_snapshot_sha256"], "effective_ceiling_usd": authorization["effective_ceiling_usd"], "historical_rows": authorization["historical_rows"]}


def historical_commitment(db, row):
    grant = prospective_grant(db)
    return grant is not None and any(item == row for item in grant["historical_rows"])


def authorize(path, approval_path):
    content = Path(approval_path).read_bytes()
    approval = json.loads(content)
    expected = {"schema", "authorized", "action", "grant_id", "campaign_id", "inventory_sha256", "committed_upper_baseline_usd", "additional_cap_usd", "total_cap_usd", "candidate_slots", "historical_unknown_policy", "accepted_proposal", "user_response"}
    if not isinstance(approval, dict) or set(approval) != expected or approval["schema"] != PROSPECTIVE_SCHEMA or approval["authorized"] is not True or approval["action"] != "authorize-capped-exploration-router-study":
        raise ValueError("Exact parent prospective authorization required")
    if not isinstance(approval["grant_id"], str) or not approval["grant_id"] or any(not isinstance(approval[key], str) or not approval[key].strip() for key in ("accepted_proposal", "user_response")):
        raise ValueError("Grant identity and verbatim accepted proposal/user response required")
    if approval["candidate_slots"] != {"efficient": 1, "frontier": 1} or any(type(value) is not int for value in approval["candidate_slots"].values()) or approval["historical_unknown_policy"] != "immutable-funded-historical-commitments":
        raise ValueError("Authorize exactly one prospective candidate per mode without upgrading history")
    if any(not isinstance(approval[key], str) for key in ("committed_upper_baseline_usd", "additional_cap_usd", "total_cap_usd")):
        raise ValueError("Authorization money fields must be exact decimal strings")
    additional = money(approval["additional_cap_usd"])
    if additional <= 0 or additional > MAX_CUMULATIVE_NEW_USD:
        raise ValueError("Cumulative new authorization must be positive and within the programme ceiling")
    with sqlite3.connect(Path(path).resolve(strict=True), timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        values = metadata(db)
        if approval["campaign_id"] != values["campaign_id"] or approval["inventory_sha256"] != values["inventory_sha256"]:
            raise ValueError("Grant must bind the exact campaign and immutable inventory")
        if money(approval["total_cap_usd"]) != money(values["total_cap_usd"]):
            raise ValueError("Grant must retain the ledger legacy total cap as audit metadata, not permission")
        historical = rows(db)
        legacy_ids = {row[0] for row in db.execute("SELECT request_id FROM campaign_legacy_rows")}
        if {row["id"] for row in historical} != legacy_ids or db.execute("SELECT 1 FROM campaign_admissions").fetchone() or db.execute("SELECT 1 FROM campaign_candidates").fetchone() or db.execute("SELECT 1 FROM router_runs").fetchone():
            raise ValueError("Grant must precede every prospective freeze and admission")
        origin = sum((held(row) for row in historical), Decimal(0))
        if any(row["state"] not in {"settled", "unknown", "accounted_unknown"} for row in historical) or origin != money(approval["committed_upper_baseline_usd"]):
            raise ValueError("Historical settled-plus-held baseline must equal the imported origin rows exactly")
        grant_tables(db)
        if prospective_grant(db) is not None:
            raise ValueError("Prospective grant is create-only; never replay or increase it")
        db.execute("INSERT INTO campaign_prospective_grant VALUES (?,?,?,?,?,?)", (approval["grant_id"], json.dumps(approval, sort_keys=True), content, hashlib.sha256(content).hexdigest(), json.dumps(historical, sort_keys=True), time.time()))
        authorization = effective_authorization(db, approval["grant_id"])
    return {"prospective_grant_id": approval["grant_id"], **authorization_summary(authorization)}


@contextmanager
def writer_lock(ledger_path):
    """The one campaign .writer.lock, non-blocking like execute/finance.

    Raises ValueError immediately while another operator write holds it;
    never waits and never steals the lock.
    """
    lock_path = Path(ledger_path).resolve(strict=True).parent / ".writer.lock"
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError("Campaign writer lock is held by an active operator write; retry after it finishes") from error
        yield lock_path


def amend_authorization(path, amendment_path):
    """Append a cumulative-allowance amendment. Origin and slots never move."""
    content = Path(amendment_path).read_bytes()
    amendment = json.loads(content)
    expected = {"schema", "authorized", "action", "amendment_id", "grant_id", "prior_approval_sha256", "cumulative_additional_cap_usd", "candidate_slots", "accepted_proposal", "user_response"}
    if not isinstance(amendment, dict) or set(amendment) != expected or amendment["schema"] != AMENDMENT_SCHEMA or amendment["authorized"] is not True or amendment["action"] != "amend-capped-exploration-router-study-authorization":
        raise ValueError("Exact prospective authorization amendment required")
    if not isinstance(amendment["amendment_id"], str) or not amendment["amendment_id"] or not isinstance(amendment["grant_id"], str) or not amendment["grant_id"] or any(not isinstance(amendment[key], str) or not amendment[key].strip() for key in ("accepted_proposal", "user_response")):
        raise ValueError("Amendment identity and verbatim accepted proposal/user response required")
    if not isinstance(amendment["cumulative_additional_cap_usd"], str):
        raise ValueError("Amendment money fields must be exact decimal strings")
    cumulative = money(amendment["cumulative_additional_cap_usd"])
    if cumulative <= 0 or cumulative > MAX_CUMULATIVE_NEW_USD:
        raise ValueError("Amended cumulative authorization must stay within the programme ceiling")
    with writer_lock(path), sqlite3.connect(Path(path).resolve(strict=True), timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        grant_tables(db)
        current = effective_authorization(db, amendment["grant_id"])
        if current is None:
            raise ValueError("Prospective grant is missing")
        if amendment["prior_approval_sha256"] != current["effective_approval_sha256"]:
            raise ValueError("Amendment must bind the current effective authorization hash")
        if amendment["candidate_slots"] != current["candidate_slots"]:
            raise ValueError("Amendment must keep candidate slots unchanged")
        if cumulative <= money(current["cumulative_additional_cap_usd"]):
            raise ValueError("Amendment is cumulative: it may only raise the total new allowance, never add a second allowance or lower it")
        db.execute("INSERT INTO campaign_prospective_amendments VALUES (?,?,?,?,?,?)", (amendment["amendment_id"], amendment["grant_id"], json.dumps(amendment, sort_keys=True), content, hashlib.sha256(content).hexdigest(), time.time()))
        authorization = effective_authorization(db, amendment["grant_id"])
    return {"prospective_grant_id": amendment["grant_id"], "amendment_id": amendment["amendment_id"], **authorization_summary(authorization)}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def money(value):
    if value is None or isinstance(value, bool):
        raise ValueError("Missing money")
    try:
        amount = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError("Invalid money") from error
    if not amount.is_finite() or amount < 0:
        raise ValueError("Money must be finite and nonnegative")
    return amount


def held(row):
    bound = money(row["bound"])
    actual = None if row.get("actual") is None else money(row["actual"])
    if row["state"] == "settled":
        if actual is None:
            raise ValueError("Settled request is missing actual charge")
        return actual
    return max(bound, actual or Decimal(0))


@contextmanager
def readonly(path):
    path = Path(path).resolve(strict=True)
    wal = Path(str(path) + "-wal")
    with tempfile.TemporaryDirectory(prefix="router-ledger-read-") as temporary:
        if wal.exists():
            copy = Path(temporary) / path.name
            before = {suffix: Path(str(path) + suffix).read_bytes() for suffix in ("", "-wal", "-shm") if Path(str(path) + suffix).exists()}
            for suffix, content in before.items():
                Path(str(copy) + suffix).write_bytes(content)
            after = {suffix: Path(str(path) + suffix).read_bytes() for suffix in ("", "-wal", "-shm") if Path(str(path) + suffix).exists()}
            if before != after:
                raise ValueError("Source ledger changed while copying its read-only snapshot")
            uri = copy.as_uri() + "?mode=ro"
        else:
            uri = path.as_uri() + "?mode=ro"
        db = sqlite3.connect(uri, uri=True)
        try:
            yield db
        finally:
            db.close()


@contextmanager
def staged_campaign(campaign):
    campaign.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    partial = Path(tempfile.mkdtemp(prefix=f".{campaign.name}.", suffix=".partial", dir=campaign.parent))
    try:
        yield partial
        if campaign.exists():
            raise ValueError("Campaign import is create-only; never replace or reset a ledger")
        partial.rename(campaign)
    finally:
        if partial.exists():
            shutil.rmtree(partial)


def rows(db):
    cursor = db.execute("SELECT * FROM requests ORDER BY id")
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor]


def metadata(db):
    values = dict(db.execute("SELECT key,value FROM metadata"))
    if values.get("schema") != SCHEMA or values.get("total_cap_usd") != str(CAP) or values.get("candidate_cap") != str(CANDIDATE_CAP):
        raise ValueError("An imported v2 global campaign ledger with unchanged caps is required")
    return values


def synthetic_prior(row):
    return row["id"] in {"prior-v1-committed", "prior-committed"}


def import_campaign(campaign, inventory_path):
    campaign = Path(campaign).resolve()
    inventory_path = Path(inventory_path).resolve(strict=True)
    inventory_bytes = inventory_path.read_bytes()
    inventory = json.loads(inventory_bytes, parse_float=Decimal)
    required = {"campaign_id", "ledger_paths", "evidence_files", "candidate_observations", "historical_candidates_complete"}
    if set(inventory) != required or not isinstance(inventory["campaign_id"], str) or not inventory["campaign_id"]:
        raise ValueError("Exact campaign inventory required")
    if type(inventory["historical_candidates_complete"]) is not bool or not inventory["ledger_paths"] or not inventory["evidence_files"]:
        raise ValueError("Historical ledger and source evidence inventory is required")
    if campaign.exists():
        raise ValueError("Campaign import is create-only; never replace or reset a ledger")
    evidence = {str(inventory_path): {"sha256": hashlib.sha256(inventory_bytes).hexdigest(), "bytes": inventory_bytes}}
    for name in [*inventory["ledger_paths"], *inventory["evidence_files"]]:
        path = Path(name).resolve(strict=True)
        content = path.read_bytes()
        if str(path) in evidence and evidence[str(path)]["bytes"] != content:
            raise ValueError("Inventory or source evidence changed during import")
        evidence[str(path)] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": content}
    observations = inventory["candidate_observations"]
    if not isinstance(observations, list):
        raise ValueError("Candidate observations must be a list")
    for item in observations:
        if not isinstance(item, dict) or set(item) != {"evidence_file", "fingerprint"} or str(Path(item["evidence_file"]).resolve(strict=True)) not in evidence:
            raise ValueError("Every candidate observation needs immutable source evidence")
        fingerprint = item["fingerprint"]
        if fingerprint is not None:
            raise ValueError("Historical source provenance is unverified; import observations with fingerprint null, never promote old evidence")
    merged, occurrences, synthetic = {}, [], []
    receipt_locations = []
    for source in inventory["ledger_paths"]:
        path = Path(source).resolve(strict=True)
        wal = Path(str(path) + "-wal")
        wal_before = wal.read_bytes() if wal.is_file() else None
        if wal_before is not None:
            evidence[str(wal)] = {"sha256": hashlib.sha256(wal_before).hexdigest(), "bytes": wal_before}
        with readonly(path) as db:
            db.execute("BEGIN")
            legacy = rows(db)
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            kinds = dict(db.execute("SELECT id,kind FROM router_requests")) if "router_requests" in tables else {}
        wal_after = wal.read_bytes() if wal.is_file() else None
        if path.read_bytes() != evidence[str(path)]["bytes"] or wal_after != wal_before:
            raise ValueError("Historical ledger changed during read-only import")
        for row in legacy:
            request_id = row["id"]
            if not isinstance(request_id, str) or not request_id:
                raise ValueError("Real request ID required")
            if synthetic_prior(row):
                synthetic.append({"source": str(path), "row": row})
                continue
            held(row)
            for receipt_path in (Path(row.get("receipt") or ""), path.parent / "receipts" / f"{request_id}.json"):
                if receipt_path.is_file():
                    content = receipt_path.read_bytes()
                    evidence[str(receipt_path.resolve())] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": content}
                    receipt_locations.append((request_id, str(path), row.get("receipt", ""), str(receipt_path.resolve()), evidence[str(receipt_path.resolve())]["sha256"]))
                    break
            normalized = {"id": request_id, "run": row["run"], "bound": str(money(row["bound"])), "actual": None if row.get("actual") is None else str(money(row["actual"])), "tokens": row.get("tokens"), "state": row["state"], "receipt": row.get("receipt", ""), "token_bound": row.get("token_bound")}
            if normalized["state"] == "reserved":
                normalized["state"] = "unknown"
            previous = merged.get(request_id)
            if previous is None:
                merged[request_id] = normalized
            elif previous != normalized:
                if previous["run"] != normalized["run"]:
                    raise ValueError("Duplicate real request ID belongs to different runs")
                known = [value for value in (previous, normalized) if value["state"] == "settled"]
                actuals = {money(value["actual"]) for value in known}
                if len(actuals) > 1:
                    raise ValueError("Conflicting settled actual charges for one request")
                # Conflicting historical states cannot erase a full unknown hold.
                if previous["state"] != normalized["state"] or held(previous) != held(normalized):
                    merged[request_id] = {**previous, "bound": str(max(held(previous), held(normalized), money(previous["bound"]), money(normalized["bound"]))), "actual": None, "state": "unknown"}
            occurrences.append((request_id, str(path), json.dumps(row, sort_keys=True), kinds.get(request_id, "unknown")))
    kinds = {}
    for request_id, _, _, kind in occurrences:
        if kind == "unknown":
            continue
        if kind not in {"solver", "classifier"}:
            raise ValueError("Invalid legacy request kind")
        if request_id in kinds and kinds[request_id] != kind:
            raise ValueError("Conflicting request kind")
        kinds[request_id] = kind
    with staged_campaign(campaign) as partial:
        report = build_campaign(partial, inventory, inventory_path, evidence, merged, occurrences, receipt_locations, kinds, observations, synthetic)
    return report


def build_campaign(campaign, inventory, inventory_path, evidence, merged, occurrences, receipt_locations, kinds, observations, synthetic):
    ledger = campaign / "budget.sqlite"
    with sqlite3.connect(ledger) as db:
        db.executescript("""
CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE requests (id TEXT PRIMARY KEY,run TEXT NOT NULL,bound TEXT NOT NULL,actual TEXT,tokens INTEGER,state TEXT NOT NULL,receipt TEXT NOT NULL,token_bound INTEGER);
CREATE TABLE router_requests (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK (kind IN ('solver','classifier')));
CREATE TABLE router_runs (run TEXT PRIMARY KEY,phase TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL);
CREATE TABLE router_stop (id TEXT PRIMARY KEY,phase TEXT,reason TEXT NOT NULL,created REAL NOT NULL);
CREATE TABLE router_accounting (request_id TEXT PRIMARY KEY,old_row_json TEXT NOT NULL,new_row_json TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,at REAL NOT NULL);
CREATE TABLE router_stop_cleared (stop_reason_rowids TEXT NOT NULL,reason TEXT NOT NULL,at REAL NOT NULL);
CREATE TABLE campaign_sources (path TEXT PRIMARY KEY,sha256 TEXT NOT NULL,bytes BLOB NOT NULL);
CREATE TABLE campaign_legacy_rows (request_id TEXT NOT NULL,source TEXT NOT NULL,row_json TEXT NOT NULL,kind TEXT NOT NULL);
CREATE TABLE campaign_receipt_locations (request_id TEXT NOT NULL,source TEXT NOT NULL,original_path TEXT NOT NULL,evidence_path TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TABLE campaign_candidates (fingerprint TEXT PRIMARY KEY,identity_json TEXT NOT NULL,created REAL NOT NULL);
CREATE TABLE campaign_candidate_observations (evidence_file TEXT NOT NULL,fingerprint TEXT);
CREATE TABLE campaign_manifests (sha256 TEXT PRIMARY KEY,out_root TEXT UNIQUE NOT NULL,manifest_json TEXT NOT NULL);
CREATE TABLE campaign_admissions (run TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,maximum_usd TEXT NOT NULL,attempt_key TEXT UNIQUE NOT NULL);
""")
        complete = inventory["historical_candidates_complete"] and not merged and not observations
        values = {"schema": SCHEMA, "campaign_id": inventory["campaign_id"], "inventory_sha256": evidence[str(inventory_path)]["sha256"], "historical_candidates_complete": str(complete).lower(), "total_cap_usd": str(CAP), "study_cap_usd": str(CAP), "candidate_cap": str(CANDIDATE_CAP), "prior_committed_usd": "0", "prior_unknown_bound_usd": "0", "prior_unknown_included": "true"}
        db.executemany("INSERT INTO metadata VALUES (?,?)", values.items())
        db.executemany("INSERT INTO campaign_sources VALUES (?,?,?)", ((name, value["sha256"], value["bytes"]) for name, value in evidence.items()))
        db.executemany("INSERT INTO requests VALUES (:id,:run,:bound,:actual,:tokens,:state,:receipt,:token_bound)", merged.values())
        db.executemany("INSERT INTO campaign_legacy_rows VALUES (?,?,?,?)", occurrences)
        db.executemany("INSERT INTO campaign_receipt_locations VALUES (?,?,?,?,?)", receipt_locations)
        db.executemany("INSERT INTO router_requests VALUES (?,?)", kinds.items())
        db.executemany("INSERT INTO campaign_candidate_observations VALUES (?,?)", ((str(Path(item["evidence_file"]).resolve()), item["fingerprint"]) for item in observations))
        synthetic_bytes = json.dumps(synthetic, sort_keys=True, separators=(",", ":")).encode()
        db.execute("INSERT INTO campaign_sources VALUES (?,?,?)", ("synthetic-prior-exclusions.json", hashlib.sha256(synthetic_bytes).hexdigest(), synthetic_bytes))
        for table in ("metadata", "campaign_sources", "campaign_legacy_rows", "campaign_receipt_locations", "campaign_candidates", "campaign_candidate_observations", "campaign_manifests", "campaign_admissions", "router_requests", "router_stop", "router_accounting", "router_stop_cleared"):
            for operation in ("UPDATE", "DELETE"):
                db.execute(f"CREATE TRIGGER {table}_no_{operation.lower()} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'append-only'); END")
        db.execute("CREATE TRIGGER router_runs_no_delete BEFORE DELETE ON router_runs BEGIN SELECT RAISE(ABORT,'attempts are permanent'); END")
    ledger.chmod(0o600)
    return audit(ledger)


def candidate_state(db):
    values = metadata(db)
    known = db.execute("SELECT COUNT(*) FROM campaign_candidates").fetchone()[0]
    uncertain = db.execute("SELECT COUNT(*) FROM campaign_candidate_observations WHERE fingerprint IS NULL").fetchone()[0]
    return {"registered": known, "unverified_candidate_observations": uncertain, "historical_distinct_candidates": None if uncertain or values["historical_candidates_complete"] != "true" else 0, "candidate_history_complete": values["historical_candidates_complete"] == "true", "cap": CANDIDATE_CAP}


def admission_block(db):
    grant = prospective_grant(db)
    if grant is not None:
        candidates = list(db.execute("SELECT router,fingerprint FROM campaign_prospective_candidates WHERE grant_id=?", (grant["grant_id"],)))
        return "prospective_candidate_cap" if len(candidates) > 2 else None
    state = candidate_state(db)
    if not state["candidate_history_complete"] or state["unverified_candidate_observations"]:
        return "historical_candidate_uncertainty"
    if state["registered"] > CANDIDATE_CAP:
        return "global_candidate_cap"
    return None


def register(db, manifest, candidates):
    values = metadata(db)
    state = candidate_state(db)
    new = {digest(identity): identity for identity in candidates}
    existing = {row[0] for row in db.execute("SELECT fingerprint FROM campaign_candidates")}
    grant = prospective_grant(db)
    if grant is not None:
        if manifest.get("version") != MANIFEST_VERSION or manifest.get("spec", {}).get("prospective_grant_id") != grant["grant_id"] or len(candidates) != 2 or {item.get("router") for item in candidates} != {"efficient", "frontier"}:
            raise ValueError("Prospective manifest requires exactly one grant-bound candidate per mode")
        registered = dict(db.execute("SELECT router,fingerprint FROM campaign_prospective_candidates WHERE grant_id=?", (grant["grant_id"],)))
        for fingerprint, identity in new.items():
            if identity["router"] in registered and registered[identity["router"]] != fingerprint:
                raise ValueError("Prospective mode slot already contains a different immutable fingerprint")
        for fingerprint, identity in new.items():
            db.execute("INSERT OR IGNORE INTO campaign_prospective_candidates VALUES (?,?,?)", (grant["grant_id"], identity["router"], fingerprint))
    elif admission_block(db) or len(existing | new.keys()) > CANDIDATE_CAP:
        raise ValueError("Historical candidate uncertainty or exhausted global candidate cap blocks new freezes")
    manifest_hash = digest(manifest)
    db.executemany("INSERT OR IGNORE INTO campaign_candidates VALUES (?,?,?)", ((fingerprint, json.dumps(identity, sort_keys=True), time.time()) for fingerprint, identity in new.items()))
    db.execute("INSERT INTO campaign_manifests VALUES (?,?,?)", (manifest_hash, manifest["out_root"], json.dumps(manifest, sort_keys=True)))
    return {"campaign_id": values["campaign_id"], "candidate_fingerprints": sorted(new), "registered_before": state["registered"]}


def plan_liability(db, pending=None):
    """Incurred liability under capped exploration.

    Only settled plus held requests count, plus one hypothetical next
    reservation in `pending`=(run, amount). Forecasts and unused future
    envelopes are not incurred commitments. Each forecast is reported by
    its own identity, never as a blend of historical plans.
    """
    settled_held = sum((held(row) for row in rows(db)), Decimal(0))
    if pending is not None:
        settled_held += money(pending[1])
    return {"settled_plus_held_usd": settled_held, "total_liability_usd": settled_held}


def check_financing_fits(db, pending=None):
    """True when incurred commitments plus `pending` fit the effective ceiling.

    Forecast size never decides fit. A request must fit the incurred
    allowance independently of the complete plan's cost forecast.
    """
    authorization = effective_authorization(db)
    if authorization is None:
        raise ValueError("Paid dispatch requires a prospective authorization")
    liability = plan_liability(db, pending)
    ceiling = money(authorization["effective_ceiling_usd"])
    return {"fits": liability["total_liability_usd"] <= ceiling, "effective_ceiling_usd": str(ceiling), **{key: str(value) for key, value in liability.items() if key.endswith("_usd")}}


def _registered_plan(db, financing):
    """Load the registered manifest and its frozen execution plan, hash-checked."""
    manifest_sha = financing.get("manifest_sha256")
    if not isinstance(manifest_sha, str):
        raise ValueError("Cost forecast must bind a registered campaign manifest")
    record = db.execute("SELECT out_root,manifest_json FROM campaign_manifests WHERE sha256=?", (manifest_sha,)).fetchone()
    if record is None:
        raise ValueError("Cost forecast must bind a registered campaign manifest")
    out_root, manifest_json = record
    manifest = json.loads(manifest_json)
    if digest(manifest) != manifest_sha or not isinstance(manifest, dict):
        raise ValueError("Registered campaign manifest no longer matches its hash")
    if manifest.get("out_root") is not None and manifest["out_root"] != out_root:
        raise ValueError("Registered campaign manifest out_root binding changed")
    plan_sha = financing.get("execution_plan_sha256")
    approval = manifest.get("approval") if isinstance(manifest.get("approval"), dict) else {}
    if not isinstance(plan_sha, str) or approval.get("execution_plan_sha256") != plan_sha:
        raise ValueError("Cost forecast execution plan hash must equal the registered manifest approval hash")
    try:
        plan = json.loads((Path(out_root) / "execution-plan.json").read_text())
    except (OSError, ValueError) as error:
        raise ValueError("Frozen execution plan file is missing or unreadable") from error
    if not isinstance(plan, dict) or digest(plan) != plan_sha:
        raise ValueError("Frozen execution plan file no longer matches the approved plan hash")
    runs = plan.get("runs")
    if not isinstance(runs, list) or not runs or any(not isinstance(row, dict) for row in runs):
        raise ValueError("Frozen execution plan has no mandatory runs")
    expected = []
    for row in runs:
        identity = tuple(row.get(key) for key in ("run", "phase", "arm_id", "router"))
        if any(not isinstance(value, str) or not value for value in identity) or row.get("phase") not in {"pilot", "final"}:
            raise ValueError("Frozen execution plan row lacks its run, phase, arm or mode identity")
        expected.append(identity)
    if len({item[0] for item in expected}) != len(expected):
        raise ValueError("Frozen execution plan repeats a run identity")
    return manifest, plan, expected


def _validate_financing_rows(financing, manifest, expected):
    rows = financing["rows"]
    supplied = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Cost forecast rows must be objects")
        identity = tuple(row.get(key) for key in ("run", "phase", "arm_id", "router"))
        if any(not isinstance(value, str) or not value for value in identity):
            raise ValueError("Cost forecast rows must name each mandatory run, phase, arm and mode")
        supplied.append(identity)
    if supplied != expected:
        raise ValueError("Cost forecast rows must exactly cover every frozen plan run in plan order, with matching phase, arm and mode")
    if financing.get("forecast_only") is not True:
        raise ValueError("Cost forecast must state that it carries no full-plan funding guarantee")
    resources = financing.get("resources") if isinstance(financing.get("resources"), dict) else {}
    if not isinstance(resources.get("run_cost_limit_usd"), str):
        raise ValueError("Cost forecast must bind the unchanged per-run resource cap")
    resource_cap = money(resources["run_cost_limit_usd"])
    if resource_cap <= 0 or resource_cap > RUN_CAP_USD:
        raise ValueError("Cost forecast per-run resource cap must stay within the per-run ceiling")
    spec = manifest.get("spec") if isinstance(manifest.get("spec"), dict) else {}
    spec_resources = spec.get("resources") if isinstance(spec.get("resources"), dict) else {}
    if "run_cost_limit_usd" in spec_resources and money(spec_resources["run_cost_limit_usd"]) != resource_cap:
        raise ValueError("Cost forecast resource cap differs from the frozen manifest resource cap")
    total, pilot_total = Decimal(0), Decimal(0)
    for row in rows:
        envelope, proved, cap = money(row.get("envelope_usd")), money(row.get("proved_envelope_usd")), money(row.get("resource_cap_usd"))
        if cap != resource_cap or envelope != min(proved, cap):
            raise ValueError("Each forecast envelope must equal min(proved bound, unchanged resource cap)")
        total += envelope
        if row["phase"] == "pilot":
            pilot_total += envelope
    if money(financing.get("total_envelope_usd")) != total:
        raise ValueError("Forecast total must equal the sum of every mandatory row envelope")
    if not isinstance(financing.get("pilot_cap_usd"), str) or not isinstance(financing.get("pilot_envelope_usd"), str) or money(financing["pilot_envelope_usd"]) != pilot_total or money(financing["pilot_cap_usd"]) <= 0 or money(financing["pilot_cap_usd"]) > PILOT_CAP_USD:
        raise ValueError("Forecast pilot envelopes must sum exactly under a frozen pilot cap within the pilot ceiling")
    if "pilot_cap_usd" in spec and money(spec["pilot_cap_usd"]) != money(financing["pilot_cap_usd"]):
        raise ValueError("Forecast pilot cap differs from the frozen manifest pilot cap")
    return total


def register_financing(db, financing):
    """Register one hash-bound whole-plan cost forecast. Caller holds BEGIN IMMEDIATE.

    The forecast must price every mandatory row. Its total and its pilot
    total may exceed the cumulative allowance and the pilot cap. Dispatch
    stops at the caps instead, and a stopped plan is inconclusive.
    """
    financing_tables(db)
    if not isinstance(financing, dict) or financing.get("schema") != FINANCING_SCHEMA or not isinstance(financing.get("rows"), list) or not financing["rows"]:
        raise ValueError("Exact whole-plan cost forecast required")
    manifest_sha = financing.get("manifest_sha256")
    manifest, _plan, expected = _registered_plan(db, financing)
    if manifest.get("version") != MANIFEST_VERSION:
        raise ValueError("Cost forecast requires a version5 manifest; old manifests are audit-only")
    authorization = effective_authorization(db, financing.get("authorization", {}).get("grant_id") if isinstance(financing.get("authorization"), dict) else None)
    if authorization is None or financing["authorization"] != authorization_summary(authorization):
        raise ValueError("Cost forecast must bind the current effective authorization and origin snapshot")
    forecast_total = _validate_financing_rows(financing, manifest, expected)
    plan_sha = digest(financing)
    existing = db.execute("SELECT financing_json FROM campaign_financing_plans WHERE sha256=?", (plan_sha,)).fetchone()
    if existing is not None:
        if json.loads(existing[0]) != financing:
            raise ValueError("Cost forecast hash collision")
    else:
        db.execute("INSERT INTO campaign_financing_plans VALUES (?,?,?,?,?)", (plan_sha, manifest_sha, authorization["effective_approval_sha256"], json.dumps(financing, sort_keys=True), time.time()))
        db.executemany("INSERT INTO campaign_financing_rows VALUES (?,?,?,?)", ((plan_sha, row["run"], row["phase"], str(money(row["envelope_usd"]))) for row in financing["rows"]))
    fits = check_financing_fits(db)
    allowance = max(Decimal(0), money(authorization["effective_ceiling_usd"]) - money(authorization["origin_commitments_usd"]))
    return {"financing_sha256": plan_sha, **fits, "forecast_total_usd": str(forecast_total), "forecast_exceeds_allowance": forecast_total > allowance, "forecast_pilot_usd": financing["pilot_envelope_usd"], "funding_guarantee": "none; capped exploration may stop inconclusive"}


def _revalidate_financing(db, financing_sha, financing, manifest_sha, authorization_sha):
    """Reject stale financing under the caller's transaction.

    The stored financing must still bind its hash, its registered manifest,
    its registered rows and the CURRENT effective authorization. Any grant
    amendment after registration makes earlier financing stale here, even
    though the immutable financing record itself is preserved for audit.
    """
    if financing.get("schema") != FINANCING_SCHEMA or financing.get("forecast_only") is not True:
        raise ValueError("Stored financing evidence is audit-only; register a version5 cost forecast before dispatch")
    if financing.get("manifest_sha256") != manifest_sha:
        raise ValueError("Registered cost forecast manifest binding changed")
    stored_rows = {}
    for run, phase, envelope in db.execute("SELECT run,phase,envelope_usd FROM campaign_financing_rows WHERE plan_sha256=?", (financing_sha,)):
        if run in stored_rows:
            raise ValueError("Registered financing repeats a run row")
        stored_rows[run] = (phase, money(envelope))
    supplied_rows = {row.get("run"): (row.get("phase"), money(row.get("envelope_usd"))) for row in financing.get("rows") or [] if isinstance(row, dict)}
    if stored_rows != supplied_rows or len(stored_rows) != len(financing.get("rows") or []):
        raise ValueError("Registered financing rows no longer match the financing manifest")
    grant_id = financing.get("authorization", {}).get("grant_id") if isinstance(financing.get("authorization"), dict) else None
    current = effective_authorization(db, grant_id)
    if current is None or financing.get("authorization") != authorization_summary(current) or authorization_sha != current["effective_approval_sha256"]:
        raise ValueError("Registered cost forecast authorization is stale; register a new forecast under the current effective authorization")
    return financing


def financing_for(db, financing_sha):
    """Registered financing by hash, or None if absent. Raises if stale.

    Safe to call inside any claim/reserve/admission transaction: it reads
    the current effective authorization from the same DB handle and rejects
    financing bound to any earlier authorization.
    """
    if not _table(db, "campaign_financing_plans"):
        return None
    record = db.execute("SELECT manifest_sha256,authorization_sha256,financing_json FROM campaign_financing_plans WHERE sha256=?", (financing_sha,)).fetchone()
    if record is None:
        return None
    manifest_sha, authorization_sha, financing_json = record
    financing = json.loads(financing_json)
    if digest(financing) != financing_sha:
        raise ValueError("Registered financing no longer matches its hash")
    return _revalidate_financing(db, financing_sha, financing, manifest_sha, authorization_sha)


def require_current_financing(db, financing_sha):
    """Like financing_for, but a missing plan is also an admission failure."""
    financing = financing_for(db, financing_sha)
    if financing is None:
        raise ValueError("Paid dispatch requires a registered whole-plan cost forecast")
    return financing


def audit(path):
    with readonly(path) as db:
        values = metadata(db)
        requests = rows(db)
        candidates = candidate_state(db)
        block = admission_block(db)
        grant = prospective_grant(db)
        authorization = effective_authorization(db)
        liability = None if authorization is None else check_financing_fits(db)
        forecasts = []
        if _table(db, "campaign_financing_plans"):
            for sha, financing_json in db.execute("SELECT sha256,financing_json FROM campaign_financing_plans ORDER BY created,sha256"):
                stored = json.loads(financing_json)
                try:
                    executable = financing_for(db, sha) is not None
                except ValueError:
                    executable = False
                forecasts.append({"sha256": sha, "schema": stored.get("schema"), "hash_matches": digest(stored) == sha, "total_envelope_usd": stored.get("total_envelope_usd"), "executable_for_v5": executable})
        source_hashes = {name: sha for name, sha in db.execute("SELECT path,sha256 FROM campaign_sources")}
        attributed = dict(db.execute("SELECT id,kind FROM router_requests"))
        receipt_locations = [{"request_id": request_id, "source": source, "original_path": original, "evidence_path": evidence, "sha256": sha} for request_id, source, original, evidence, sha in db.execute("SELECT * FROM campaign_receipt_locations ORDER BY source,request_id")]
    settled = sum((money(row["actual"]) for row in requests if row["state"] == "settled"), Decimal(0))
    upper = sum((held(row) for row in requests), Decimal(0))
    accounting = None
    if authorization is not None:
        origin = money(authorization["origin_commitments_usd"])
        cumulative = money(authorization["cumulative_additional_cap_usd"])
        new_upper = upper - origin
        legacy_ceiling = money(authorization["legacy_total_cap_usd"])
        effective_remaining = max(Decimal(0), min(cumulative - new_upper, legacy_ceiling - upper))
        accounting = {"historical_origin_commitments_usd": str(origin), "new_settled_plus_held_usd": str(new_upper), "cumulative_authorized_new_usd": str(cumulative), "unused_authorization_usd": str(effective_remaining), "effective_campaign_ceiling_usd": authorization["effective_ceiling_usd"], "legacy_total_cap_usd": authorization["legacy_total_cap_usd"], "whole_plan_liability": liability}
    return {"schema": SCHEMA, "campaign_id": values["campaign_id"], "inventory_sha256": values["inventory_sha256"], "settled_actual_usd": str(settled), "settled_plus_held_usd": str(upper), "unsettled_upper_usd": str(upper - settled), "requests": len(requests), "unattributed_request_ids": [row["id"] for row in requests if row["id"] not in attributed], "receipt_locations_count": len(receipt_locations), "receipt_locations_sha256": digest(receipt_locations), "candidates": candidates, "admission_block": block, "source_sha256": source_hashes, "historical_evidence_can_establish_pass": False, "capped_exploration": {"cumulative_new_ceiling_usd": str(MAX_CUMULATIVE_NEW_USD), "pilot_ceiling_usd": str(PILOT_CAP_USD), "run_ceiling_usd": str(RUN_CAP_USD), "liability_basis": "settled plus held incurred commitments only; forecast envelopes and unattempted rows excluded", "funding_guarantee": "none; capped exploration may stop inconclusive"}, "cost_forecasts": forecasts, "prospective_grant": None if grant is None else {key: value for key, value in grant.items() if key != "historical_rows"}, "effective_authorization": None if authorization is None else authorization_summary(authorization), "authorization_accounting": accounting}


def main():
    parser = argparse.ArgumentParser(description="Offline create-only import and read-only audit of one global router campaign")
    subs = parser.add_subparsers(dest="command", required=True)
    sub = subs.add_parser("import")
    sub.add_argument("--campaign", type=Path, required=True)
    sub.add_argument("--inventory", type=Path, required=True)
    sub = subs.add_parser("authorize")
    sub.add_argument("--ledger", type=Path, required=True)
    sub.add_argument("--approval", type=Path, required=True)
    sub = subs.add_parser("amend")
    sub.add_argument("--ledger", type=Path, required=True)
    sub.add_argument("--approval", type=Path, required=True)
    sub = subs.add_parser("audit")
    sub.add_argument("--ledger", type=Path, required=True)
    args = parser.parse_args()
    result = import_campaign(args.campaign, args.inventory) if args.command == "import" else authorize(args.ledger, args.approval) if args.command == "authorize" else amend_authorization(args.ledger, args.approval) if args.command == "amend" else audit(args.ledger)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

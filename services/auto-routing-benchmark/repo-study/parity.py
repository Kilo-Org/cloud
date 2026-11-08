
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
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

import census
import census_analysis
import census_panel
import modern_eval
import study

HERE = Path(__file__).resolve().parent
MANIFEST = "parity-manifest-v1.json"
EXPERIMENT_ID = "router-production-parity-20261029-v1"
FREEZE_ACTION = "freeze-parity-v1"
BATCH_ACTION = "parity-batch-v1"
SOURCE_FILES = census.SOURCE_FILES + ("parity.py",)
ARMS = [
    {"label": "efficient-deepseek-flash", "model": "deepseek/deepseek-v4.1-flash-1017", "effort": "max"},
    {"label": "frontier-terra", "model": "openai/gpt-6.1-terra", "effort": "low"},
]
POOLS = {"efficient": ("efficient-deepseek-flash", "efficient-grok"), "frontier": ("frontier-terra", "frontier-kimi")}
PICKS = [pick for pick, _ in POOLS.values()]
CAPS = {"aggregate_cap_usd": "250", "experiment_cap_usd": "70", "per_run_cap_usd": "3"}
LABELS = {"not_worse": "lower bound of (pick - best fixed) > -0.10", "worse": "upper bound of (pick - best fixed) < 0", "inconclusive": "otherwise"}
NOT_WORSE_LOWER = -0.10
GLOBAL_CAPS = {"experiment_money_reservation", "aggregate_money_reservation"}
SCHEDULE_KEYS = {"utc_days", "utc_start", "utc_end"}
WEEKDAYS = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
AMENDMENT = "parity-amendment-v1.json"
AMEND_ACTION = "amend-parity-deepseek-routing-v1"
ROUTED_ARM = "efficient-deepseek-flash"
LISTING_POLICY = "parity-listing-price-cap-v1"
RERUN_STATUSES = {"provider_unavailable", "transport_unknown", "infra_invalid"}


def source_hashes():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def separate_roots(out, census_out, panel_out, ledger_out):
    roots = [Path(path).resolve(strict=True) for path in (out, census_out, panel_out, ledger_out)]
    if any(first == second or first.is_relative_to(second) or second.is_relative_to(first) for index, first in enumerate(roots) for second in roots[index + 1:]):
        raise RuntimeError("Parity, census, panel and authoritative ledger roots must be separate")
    if (roots[0] / "budget.sqlite").exists():
        raise RuntimeError("Parity root may not hold a second ledger")
    return roots


def schedule_free_tier(tier):
    if not isinstance(tier, dict):
        raise RuntimeError("Invalid pricing tier")
    days = tier.get("utc_days")
    if "utc_days" in tier and (not isinstance(days, list) or not days or len(set(days)) != len(days) or any(day not in WEEKDAYS for day in days)):
        raise RuntimeError("Invalid pricing tier weekday schedule")
    for key in ("utc_start", "utc_end"):
        if key in tier and (type(tier[key]) is not int or not 0 <= tier[key] <= 2400):
            raise RuntimeError("Invalid pricing tier time schedule")
    return {key: value for key, value in tier.items() if key not in SCHEDULE_KEYS}


def scheduled_effective_prices(pricing, effective_prices):
    base = schedule_free_tier(pricing)
    if "overrides" in pricing:
        if not isinstance(pricing["overrides"], list):
            raise RuntimeError("Invalid pricing override tiers")
        base["overrides"] = [schedule_free_tier(tier) for tier in pricing["overrides"]]
    return effective_prices(base)


@contextmanager
def scheduled_tier_pricing():
    original = study.effective_prices
    study.effective_prices = lambda pricing: scheduled_effective_prices(pricing, original)
    try:
        yield
    finally:
        study.effective_prices = original


def eligible_endpoints(endpoints, cfg):
    eligible = []
    for endpoint in endpoints:
        if endpoint.get("status") != 0 or not {"reasoning", "max_tokens"}.issubset(endpoint.get("supported_parameters", [])):
            continue
        if (endpoint.get("context_length") or 0) < cfg["max_input_tokens"] + cfg["max_output_tokens"] or (endpoint.get("max_completion_tokens") or 0) < cfg["max_output_tokens"]:
            continue
        if endpoint.get("max_prompt_tokens") is not None and endpoint["max_prompt_tokens"] < cfg["max_input_tokens"]:
            continue
        eligible.append(endpoint)
    return eligible


def listing_cap(pricing):
    if not isinstance(pricing, dict) or not isinstance(pricing.get("overrides", []), list):
        raise RuntimeError("Invalid model listing pricing")
    scheduled_effective_prices(pricing, study.effective_prices)
    tiers = [schedule_free_tier(pricing), *[schedule_free_tier(tier) for tier in pricing.get("overrides", [])]]
    if "prompt" not in tiers[0] or "completion" not in tiers[0]:
        raise RuntimeError("Model listing lacks base prompt/completion prices")
    prompt = max(study.rate(tier["prompt"]) for tier in tiers if "prompt" in tier)
    completion = max(study.rate(tier["completion"]) for tier in tiers if "completion" in tier)
    if prompt <= 0 or completion <= 0:
        raise RuntimeError("Model listing prices must be positive")
    return prompt, completion


def listing_ceiling(listing_pricing, endpoints, cfg):
    route_prompt, route_completion = listing_cap(listing_pricing)
    eligible = eligible_endpoints(endpoints, cfg)
    selected = [endpoint for endpoint in eligible if all(price <= cap for price, cap in zip(study.base_prices(endpoint["pricing"]), (route_prompt, route_completion)))]
    if not selected:
        raise RuntimeError("No current active endpoint meets the public constraints within the listing-price cap")
    tags = sorted(endpoint["tag"] for endpoint in selected)
    reachable = [endpoint for endpoint in endpoints if endpoint.get("status") == 0 and any(endpoint["tag"] == tag or endpoint["tag"].startswith(tag + "/") for tag in tags) and all(price <= cap for price, cap in zip(study.base_prices(endpoint["pricing"]), (route_prompt, route_completion)))]
    prices = [(route_prompt, route_completion), *(scheduled_effective_prices(endpoint["pricing"], study.effective_prices) for endpoint in reachable)]
    return {"policy": study.FINANCIAL_QUOTE_POLICY, "parity_routing_policy": LISTING_POLICY, "prompt_per_token": str(max(price[0] for price in prices)), "completion_per_token": str(max(price[1] for price in prices)), "routing_prompt_per_token": str(route_prompt), "routing_completion_per_token": str(route_completion), "routing_max_price": {"prompt": study.routing_number(route_prompt), "completion": study.routing_number(route_completion), "request": 0, "image": 0}, "routing_witness": {"selection": "advertised model listing price, maximum over scheduled tiers"}, "eligible_endpoint_tags": tags, "financial_endpoint_tags": sorted(endpoint["tag"] for endpoint in reachable), "public_constraints": {"input_bound": cfg["max_input_tokens"], "max_tokens": cfg["max_output_tokens"], "required_parameters": ["reasoning", "max_tokens"], "status": 0}, "selector_closure": "every active endpoint matching an only-selector tag, including descendants, within the listing-price cap"}


def validate_authorizations(preregistration_raw, budget_raw):
    preregistration, budget = json.loads(preregistration_raw), json.loads(budget_raw)
    arms = preregistration.get("arms")
    if preregistration.get("schema") != "router-production-parity-v1" or not isinstance(arms, list) or [{key: arm.get(key) for key in ("label", "model", "effort")} for arm in arms] != ARMS or [arm.get("pool") for arm in arms] != list(POOLS):
        raise RuntimeError("Preregistration must name exactly the two production-pick arms")
    if any("opus" in f"{arm['label']} {arm['model']}".lower() for arm in arms) or "including Opus" not in preregistration.get("not_authorized", []):
        raise RuntimeError("Opus is outside the parity scope")
    baselines = preregistration.get("baselines") or {}
    if any(str(baselines.get(pool, "")).split(" ")[0] != baseline for pool, (_, baseline) in POOLS.items()):
        raise RuntimeError("Preregistered best-fixed baselines changed")
    execution, analysis = preregistration.get("execution") or {}, preregistration.get("analysis") or {}
    if execution.get("repetitions") != 1 or analysis.get("labels") != LABELS or "10000 resamples" not in str(analysis.get("metrics")):
        raise RuntimeError("Preregistered execution or analysis rule changed")
    planned = preregistration.get("budget") or {}
    if any(study.rate(planned.get(key)) != Decimal(value) for key, value in [("aggregate_cap_usd", CAPS["aggregate_cap_usd"]), ("experiment_cap_usd", CAPS["experiment_cap_usd"]), ("per_run_cap_usd", CAPS["per_run_cap_usd"])]):
        raise RuntimeError("Preregistered parity budget changed")
    if budget.get("authorized") is not True or budget.get("action") != "authorize-parity-experiment-v1" or budget.get("user_approval") != preregistration.get("user_approval") or "Including Opus" not in budget.get("forbidden", []) or any(study.rate(budget.get(key)) != Decimal(value) for key, value in CAPS.items()):
        raise RuntimeError("User budget authorization must authorize exactly the preregistered parity caps")
    return {"preregistration_sha256": hashlib.sha256(preregistration_raw.encode("utf-8")).hexdigest(), "budget_authorization_sha256": hashlib.sha256(budget_raw.encode("utf-8")).hexdigest()}


def census_input_bound(census_out):
    paths = sorted(Path(census_out).glob("batches/*/pricing.json"))
    bounds = {study.load(path).get("shared_input_bound") for path in paths}
    if len(bounds) != 1 or type(next(iter(bounds))) is not int or next(iter(bounds)) <= 0:
        raise RuntimeError("Census batches must share exactly one native input bound")
    return next(iter(bounds)), {str(path.relative_to(census_out)): modern_eval.file_sha256(path) for path in paths}


def execution_plan(tasks):
    return {"experiment_id": EXPERIMENT_ID, "runs": [{"run": f"{EXPERIMENT_ID}--{task['instance_id']}--{arm['label']}--0", "instance_id": task["instance_id"], "repo": task["repo"], "candidate": arm["label"], "model": arm["model"], "effort": arm["effort"], "repetition": 0, "phase": "parity"} for task in tasks for arm in ARMS]}


def frozen_inputs(out, census_out, panel_out, ledger_out, preregistration_raw, budget_raw):
    roots = separate_roots(out, census_out, panel_out, ledger_out)
    out, census_out, panel_out, ledger_out = roots
    bindings = validate_authorizations(preregistration_raw, budget_raw)
    census_manifest, census_cfg, census_plan, tasks, private, rows = census.validate_manifest(census_out, panel_out, ledger_out)
    name, amendment = census.active_amendment(census_out)
    if name != census.OVERRUN_AMENDMENT:
        raise RuntimeError("Parity requires the census token-overrun amendment to be active")
    census_arms = census_cfg["candidates"]
    if {arm["label"] for arm in ARMS} & {arm["label"] for arm in census_arms} or {arm["model"] for arm in ARMS} & {arm["model"] for arm in census_arms}:
        raise RuntimeError("Parity arms must be distinct from census candidates")
    bound, bound_files = census_input_bound(census_out)
    resources = amendment["to_resources"]
    cfg = {**census_cfg, "candidates": [dict(arm) for arm in ARMS], "experiment_id": EXPERIMENT_ID, "experiment_cost_limit_usd": CAPS["experiment_cap_usd"], "max_input_tokens": bound}
    if any(cfg.get(key) != value for key, value in resources.items()) or study.rate(cfg["run_cost_limit_usd"]) != Decimal(CAPS["per_run_cap_usd"]):
        raise RuntimeError("Parity resources must equal the active census resources")
    analysis = census_out / "census-analysis.json"
    if not analysis.is_file():
        raise RuntimeError("Parity requires the final census analysis")
    census_runs = census.attempted_run_ids(census_out, census_plan, rows)
    plan = execution_plan(tasks)
    bindings.update(experiment_id=EXPERIMENT_ID, arms=ARMS, resources=resources, shared_input_bound=bound, census_pricing_bounds_sha256=study.digest(bound_files), experiment_cost_limit_usd=CAPS["experiment_cap_usd"], aggregate_cap_usd=CAPS["aggregate_cap_usd"], per_run_cap_usd=CAPS["per_run_cap_usd"], census_manifest_sha256=study.digest(census_manifest), census_amendment_sha256=study.digest(amendment), census_analysis_sha256=modern_eval.file_sha256(analysis), census_runs_sha256=study.digest(census_runs), census_evidence_sha256=study.digest(census.timeout_attempt_snapshot(census_out, census_runs, rows)), panel_sha256=census_manifest["panel_sha256"], panel_evidence_sha256=census_manifest["evidence_sha256"], execution_plan_sha256=study.digest(plan), source_sha256=source_hashes())
    return bindings, cfg, plan, tasks, private, rows, census_plan, roots


def read_authorizations(preregistration_path, budget_path):
    return Path(preregistration_path).read_bytes().decode("utf-8"), Path(budget_path).read_bytes().decode("utf-8")


def freeze_inputs(out, census_out, panel_out, ledger_out, preregistration_path, budget_path):
    return frozen_inputs(out, census_out, panel_out, ledger_out, *read_authorizations(preregistration_path, budget_path))[0]


def freeze(out, census_out, panel_out, ledger_out, preregistration_path, budget_path, approval_path):
    preregistration_raw, budget_raw = read_authorizations(preregistration_path, budget_path)
    bindings, cfg, plan, tasks, private, _, _, roots = frozen_inputs(out, census_out, panel_out, ledger_out, preregistration_raw, budget_raw)
    out, census_out, panel_out, ledger_out = roots
    approval = study.load(approval_path)
    required = {"authorized": True, "action": FREEZE_ACTION, **bindings}
    if any(approval.get(key) != value for key, value in required.items()):
        raise RuntimeError("Parity freeze approval must bind every frozen input")
    with census.writer(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite") as db:
        db.execute("BEGIN IMMEDIATE")
        metadata = census.cap_metadata(db)
        rows = census.ready_rows(db)
        census.runtime_tables(db)
        if any(row["run"].startswith(EXPERIMENT_ID + "--") for row in rows) or (out / "rollouts").exists() or (out / MANIFEST).exists():
            raise RuntimeError("Parity freeze must precede every parity attempt")
        for task in private.values():
            source = panel_out / "images" / f"{task['instance_id']}.json"
            destination = out / "images" / source.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as stream:
                stream.write(source.read_bytes())
        committed = Decimal(metadata["prior_committed_usd"]) + sum((study.held_cost(row) for row in rows), Decimal(0))
        manifest = {"version": 1, "purpose": "router-production-parity", "roots": {"out": str(out), "census_out": str(census_out), "panel_out": str(panel_out), "ledger_out": str(ledger_out)}, **bindings, "preregistration_raw": preregistration_raw, "budget_authorization_raw": budget_raw, "ledger_metadata": metadata, "aggregate_committed_at_freeze_usd": str(committed), "authorization": approval, "authorization_sha256": study.digest(approval)}
        census.frozen_write(out / "execution-plan.json", plan)
        census.frozen_write(out / MANIFEST, manifest)
    return manifest


def rerun_state(out, plan, rows, attempted):
    attempted = set(attempted)
    original = [row for row in plan["runs"] if row["repetition"] == 0 and row["run"] in attempted]
    results = census.normalized_results(out, rows, {"runs": original})

    def result(row):
        return results.get((row["instance_id"], row["candidate"]))

    def needs_rerun(row):
        return result(row) is None or result(row)["status"] in RERUN_STATUSES

    routed = [row for row in original if row["candidate"] == ROUTED_ARM]
    reruns = [{**row, "run": f"{EXPERIMENT_ID}--{row['instance_id']}--{row['candidate']}--1", "repetition": 1, "phase": "parity-rerun"} for row in routed if needs_rerun(row)]
    observed = {"tasks_attempted": len({row["instance_id"] for row in original}), "deepseek_runs_without_valid_grade": len(reruns), "terra_runs_valid": sum(result(row) is not None and census_analysis._reason(result(row)) is None for row in original if row["candidate"] == "frontier-terra")}
    return reruns, observed


def amended_plan(plan, reruns):
    return {**plan, "runs": [*plan["runs"], *reruns]}


def validate_parity_amendment(out, manifest, amendment, rows, plan, current_sources, *, creating=False):
    if not isinstance(amendment, dict) or amendment.get("schema") != "parity-amendment-v1":
        raise RuntimeError("Invalid parity amendment")
    raw = amendment.get("user_authorization_raw")
    if not isinstance(raw, str) or hashlib.sha256(raw.encode("utf-8")).hexdigest() != amendment.get("user_authorization_sha256"):
        raise RuntimeError("Parity amendment lost the exact user authorization file hash")
    user = json.loads(raw)
    change = user.get("change") or {}
    if user.get("schema") != "router-production-parity-amendment-v1" or user.get("authorized") is not True or user.get("action") != AMEND_ACTION or change.get("arm") != ROUTED_ARM or "frontier-terra" not in str(change.get("unchanged_for")):
        raise RuntimeError("Exact DeepSeek routing amendment user authorization required")
    original_sources = manifest["source_sha256"]
    changed = sorted(name for name in SOURCE_FILES if original_sources.get(name) != current_sources.get(name))
    if amendment.get("parity_manifest_sha256") != study.digest(manifest) or amendment.get("from_source_sha256") != original_sources or amendment.get("to_source_sha256") != current_sources or set(current_sources) != set(SOURCE_FILES) or changed != ["parity.py"]:
        raise RuntimeError("Parity amendment permits only the exact approved parity.py source transition")
    attempted = amendment.get("attempted_runs")
    current = [row["run"] for row in plan["runs"] if modern_eval.attempted(out, rows, row["run"])]
    if not isinstance(attempted, list) or (creating and attempted != current) or not set(attempted).issubset(current):
        raise RuntimeError("Parity amendment attempted set differs from the ledger and rollouts")
    if amendment.get("attempted_snapshot") != census.timeout_attempt_snapshot(out, attempted, rows):
        raise RuntimeError("Pre-amendment attempted-run evidence or ledger rows changed")
    reruns, observed = rerun_state(out, plan, rows, attempted)
    if amendment.get("reruns") != reruns or any(observed[key] != user.get("observed_before_amendment", {}).get(key) for key in observed):
        raise RuntimeError("Rerun list differs from the authorized observation")
    full = amended_plan(plan, reruns)
    if amendment.get("amended_plan_sha256") != study.digest(full):
        raise RuntimeError("Amended parity plan changed")
    return full


def amendment_approval_fields(amendment):
    return {"user_authorization_sha256": amendment["user_authorization_sha256"], "parity_manifest_sha256": amendment["parity_manifest_sha256"], "to_source_sha256": amendment["to_source_sha256"], "rerun_runs": [row["run"] for row in amendment["reruns"]], "amended_plan_sha256": amendment["amended_plan_sha256"]}


def load_amendment(out):
    path = Path(out) / AMENDMENT
    return study.load(path) if path.exists() else None


def validate_manifest(out, census_out, panel_out, ledger_out, *, pending_amendment=None):
    roots = separate_roots(out, census_out, panel_out, ledger_out)
    manifest = study.load(roots[0] / MANIFEST)
    if manifest.get("purpose") != "router-production-parity" or manifest.get("roots") != dict(zip(("out", "census_out", "panel_out", "ledger_out"), map(str, roots))):
        raise RuntimeError("Parity roots changed")
    bindings, cfg, plan, tasks, private, rows, census_plan, _ = frozen_inputs(*roots, manifest["preregistration_raw"], manifest["budget_authorization_raw"])
    amendment = pending_amendment if pending_amendment is not None else load_amendment(roots[0])
    current_sources = bindings["source_sha256"]
    if amendment is not None:
        bindings = {**bindings, "source_sha256": amendment.get("from_source_sha256")}
    required = {"authorized": True, "action": FREEZE_ACTION, **bindings}
    if any(manifest.get(key) != value for key, value in bindings.items()) or manifest.get("authorization_sha256") != study.digest(manifest.get("authorization")) or any(manifest["authorization"].get(key) != value for key, value in required.items()) or study.load(roots[0] / "execution-plan.json") != plan:
        raise RuntimeError("Parity frozen inputs, census evidence or source changed")
    with sqlite3.connect(roots[3] / "budget.sqlite") as db:
        if census.cap_metadata(db) != manifest["ledger_metadata"]:
            raise RuntimeError("Authoritative ledger caps changed after parity freeze")
    for task in private.values():
        name = f"{task['instance_id']}.json"
        if study.load(roots[0] / "images" / name) != study.load(roots[2] / "images" / name):
            raise RuntimeError("Frozen paid-run image identity changed")
    if amendment is not None:
        plan = validate_parity_amendment(roots[0], manifest, amendment, rows, plan, current_sources, creating=pending_amendment is not None)
    return manifest, cfg, plan, tasks, private, rows, census_plan, amendment


def draft_amendment(out, census_out, panel_out, ledger_out, user_authorization_path, approval):
    roots = separate_roots(out, census_out, panel_out, ledger_out)
    if (roots[0] / AMENDMENT).exists():
        raise RuntimeError("Parity amendment already exists; never overwrite it")
    user_raw = Path(user_authorization_path).read_bytes().decode("utf-8")
    manifest, plan = study.load(roots[0] / MANIFEST), study.load(roots[0] / "execution-plan.json")
    with sqlite3.connect(roots[3] / "budget.sqlite") as db:
        rows = study.request_rows(db)
    attempted = [row["run"] for row in plan["runs"] if modern_eval.attempted(roots[0], rows, row["run"])]
    reruns, _ = rerun_state(roots[0], plan, rows, attempted)
    amendment = {"schema": "parity-amendment-v1", "parity_manifest_sha256": study.digest(manifest), "user_authorization_sha256": hashlib.sha256(user_raw.encode("utf-8")).hexdigest(), "user_authorization_raw": user_raw, "from_source_sha256": manifest["source_sha256"], "to_source_sha256": source_hashes(), "attempted_runs": attempted, "attempted_snapshot": census.timeout_attempt_snapshot(roots[0], attempted, rows), "reruns": reruns, "amended_plan_sha256": study.digest(amended_plan(plan, reruns)), "routing": {"arm": ROUTED_ARM, "policy": LISTING_POLICY}, "authorization": approval, "authorization_sha256": study.digest(approval)}
    validate_manifest(*roots, pending_amendment=amendment)
    return amendment


def amendment_inputs(out, census_out, panel_out, ledger_out, user_authorization_path):
    return amendment_approval_fields(draft_amendment(out, census_out, panel_out, ledger_out, user_authorization_path, {}))


def amend(out, census_out, panel_out, ledger_out, user_authorization_path, approval_path):
    roots = separate_roots(out, census_out, panel_out, ledger_out)
    approval = study.load(approval_path)
    with census.writer(roots[3]), census.dispatch_guard(roots[3]), sqlite3.connect(roots[3] / "budget.sqlite") as db:
        db.execute("BEGIN IMMEDIATE")
        census.ready_rows(db)
        amendment = draft_amendment(*roots, user_authorization_path, approval)
        required = {"authorized": True, "action": AMEND_ACTION, **amendment_approval_fields(amendment)}
        if any(approval.get(key) != value for key, value in required.items()):
            raise RuntimeError("Parent amendment approval must bind the exact user file, manifest, source, reruns and amended plan")
        census.frozen_write(roots[0] / AMENDMENT, amendment)
    return amendment


def cap_violations(metadata, rows, run, bound, cfg):
    prefix = cfg["experiment_id"] + "--"
    spent = sum((study.held_cost(row) for row in rows), Decimal(0))
    experiment_spent = sum((study.held_cost(row) for row in rows if row["run"].startswith(prefix)), Decimal(0))
    run_spent = sum((study.held_cost(row) for row in rows if row["run"] == run), Decimal(0))
    caps = []
    if Decimal(metadata["prior_committed_usd"]) + spent + bound > Decimal(metadata["total_cap_usd"]):
        caps.append("aggregate_money_reservation")
    if experiment_spent + bound > Decimal(cfg["experiment_cost_limit_usd"]):
        caps.append("experiment_money_reservation")
    if run_spent + bound > Decimal(cfg["run_cost_limit_usd"]):
        caps.append("run_money_reservation")
    return caps, {"run_settled_plus_held_usd": str(run_spent), "experiment_settled_plus_held_usd": str(experiment_spent), "aggregate_settled_plus_held_usd": str(Decimal(metadata["prior_committed_usd"]) + spent)}


def reserve(out, run, bound, token_bound, *, cfg, ledger_out):
    ledger_out = Path(ledger_out)
    request_id = uuid.uuid4().hex
    with census.dispatch_guard(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite", isolation_level=None, timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        metadata = census.cap_metadata(db)
        rows = census.ready_rows(db, cfg["driver_id"], run)
        claim = db.execute("SELECT driver,state FROM census_claims WHERE run=?", (run,)).fetchone()
        if claim != (cfg["driver_id"], "active") or not run.startswith(cfg["experiment_id"] + "--"):
            raise RuntimeError("Only a claimed frozen parity run may reserve")
        if db.execute("SELECT 1 FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone():
            raise study.BudgetLimited("Parity cap previously stopped dispatch", {"caps": ["experiment_money_reservation"]})
        if not Decimal(bound).is_finite() or bound <= 0 or type(token_bound) is not int or token_bound <= 0:
            raise RuntimeError("Invalid reservation")
        caps, spent = cap_violations(metadata, rows, run, bound, cfg)
        if caps:
            if GLOBAL_CAPS.intersection(caps):
                db.execute("INSERT OR IGNORE INTO census_stops VALUES (?,?,?)", (cfg["experiment_id"], json.dumps(caps), time.time()))
                db.execute("COMMIT")
            raise study.BudgetLimited("Parity reservation exceeds cap", {"caps": caps, "next_money_bound_usd": str(bound), "next_token_bound": token_bound, **spent})
        receipt = Path(out) / "receipts" / f"{request_id}.json"
        db.execute("INSERT INTO requests (id,run,bound,actual,tokens,state,receipt,token_bound) VALUES (?,?,?,NULL,NULL,'reserved',?,?)", (request_id, run, str(bound), str(receipt), token_bound))
        db.execute("INSERT INTO census_dispatch VALUES (?,?,'reserved')", (request_id, run))
        db.execute("COMMIT")
    return request_id, receipt


@contextmanager
def dispatch_admission(ledger_out, run, request_id, cfg):
    with census.dispatch_guard(ledger_out), sqlite3.connect(Path(ledger_out) / "budget.sqlite", isolation_level=None, timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        owned = db.execute("SELECT run,state FROM census_dispatch WHERE request_id=?", (request_id,)).fetchone()
        try:
            if owned != (run, "reserved"):
                raise RuntimeError("Only a never-dispatched owned reservation may enter transport")
            metadata = census.cap_metadata(db)
            rows = census.ready_rows(db, cfg["driver_id"], run)
            request = next((row for row in rows if row["id"] == request_id), None)
            claim = db.execute("SELECT driver,state FROM census_claims WHERE run=?", (run,)).fetchone()
            if request is None or request["state"] != "reserved" or claim != (cfg["driver_id"], "active"):
                raise RuntimeError("Dispatch requires its active claim and live reservation")
            stopped = db.execute("SELECT caps FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone()
            caps = (json.loads(stopped[0]) if stopped else []) + cap_violations(metadata, rows, run, Decimal(0), cfg)[0]
            if caps:
                raise study.BudgetLimited("Final dispatch admission denied by global stop or caps", {"caps": sorted(set(caps))})
        except BaseException:
            if owned == (run, "reserved"):
                db.execute("UPDATE requests SET bound='0',actual='0',tokens=0,state='settled' WHERE id=? AND run=? AND state='reserved' AND actual IS NULL", (request_id, run))
                db.execute("UPDATE census_dispatch SET state='cancelled' WHERE request_id=?", (request_id,))
            db.execute("COMMIT")
            raise
        db.execute("UPDATE census_dispatch SET state='entered' WHERE request_id=?", (request_id,))
        db.execute("COMMIT")
    yield


def model_factory(out, run, candidate, deadline, *, cfg, ledger_out):
    shared_candidate = {**candidate, "context_length": cfg["max_input_tokens"] + cfg["max_output_tokens"]}
    return study.paid_model(out, run, shared_candidate, deadline, cfg=cfg, ledger_out=ledger_out, input_bounder=census.NativeInputBound(), reservation=reserve, transport_admission=dispatch_admission, state_guard=census.dispatch_guard)


def batch_pricing(directory, cfg, amendment=None):
    pricing = study.load(Path(directory) / "pricing.json")
    if [(model["label"], model["model"], model["effort"]) for model in pricing["models"]] != [(arm["label"], arm["model"], arm["effort"]) for arm in cfg["candidates"]] or pricing.get("shared_input_bound") != cfg["max_input_tokens"]:
        raise RuntimeError("Batch pricing must quote exactly the parity arms at the census input bound")
    for model in pricing["models"]:
        quote = model["financial_quote"]
        if quote["public_constraints"]["input_bound"] != cfg["max_input_tokens"] or quote["public_constraints"]["max_tokens"] != cfg["max_output_tokens"]:
            raise RuntimeError("Pricing does not finance the frozen resource context")
        snapshot = study.load(Path(directory) / "pricing-endpoints" / f"{quote['endpoint_snapshot_sha256']}.json")
        if study.digest(snapshot["body"]) != quote["endpoint_snapshot_sha256"] or snapshot["body"]["data"]["id"] != model["model"]:
            raise RuntimeError("Raw endpoint snapshot hash or model identity mismatch")
        endpoints = snapshot["body"]["data"]["endpoints"]
        if amendment is not None and model["label"] == ROUTED_ARM:
            expected = listing_ceiling(model["pricing"], endpoints, cfg)
        else:
            with scheduled_tier_pricing():
                expected = study.endpoint_ceiling(endpoints, cfg)
        if any(quote.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Financial quote does not reproduce from immutable endpoint evidence")
        study.financial_prices(model)
        study.routing_max_price(model)
    return pricing


def quote(out, census_out, panel_out, ledger_out, batch_id):
    _, cfg, *_, amendment = validate_manifest(out, census_out, panel_out, ledger_out)
    directory = modern_eval.batch_directory(out, batch_id)
    directory.mkdir(parents=True, exist_ok=False)
    with scheduled_tier_pricing():
        study.catalog(directory, cfg=cfg)
    pricing = study.load(directory / "pricing.json")
    pricing["shared_input_bound"] = cfg["max_input_tokens"]
    for model in pricing["models"]:
        if amendment is not None and model["label"] == ROUTED_ARM:
            frozen = model["financial_quote"]
            snapshot = study.load(directory / "pricing-endpoints" / f"{frozen['endpoint_snapshot_sha256']}.json")
            model["financial_quote"] = {**listing_ceiling(model["pricing"], snapshot["body"]["data"]["endpoints"], cfg), "endpoint_snapshot_sha256": frozen["endpoint_snapshot_sha256"], "source": frozen["source"]}
    study.save(directory / "pricing.json", pricing)
    pricing = batch_pricing(directory, cfg, amendment)
    return {"batch_id": batch_id, "pricing_sha256": study.digest(pricing), "shared_input_bound": pricing["shared_input_bound"], "fetched_at": pricing["fetched_at"]}


def check_batch(approval, batch_id, manifest, plan, pricing, amendment=None):
    runs = approval.get("runs")
    order = [row["run"] for row in plan["runs"]]
    if not isinstance(runs, list) or not runs or runs[0] not in order or runs != order[order.index(runs[0]):order.index(runs[0]) + len(runs)]:
        raise RuntimeError("Batch must list a contiguous slice of the frozen task-major order")
    blocks = {(row["instance_id"], row["repetition"]) for row in plan["runs"] if row["run"] in set(runs)}
    if [row["run"] for row in plan["runs"] if (row["instance_id"], row["repetition"]) in blocks] != runs:
        raise RuntimeError("Batches must align to entire task blocks")
    required = {"authorized": True, "action": BATCH_ACTION, "batch_id": batch_id, "parity_manifest_sha256": study.digest(manifest), "plan_sha256": study.digest(plan), "pricing_sha256": study.digest(pricing), "source_sha256": source_hashes(), "resources": manifest["resources"], "experiment_cost_limit_usd": CAPS["experiment_cap_usd"], "accounting_authorization_sha256": manifest["ledger_metadata"].get("unknown_accounting_authorization_sha256")}
    if amendment is not None:
        required["parity_amendment_sha256"] = study.digest(amendment)
    if any(approval.get(key) != value for key, value in required.items()):
        raise RuntimeError("Exact parity batch/manifest/plan/pricing/source/resource/accounting approval required")
    if not 0 <= time.time() - pricing["fetched_at"] <= modern_eval.PRICING_MAX_AGE_SECONDS:
        raise RuntimeError("Stale/future pricing; quote a new batch")
    return [row for row in plan["runs"] if row["run"] in set(runs)]


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
            return modern_eval.rollout(out, ledger_out, task, private, candidate, row, approval, cfg, manifest, batch_id, model_factory=model_factory, classifier=census.classify)
        except modern_eval.RunStopped as error:
            return {"run": row["run"], "status": error.status}
        finally:
            with sqlite3.connect(Path(ledger_out) / "budget.sqlite", timeout=60) as db:
                db.execute("UPDATE census_claims SET state='finished' WHERE run=?", (row["run"],))


def run_batch(out, census_out, panel_out, ledger_out, batch_id, approval_path, lease_deadline, concurrency=4, *, executor_factory=None, clock=time.time):
    if type(concurrency) is not int or not 1 <= concurrency <= 4:
        raise RuntimeError("Concurrency must be1..4")
    if isinstance(lease_deadline, bool) or not isinstance(lease_deadline, (int, float)) or not math.isfinite(lease_deadline):
        raise RuntimeError("Lease deadline must be a finite Unix epoch")
    out, census_out, panel_out, ledger_out = separate_roots(out, census_out, panel_out, ledger_out)
    if not os.environ.get("OPENROUTER_API_KEY"):
        raise RuntimeError("A host-only OpenRouter key is required before dispatch")
    with census.batch_writer(ledger_out):
        manifest, cfg, plan, tasks, private, _, _, amendment = validate_manifest(out, census_out, panel_out, ledger_out)
        pricing = batch_pricing(modern_eval.batch_directory(out, batch_id), cfg, amendment)
        approval = study.load(approval_path)
        selected = check_batch(approval, batch_id, manifest, plan, pricing, amendment)
        driver_id = uuid.uuid4().hex
        required = cfg["wall_seconds"] + census_panel.config()["evaluator_timeout_seconds"] + modern_eval.LEASE_MARGIN_SECONDS
        cfg.update(driver_id=driver_id, lease_deadline=lease_deadline, lease_required_seconds=required)
        models = {model["label"]: model for model in pricing["models"]}
        by_task = {task["instance_id"]: task for task in tasks}
        completed, pending, stopped = [], {}, None
        factory = executor_factory or (lambda: ProcessPoolExecutor(max_workers=concurrency, mp_context=multiprocessing.get_context("spawn")))
        with factory() as executor:
            while True:
                while stopped is None and len(pending) < concurrency:
                    with census.dispatch_guard(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite", isolation_level=None, timeout=60) as db:
                        db.execute("BEGIN IMMEDIATE")
                        rows = census.ready_rows(db, driver_id)
                        metadata = census.cap_metadata(db)
                        exhausted = []
                        prefix = cfg["experiment_id"] + "--"
                        if sum((study.held_cost(row) for row in rows if row["run"].startswith(prefix)), Decimal(0)) >= Decimal(cfg["experiment_cost_limit_usd"]):
                            exhausted.append("experiment_money_reservation")
                        if Decimal(metadata["prior_committed_usd"]) + sum((study.held_cost(row) for row in rows), Decimal(0)) >= Decimal(metadata["total_cap_usd"]):
                            exhausted.append("aggregate_money_reservation")
                        if exhausted:
                            db.execute("INSERT OR IGNORE INTO census_stops VALUES (?,?,?)", (cfg["experiment_id"], json.dumps(sorted(set(exhausted))), clock()))
                        stop = db.execute("SELECT caps FROM census_stops WHERE experiment=?", (cfg["experiment_id"],)).fetchone()
                        claims = {row[0] for row in db.execute("SELECT run FROM census_claims WHERE driver=?", (driver_id,))}
                        next_item = next((row for row in plan["runs"] if row["run"] not in claims and not modern_eval.attempted(out, rows, row["run"])), None)
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
                        db.execute("COMMIT")
                    if stopped is not None:
                        break
                    task = by_task[next_item["instance_id"]]
                    future = executor.submit(worker, out, ledger_out, task, private[task["instance_id"]], models[next_item["candidate"]], next_item, approval, cfg, manifest, batch_id)
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


def label(interval):
    if interval is None:
        return "inconclusive"
    if interval[0] > NOT_WORSE_LOWER:
        return "not_worse"
    if interval[1] < 0:
        return "worse"
    return "inconclusive"


def compare(tasks, parity_results, census_results, census_labels):
    def row(task, name):
        return (parity_results if name in PICKS else census_results).get((task["instance_id"], name))

    report = {"bootstrap": {"resamples": census_analysis.BOOTSTRAP_RESAMPLES, "seed": census_analysis.BOOTSTRAP_SEED, "unit": "repository", "interval": "percentile", "confidence": 0.95, "statistic": "mean paired (pick - best fixed) success difference"}, "labels": {**LABELS, "precedence": "first matching label in preregistered order"}, "pools": {}}
    for pool, (pick, baseline) in POOLS.items():
        complete, exclusions = [], []
        for task in tasks:
            reasons = [{"candidate": name, "reason": reason} for name in (pick, baseline) if (reason := census_analysis._reason(row(task, name))) is not None]
            if reasons:
                exclusions.append({"instance_id": task["instance_id"], "reasons": reasons})
            else:
                complete.append(task)
        deltas = [(task["repo"], int(census_analysis._passed(row(task, pick))) - int(census_analysis._passed(row(task, baseline)))) for task in complete]
        interval = census_analysis._bootstrap(deltas)
        count = len(complete)
        report["pools"][pool] = {"pick": pick, "bestFixed": baseline, "completeTasks": count, "expectedTasks": len(tasks), "repositories": len({task["repo"] for task in complete}), "exclusions": exclusions, "difference": sum(delta for _, delta in deltas) / count if count else None, "differenceBootstrap95": interval, "label": label(interval), "pickMetrics": census_analysis._metrics([row(task, pick) for task in complete]), "bestFixedMetrics": census_analysis._metrics([row(task, baseline) for task in complete])}
    report["models"] = {name: census_analysis._metrics([row(task, name) for task in tasks]) for name in [*census_labels, *PICKS]}
    return report


def ledger_cost(rows, runs):
    billed = [row for row in rows if row["run"] in runs]
    known = sum((study.rate(row["actual"]) for row in billed if row["actual"] is not None), Decimal(0))
    upper = sum((study.held_cost(row) for row in billed), Decimal(0))
    return known, upper, all(row["state"] == "settled" for row in billed)


def arm_results(out, rows, plan, amendment):
    results = census.normalized_results(out, rows, {"runs": [row for row in plan["runs"] if row["repetition"] == 0]})
    substituted, unresolved = [], []
    for rerun in (amendment or {}).get("reruns", []):
        key = (rerun["instance_id"], rerun["candidate"])
        original_run = f"{EXPERIMENT_ID}--{rerun['instance_id']}--{rerun['candidate']}--0"
        second = census.normalized_results(out, rows, {"runs": [rerun]}).get(key)
        valid = second is not None and census_analysis._reason(second) is None
        base = second if valid else {"status": "missing", "resolved": None, "elapsed": second.get("elapsed") if second else None, "caps_fired": second.get("caps_fired", []) if second else [], "hiddenGradeValid": False}
        known, upper, settled = ledger_cost(rows, {original_run, rerun["run"]})
        results[key] = {**base, "known": str(known), "upper": str(upper), "cost": str(known) if settled else None, "attempt_runs": [original_run, rerun["run"]], "attempt_statuses": [results[key]["status"] if key in results else "missing", second["status"] if second else "missing"]}
        (substituted if valid else unresolved).append(rerun["instance_id"])
    return results, substituted, unresolved


def analyze(out, census_out, panel_out, ledger_out):
    out, census_out, panel_out, ledger_out = separate_roots(out, census_out, panel_out, ledger_out)
    with census.writer(ledger_out), sqlite3.connect(ledger_out / "budget.sqlite") as db:
        manifest, cfg, plan, tasks, _, rows, census_plan, amendment = validate_manifest(out, census_out, panel_out, ledger_out)
        capped = db.execute("SELECT 1 FROM census_stops WHERE experiment=?", (EXPERIMENT_ID,)).fetchone() is not None
        if not capped and any(not modern_eval.attempted(out, rows, row["run"]) for row in plan["runs"]):
            raise RuntimeError("Parity runs must finish or hit a cap before analysis")
        census_labels = list(dict.fromkeys(item["candidate"] for item in census_plan["runs"]))
        results, substituted, unresolved = arm_results(out, rows, plan, amendment)
        report = compare(tasks, results, census.normalized_results(census_out, rows, census_plan), census_labels)
        report.update(version=1, parity_manifest_sha256=study.digest(manifest), census_analysis_sha256=manifest["census_analysis_sha256"], capped=capped, tokenEstimateOverruns=census.token_overrun_counts(out, rows, {"parity": plan}, ARMS)["parity"], scope={"baselines": "census first-pass repetition 0 only", "frontier": "excludes Opus; not certification of the production Frontier pool", "production": "independent fixed-arm runs of production's most-served picks, not routing replay"})
        if amendment is not None:
            report.update(departure_from_never_retry=True, rerunAmendment={"parity_amendment_sha256": study.digest(amendment), "arm": ROUTED_ARM, "routing_policy": LISTING_POLICY, "outcome_rule": "repetition 0 if valid, otherwise the repetition-1 rerun if valid; costs include every attempt", "substitutedTasks": substituted, "rerunsWithoutValidOutcome": unresolved})
        study.save(out / "parity-analysis.json", report)
        return report







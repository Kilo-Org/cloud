
from collections import Counter, defaultdict
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3

import study


def read_ledger(root):
    with sqlite3.connect((Path(root) / "budget.sqlite").resolve().as_uri() + "?mode=ro", uri=True) as db:
        return dict(db.execute("SELECT key,value FROM metadata")), study.request_rows(db)


def prepared_messages(messages):
    prepared = []
    for message in messages:
        if message["role"] == "exit":
            continue
        message = {key: value for key, value in message.items() if key != "extra"}
        if message.get("role") == "assistant" and isinstance(message.get("content"), list):
            thinking = [block for block in message["content"] if isinstance(block, dict) and block.get("type") in ("thinking", "redacted_thinking")]
            if thinking:
                other = [block for block in message["content"] if block not in thinking]
                message = {**message, "content": thinking + (other or [{"type": "text", "text": ""}])}
        prepared.append(message)
    return prepared


def input_bound(messages):
    return len(json.dumps(messages, ensure_ascii=False).encode()) + 4096


def file_evidence(path, root):
    return {"path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def historical_prices(candidate, receipts):
    quote = candidate.get("financial_quote")
    if quote is not None:
        prices = study.rate(quote["prompt_per_token"]), study.rate(quote["completion_per_token"])
        if min(prices) <= 0:
            raise RuntimeError("Invalid historical financial quote")
        return prices[0], prices[1], "approved-financial-quote-v1"
    prompt, completion = study.effective_prices(candidate["pricing"])
    if not receipts:
        raise RuntimeError("Legacy approved raw pricing requires dispatched receipt witnesses")
    for receipt in receipts:
        caps = receipt.get("routing_max_price") or {}
        expected = prompt * receipt["input_token_bound"] + completion * receipt["max_output_tokens"]
        if Decimal(receipt["reservation_usd"]) != expected or study.rate(caps.get("prompt")) != prompt * 1000000 or study.rate(caps.get("completion")) != completion * 1000000:
            raise RuntimeError("Legacy approved raw pricing differs from historical receipt rate/reservation witnesses")
    return prompt, completion, "approved-raw-effective-prices-receipt-witness-v1"


def audit(root):
    root = Path(root).resolve()
    cfg = study.load(root / "driver" / "study.json")
    metadata, rows = read_ledger(root)
    pricing_versions = {}
    for path in sorted({*root.rglob("pricing.json"), *(root / "pricing-snapshots").glob("*.json")}):
        pricing_snapshot = study.load(path)
        pricing_versions[study.digest(pricing_snapshot)] = (pricing_snapshot, path)
    excluded = {candidate["label"] for candidate in study.candidate_exclusion(root, cfg, required=True)["excluded_candidates"]}
    by_run = defaultdict(list)
    for row in rows:
        path = root / "receipts" / f"{row['id']}.json"
        receipt = study.load(path)
        if receipt["local_request_id"] != row["id"] or receipt["run"] != row["run"]:
            raise RuntimeError("Receipt identity differs from ledger")
        usage = receipt.get("response", {}).get("usage", {})
        by_run[row["run"]].append({"ledger": row, "receipt": file_evidence(path, root), "started_at": receipt["started_at"], "input_token_bound": receipt["input_token_bound"], "recomputed_input_bound": input_bound(receipt["request"]["messages"]), "max_output_tokens": receipt["request"]["max_tokens"], "native_prompt_tokens": usage.get("prompt_tokens"), "native_completion_tokens": usage.get("completion_tokens"), "native_total_tokens": usage.get("total_tokens"), "native_cost_usd": usage.get("cost"), "reservation_usd": receipt["reservation_usd"], "request_messages": receipt["request"]["messages"]})
        by_run[row["run"]][-1]["routing_max_price"] = receipt["request"].get("provider", {}).get("max_price")
    outcomes = []
    for path in sorted((root / "rollouts").glob("*/result.json")):
        result = study.load(path)
        run = result["run"]
        receipts = sorted(by_run[run], key=lambda value: value["started_at"])
        trajectory_path = path.parent / "trajectory.json"
        trajectory = study.load(trajectory_path) if trajectory_path.exists() else None
        diagnostics = {"run": run, "candidate": result["candidate"], "split": result["split"], "active": result["candidate"] not in excluded, "status": result["status"], "result": result["result"], "result_evidence": file_evidence(path, root), "requests": len(receipts), "native_prompt_tokens": sum(receipt["native_prompt_tokens"] or 0 for receipt in receipts), "native_completion_tokens": sum(receipt["native_completion_tokens"] or 0 for receipt in receipts), "missing_native_usage_requests": sum(receipt["native_prompt_tokens"] is None or receipt["native_completion_tokens"] is None for receipt in receipts), "settled_or_held_usd": str(sum((study.held_cost(receipt["ledger"]) for receipt in receipts), Decimal(0))), "receipt_bound_mismatches": [receipt["ledger"]["id"] for receipt in receipts if receipt["input_token_bound"] != receipt["recomputed_input_bound"]]}
        diagnostics["causes"] = []
        if trajectory:
            messages = prepared_messages(trajectory["messages"])
            diagnostics["trajectory_evidence"] = file_evidence(trajectory_path, root)
            diagnostics["terminal_evidence"] = [message for message in trajectory["messages"] if message["role"] == "exit"]
            diagnostics["receipt_prefix_matches"] = all(receipt["request_messages"] == messages[:len(receipt["request_messages"])] for receipt in receipts)
            if result["status"] == "budget_limited":
                terminal = "\n".join(str(message.get("content", "")) for message in trajectory["messages"] if message["role"] == "exit")
                if "conservative input token cap" in terminal or "reservation exceeds" in terminal:
                    if not diagnostics["receipt_prefix_matches"] or diagnostics["receipt_bound_mismatches"]:
                        raise RuntimeError(f"Cannot exactly reconstruct attempted request: {run}")
                    pending_bound = input_bound(messages)
                    approval_path = path.parent / "approval.json"
                    approval = study.load(approval_path)
                    approved_pricing_hash = approval["pricing_sha256"]
                    if approved_pricing_hash not in pricing_versions:
                        raise RuntimeError(f"Missing preserved approved pricing for historical run: {run}")
                    approved_pricing, pricing_path = pricing_versions[approved_pricing_hash]
                    candidate = next(candidate for candidate in approved_pricing["models"] if candidate["label"] == result["candidate"])
                    prompt_price, completion_price, rate_policy = historical_prices(candidate, receipts)
                    diagnostics["historical_rate_policy"] = rate_policy
                    diagnostics["historical_financial_rates"] = {"prompt_per_token": str(prompt_price), "completion_per_token": str(completion_price)}
                    diagnostics["approved_pricing_sha256"] = approved_pricing_hash
                    diagnostics["pricing_evidence"] = file_evidence(pricing_path, root)
                    diagnostics["approval_evidence"] = file_evidence(approval_path, root)
                    request_bound = prompt_price * pending_bound + completion_price * cfg["max_output_tokens"]
                    run_tokens = sum((receipt["ledger"]["tokens"] if receipt["ledger"]["state"] == "settled" else receipt["ledger"]["token_bound"]) or 0 for receipt in receipts)
                    diagnostics["undispatched_request"] = {"input_token_bound": pending_bound, "native_prompt_tokens": None, "native_completion_tokens": None, "reservation_usd": str(request_bound), "actual_settled_plus_held_tokens": run_tokens, "next_reserved_tokens": pending_bound + cfg["max_output_tokens"], "input_cap": min(cfg["max_input_tokens"], candidate["context_length"] - cfg["max_output_tokens"]), "run_money_cap_usd": cfg["run_cost_limit_usd"], "run_token_cap": cfg["run_token_limit"]}
                    if "conservative input token cap" in terminal:
                        diagnostics["causes"] = ["input_byte_bound"]
                        if pending_bound <= diagnostics["undispatched_request"]["input_cap"]:
                            raise RuntimeError("Input cap evidence does not reproduce")
                    else:
                        if Decimal(diagnostics["settled_or_held_usd"]) + request_bound > Decimal(cfg["run_cost_limit_usd"]):
                            diagnostics["causes"].append("run_money_reservation")
                        if run_tokens + pending_bound + cfg["max_output_tokens"] > cfg["run_token_limit"]:
                            diagnostics["causes"].append("run_token_reservation")
                        if not diagnostics["causes"]:
                            diagnostics["causes"] = ["global_or_study_reservation_requires_historical_ledger"]
                elif "ActionTimeLimited" in terminal:
                    diagnostics["causes"] = ["action_timeout"]
                elif "WallTimeLimited" in terminal or "TimeExceeded" in terminal:
                    diagnostics["causes"] = ["wall_timeout"]
                elif "LimitsExceeded" in terminal:
                    diagnostics["causes"] = ["agent_step_limit"]
                else:
                    diagnostics["causes"] = ["unattributed"]
        diagnostics["receipts"] = [{key: value for key, value in receipt.items() if key != "request_messages"} for receipt in receipts]
        outcomes.append(diagnostics)
    held = sum((study.held_cost(row) for row in rows), Decimal(0))
    active = [run for run in outcomes if run["active"]]
    cause_counts = Counter("+".join(run["causes"]) for run in active if run["status"] == "budget_limited")
    return {"schema": "repository-resource-audit-v1", "root": str(root), "config_sha256": study.digest(cfg), "ledger_metadata": metadata, "ledger_state_counts": dict(Counter(row["state"] for row in rows)), "study_settled_plus_held_usd": str(held), "aggregate_upper_usd": str(Decimal(metadata["prior_committed_usd"]) + held), "active_status_counts": dict(Counter(run["status"] for run in active)), "active_limited_cause_counts": dict(cause_counts), "native_usage_policy": "Only dispatched receipt usage; undispatched native tokens are unknown, never estimated", "runs": outcomes}


RESOURCE_KEYS = {"step_limit", "max_input_tokens", "max_output_tokens", "run_token_limit", "wall_seconds", "action_timeout_seconds", "run_cost_limit_usd"}
RESOURCE_MAXIMA = {"step_limit": 60, "max_input_tokens": 196608, "max_output_tokens": 4096, "run_token_limit": 1048576, "wall_seconds": 1800, "action_timeout_seconds": 180}
MANIFEST_NAME = "resource-manifest-v1.json"


def effective_config(spec, ledger_out):
    if spec.get("version") != 1 or set(spec.get("resources", {})) != RESOURCE_KEYS:
        raise RuntimeError("Exact versioned calibration resources required")
    experiment_id = spec.get("experiment_id", "")
    if not experiment_id or len(experiment_id) > 80 or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for character in experiment_id):
        raise RuntimeError("Invalid new experiment identity")
    resources = spec["resources"]
    for key, maximum in RESOURCE_MAXIMA.items():
        if type(resources[key]) is not int or not 0 < resources[key] <= maximum:
            raise RuntimeError(f"Calibration resource exceeds parent-approved ceiling: {key}")
    run_cap = study.rate(resources["run_cost_limit_usd"])
    experiment_cap = study.rate(spec.get("experiment_cost_limit_usd"))
    if not 0 < run_cap <= 3 or not 0 < experiment_cap <= 30 or experiment_cap < 10 * run_cap:
        raise RuntimeError("Calibration money caps must conservatively fund ten runs within30USD")
    cfg = study.config()
    candidates = study.active_candidates(ledger_out, cfg)
    if len(candidates) != 5 or any(candidate["label"] == "frontier-opus" for candidate in candidates):
        raise RuntimeError("Calibration requires the original authorized five-arm scope without Opus")
    return {**cfg, **resources, "candidates": candidates, "experiment_id": experiment_id, "experiment_cost_limit_usd": str(experiment_cap)}


def execution_plan(panel, cfg):
    runs = []
    for task in panel["tasks"]:
        for candidate in cfg["candidates"]:
            run = {"instance_id": task["instance_id"], "candidate": candidate["label"], "model": candidate["model"], "effort": candidate["effort"], "repetition": 0, "split": "calibration"}
            run["run"] = f"{cfg['experiment_id']}--{task['instance_id']}--{candidate['label']}--0"
            runs.append(run)
    return {"experiment_id": cfg["experiment_id"], "panel_sha256": study.digest(panel), "runs": sorted(runs, key=lambda run: study.digest([cfg["experiment_id"], run]))}


def validate_panel(out, ledger_out, cfg):
    panel, _ = study.check_panel(out)
    original_panel = study.load(ledger_out / "panel.json")
    if panel.get("original_config_role") != "base-engine-and-accounting-only; task selection and new resources bound independently":
        raise RuntimeError("New panel must distinguish original engine accounting from new task selection")
    provenance = panel.get("selection_provenance", {})
    if set(provenance) != {"seed", "dataset", "dataset_revision", "explicit_instance_ids", "families"} or not all(isinstance(provenance[key], str) and provenance[key] for key in ("seed", "dataset", "dataset_revision")) or panel.get("selection_provenance_sha256") != study.digest(provenance):
        raise RuntimeError("Exact new task-selection provenance hash required")
    if provenance["explicit_instance_ids"] != sorted(task["instance_id"] for task in panel["tasks"]) or provenance["families"] != sorted({task["repo"] for task in panel["tasks"]}):
        raise RuntimeError("New task-selection provenance does not match the calibration panel")
    if len(panel["tasks"]) != 2 or len({task["instance_id"] for task in panel["tasks"]}) != 2:
        raise RuntimeError("Calibration cohort must contain exactly two distinct new tasks")
    if len({task["repo"] for task in panel["tasks"]}) != 2:
        raise RuntimeError("Calibration must use two distinct calibration-only families")
    if {task["instance_id"] for task in panel["tasks"]} & {task["instance_id"] for task in original_panel["tasks"]}:
        raise RuntimeError("Historical tasks/runs may not be retried as calibration")
    if {task["repo"] for task in panel["tasks"]} & {task["repo"] for task in original_panel["tasks"]}:
        raise RuntimeError("Calibration-only families must be isolated from the original evaluation")
    if any(task["split"] != "calibration" or "/" in task["instance_id"] or task["instance_id"].startswith(".") for task in panel["tasks"]):
        raise RuntimeError("Only new calibration-phase task identities are allowed")
    plan = execution_plan(panel, cfg)
    if study.load(out / "execution-plan.json") != plan:
        raise RuntimeError("Calibration plan differs from the exact ten new runs")
    return panel, plan


def frozen_inputs(out, ledger_out, cfg):
    panel, plan = validate_panel(out, ledger_out, cfg)
    for task in panel["tasks"]:
        task_id = task["instance_id"]
        image = study.load(out / "images" / f"{task_id}.json")
        fixture = study.load(out / "fixtures" / f"{task_id}.json")
        audit = study.load(out / "image-audits" / f"{task_id}.json")
        runtime = study.load(out / "runtime-preflight" / f"{task_id}.json")
        if fixture.get("eligible") is not True or fixture.get("image_id") != image["id"] or audit.get("forbidden_hits") != [] or audit.get("image_id") != image["id"] or runtime.get("valid") is not True or runtime.get("image_id") != image["id"]:
            raise RuntimeError("All new calibration tasks require valid isolated fixture/image/runtime proof")
    pricing = study.load(out / "pricing.json")
    models = pricing["models"]
    if sorted((model["label"], model["model"], model["effort"]) for model in models) != sorted((candidate["label"], candidate["model"], candidate["effort"]) for candidate in cfg["candidates"]):
        raise RuntimeError("Calibration pricing must match exactly the five authorized original candidates")
    for model in models:
        quote = model["financial_quote"]
        if quote["public_constraints"]["input_bound"] != cfg["max_input_tokens"] or quote["public_constraints"]["max_tokens"] != cfg["max_output_tokens"]:
            raise RuntimeError("Pricing does not finance the new resource context")
        snapshot = study.load(out / "pricing-endpoints" / f"{quote['endpoint_snapshot_sha256']}.json")
        if study.digest(snapshot["body"]) != quote["endpoint_snapshot_sha256"]:
            raise RuntimeError("Raw endpoint snapshot hash mismatch")
        if snapshot["body"]["data"]["id"] != model["model"]:
            raise RuntimeError("Endpoint financial evidence belongs to another candidate model")
        expected = study.endpoint_ceiling(snapshot["body"]["data"]["endpoints"], cfg)
        if any(quote.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Financial quote does not reproduce from immutable endpoint evidence")
        study.financial_prices(model)
        study.routing_max_price(model)
    exclusion = study.candidate_exclusion(ledger_out, required=True)
    if study.load(ledger_out / "driver" / "study.json") != study.config():
        raise RuntimeError("Original archived configuration differs from the accounting baseline")
    return {"panel_sha256": study.digest(panel), "execution_plan_sha256": study.digest(plan), "pricing_sha256": study.digest(pricing), "evidence_sha256": study.digest(study.evidence_manifest(out)), "exclusion_manifest_sha256": study.digest(exclusion), "original_source_sha256": hashlib.sha256((ledger_out / "driver" / "study.py").read_bytes()).hexdigest()}


def ledger_baseline(ledger_out):
    metadata, rows = read_ledger(ledger_out)
    expected = {"config_sha256": study.digest(study.config()), "prior_committed_usd": study.config()["prior_committed_usd"], "prior_unknown_bound_usd": study.config()["prior_unknown_bound_usd"], "study_cap_usd": study.config()["study_cost_limit_usd"], "total_cap_usd": study.config()["total_cost_limit_usd"]}
    if any(metadata.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Calibration must retain the original authoritative financial metadata")
    with sqlite3.connect((ledger_out / "budget.sqlite").as_uri() + "?mode=ro", uri=True) as db:
        study.assert_ledger_ready(db)
    return metadata, rows


def freeze(out, ledger_out, spec_path, authorization_path):
    import fcntl

    out, ledger_out = Path(out).resolve(strict=True), Path(ledger_out).resolve(strict=True)
    if out == ledger_out or out.is_relative_to(ledger_out) or ledger_out.is_relative_to(out) or (out / "budget.sqlite").exists():
        raise RuntimeError("Experiment artifacts and authoritative ledger must be separate roots")
    spec, authorization = study.load(spec_path), study.load(authorization_path)
    cfg = effective_config(spec, ledger_out)
    inputs = frozen_inputs(out, ledger_out, cfg)
    required = {"authorized": True, "action": "freeze-calibration-v1", "spec_sha256": study.digest(spec), **inputs}
    if any(authorization.get(key) != value for key, value in required.items()):
        raise RuntimeError("Parent authorization must bind exact calibration resources and evidence")
    with (ledger_out / ".writer.lock").open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        metadata, rows = ledger_baseline(ledger_out)
        if any(row["run"].startswith(cfg["experiment_id"] + "--") for row in rows) or (out / "rollouts").exists():
            raise RuntimeError("Calibration manifest must be frozen before any experiment attempt")
        held = sum((study.held_cost(row) for row in rows), Decimal(0))
        if held + Decimal(cfg["experiment_cost_limit_usd"]) > Decimal(metadata["study_cap_usd"]) or Decimal(metadata["prior_committed_usd"]) + held + Decimal(cfg["experiment_cost_limit_usd"]) > Decimal(metadata["total_cap_usd"]):
            raise RuntimeError("Full calibration allocation exceeds the original remaining budget")
        manifest = {"version": 1, "purpose": "calibration-only-not-evaluation", "spec": spec, "spec_sha256": study.digest(spec), "resource_config_sha256": study.digest(cfg), "original_config_sha256": study.digest(study.config()), "ledger_root": str(ledger_out), "experiment_root": str(out), "original_metadata": metadata, "historical_request_ids": [row["id"] for row in rows], "historical_rows_sha256": study.digest(rows), "authorization": authorization, "authorization_sha256": study.digest(authorization), **inputs}
        with (out / MANIFEST_NAME).open("x") as stream:
            stream.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def validate_manifest(out, ledger_out):
    out, ledger_out = Path(out).resolve(strict=True), Path(ledger_out).resolve(strict=True)
    manifest = study.load(out / MANIFEST_NAME)
    if manifest.get("version") != 1 or manifest.get("purpose") != "calibration-only-not-evaluation" or manifest.get("ledger_root") != str(ledger_out) or manifest.get("experiment_root") != str(out) or (out / "budget.sqlite").exists():
        raise RuntimeError("Missing or invalid experiment/authoritative-ledger binding")
    cfg = effective_config(manifest["spec"], ledger_out)
    inputs = frozen_inputs(out, ledger_out, cfg)
    required = {"authorized": True, "action": "freeze-calibration-v1", "spec_sha256": study.digest(manifest["spec"]), **inputs}
    if manifest["authorization_sha256"] != study.digest(manifest["authorization"]) or any(manifest["authorization"].get(key) != value for key, value in required.items()) or any(manifest.get(key) != value for key, value in inputs.items()):
        raise RuntimeError("Calibration manifest authorization or frozen evidence mismatch")
    if manifest["spec_sha256"] != study.digest(manifest["spec"]) or manifest["resource_config_sha256"] != study.digest(cfg) or manifest["original_config_sha256"] != study.digest(study.config()):
        raise RuntimeError("Calibration resource configuration hash mismatch")
    metadata, rows = ledger_baseline(ledger_out)
    historical_ids = set(manifest["historical_request_ids"])
    if metadata != manifest["original_metadata"] or study.digest([row for row in rows if row["id"] in historical_ids]) != manifest["historical_rows_sha256"]:
        raise RuntimeError("Historical financial metadata or requests changed")
    return manifest, cfg


def solve(out, ledger_out, run, approval_path):
    import fcntl
    import os
    import time

    out, ledger_out = Path(out).resolve(strict=True), Path(ledger_out).resolve(strict=True)
    with (ledger_out / ".writer.lock").open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, cfg = validate_manifest(out, ledger_out)
        approval = study.load(approval_path)
        source_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(__file__), Path(study.__file__)]}
        required = {"authorized": True, "phase": "calibration", "resource_manifest_sha256": study.digest(manifest), "source_sha256": source_hashes, "accounting_authorization_sha256": manifest["original_metadata"].get("unknown_accounting_authorization_sha256")}
        if any(approval.get(key) != value for key, value in required.items()):
            raise RuntimeError("Exact calibration-only parent phase/source/accounting clearance required")
        panel, plan = validate_panel(out, ledger_out, cfg)
        next_row = next((row for row in plan["runs"] if not (out / "rollouts" / row["run"] / "result.json").exists()), None)
        if next_row is None or next_row["run"] != run:
            raise RuntimeError("Only the next new calibration plan row may execute")
        _, rows = read_ledger(ledger_out)
        if any(row["run"] == run for row in rows) or (out / "rollouts" / run).exists():
            raise RuntimeError("An attempted calibration run may never be retried")
        pricing = study.load(out / "pricing.json")
        if not 0 <= time.time() - pricing["fetched_at"] <= 86400:
            raise RuntimeError("Calibration pricing is stale or future-dated")
        if not os.environ.get("OPENROUTER_API_KEY"):
            raise RuntimeError("No host-only provider key")
        task = next(task for task in panel["tasks"] if task["instance_id"] == next_row["instance_id"])
        candidate = next(model for model in pricing["models"] if model["label"] == next_row["candidate"])
        return study.rollout(out, task, candidate, 0, approval, run, cfg=cfg, ledger_out=ledger_out, metadata_extra={"experiment_id": cfg["experiment_id"], "phase": "calibration", "resource_manifest_sha256": study.digest(manifest)})








from collections import Counter, defaultdict
from decimal import Decimal
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from types import SimpleNamespace
import uuid

import analyze
import calibration
import modern_panel
import study

HERE = Path(__file__).resolve().parent
MANIFEST_NAME = "eval-manifest-v1.json"
PHASES = ("discovery", "validation", "holdout")
REPETITIONS = {"discovery": 2, "validation": 1, "holdout": 1}
RESOURCES = {"step_limit": 60, "max_input_tokens": 196608, "max_output_tokens": 4096, "run_token_limit": 1048576, "wall_seconds": 1800, "action_timeout_seconds": 180, "run_cost_limit_usd": "3"}
EXPERIMENT_CAP_USD = "60"
PRICING_MAX_AGE_SECONDS = 7200
LEASE_MARGIN_SECONDS = 600
MINIMUM_POOL_COVERAGE = Decimal("0.5")
SOURCE_FILES = ("modern_eval.py", "modern_panel.py", "study.py", "analyze.py", "calibration.py")
UNAVAILABLE_ROUTE = re.compile(r"no allowed providers|no endpoints found", re.IGNORECASE)
OPERATIONAL_STATUSES = {"provider_unavailable", "provider_refused"}
SAFE_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,79}")


class RunStopped(RuntimeError):
    def __init__(self, run, status):
        super().__init__(f"STOP after {run}: {status}; preserve receipts and ledger, never retry this run")
        self.run = run
        self.status = status


def source_hashes():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_pins():
    import minisweagent

    root = Path(minisweagent.__file__).resolve().parent
    revision = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], check=True, capture_output=True, text=True).stdout.strip()
    if revision != study.config()["mini_revision"] or dirty:
        raise RuntimeError("Solver must use the clean pinned mini-SWE-agent revision")
    modern_panel.verify_harness()


def effective_config(spec, ledger_out):
    if not isinstance(spec, dict) or set(spec) != {"version", "experiment_id", "resources", "experiment_cost_limit_usd"} or spec["version"] != 1:
        raise RuntimeError("Exact versioned modern evaluation spec required")
    if spec["resources"] != RESOURCES or spec["experiment_cost_limit_usd"] != EXPERIMENT_CAP_USD:
        raise RuntimeError("Modern evaluation must use the frozen calibration resources and its parent-approved caps")
    if not isinstance(spec["experiment_id"], str) or not SAFE_NAME.fullmatch(spec["experiment_id"]):
        raise RuntimeError("Invalid new experiment identity")
    cfg = study.config()
    candidates = study.active_candidates(ledger_out, cfg)
    if len(candidates) != 5 or any(candidate["label"] == "frontier-opus" for candidate in candidates):
        raise RuntimeError("Evaluation requires the original authorized five-arm scope without Opus")
    return {**cfg, **RESOURCES, "candidates": candidates, "experiment_id": spec["experiment_id"], "experiment_cost_limit_usd": EXPERIMENT_CAP_USD}


def scope(panel_out):
    panel, private = modern_panel.check_panel(panel_out)
    amendment = study.load(panel_out / "panel-amendment-v1.json")
    excluded = set(amendment.get("excluded_instance_ids", []))
    if amendment.get("schema") != "modern-panel-amendment-v1" or amendment.get("applies_to_panel_sha256") != study.digest(panel) or amendment.get("implementation_hashes") != modern_panel.implementation_hashes() or amendment.get("model_requests_on_this_panel_before_amendment") != 0:
        raise RuntimeError("Panel amendment does not bind this frozen panel and implementation")
    tasks = [task for task in panel["tasks"] if task["instance_id"] not in excluded]
    if len(panel["tasks"]) - len(tasks) != len(excluded):
        raise RuntimeError("Amendment excludes unknown tasks")
    remaining = amendment.get("remaining_scope", {})
    if remaining != {"tasks": len(tasks), "families": len({task["repo"] for task in tasks}), "splits": dict(Counter(task["split"] for task in tasks))} or set(remaining["splits"]) != set(PHASES):
        raise RuntimeError("Amended task scope differs from the frozen panel")
    readiness = study.load(panel_out / "readiness.json")
    if readiness.get("panel_sha256") != study.digest(panel) or readiness.get("implementation_hashes") != modern_panel.implementation_hashes() or {blocker.get("instance_id") for blocker in readiness.get("blockers", [])} - excluded:
        raise RuntimeError("Readiness report has blockers outside the authorized amendment")
    by_id = {row["instance_id"]: row for row in private}
    return panel, amendment, tasks, by_id


def task_evidence(panel_out, task):
    task_id = task["instance_id"]
    paths = {key: panel_out / directory / f"{task_id}.json" for key, directory in [("image", "images"), ("fixture", "fixtures"), ("image_audit", "image-audits"), ("runtime", "runtime"), ("license", "license-checks")]}
    if any(not path.is_file() for path in paths.values()):
        raise RuntimeError(f"Missing readiness evidence: {task_id}")
    records = {key: study.load(path) for key, path in paths.items()}
    image_id = records["image"].get("id")
    fingerprint = study.digest(task)
    runtime = records["runtime"]
    snapshot = runtime.get("snapshot", {})
    valid = records["fixture"].get("eligible") is True and all(records[key].get("image_id") == image_id and records[key].get("fixture_sha256") == fingerprint for key in ["fixture", "image_audit", "runtime"])
    valid = valid and modern_panel.resource_contract(task, panel_out)["compatible"]
    valid = valid and all(modern_panel.scan_report_valid(records[key], task) and modern_panel.isolation_valid(records[key], image_id) and records[key].get("implementation_hashes") == modern_panel.implementation_hashes() for key in ["image_audit", "runtime"])
    valid = valid and snapshot.get("sanitized") is True and snapshot.get("snapshot_tree") == snapshot.get("base_tree") and modern_panel.runtime_smoke_valid(task, runtime.get("smoke", {})) and runtime.get("unchanged_candidate_diff_exit_code") == 0 and runtime.get("solver_input_sha256") == study.digest(modern_panel.solver_input(task))
    valid = valid and modern_panel.retained_grades_valid(panel_out, task, records["fixture"], image_id)
    if not valid:
        raise RuntimeError(f"Readiness evidence is invalid or mismatched: {task_id}")
    return {str(path.relative_to(panel_out)): file_sha256(path) for path in paths.values()}


def execution_plan(tasks, cfg):
    runs = []
    for phase in PHASES:
        rows = []
        for task in tasks:
            if task["split"] != phase:
                continue
            for candidate in cfg["candidates"]:
                for repetition in range(REPETITIONS[phase]):
                    run = f"{cfg['experiment_id']}--{task['instance_id']}--{candidate['label']}--{repetition}"
                    if "/" in run or run.startswith("."):
                        raise RuntimeError("Unsafe run identity")
                    rows.append({"run": run, "instance_id": task["instance_id"], "repo": task["repo"], "phase": phase, "candidate": candidate["label"], "model": candidate["model"], "effort": candidate["effort"], "repetition": repetition})
        runs.extend(sorted(rows, key=lambda row: study.digest([cfg["experiment_id"], phase, row])))
    if len({row["run"] for row in runs}) != len(runs):
        raise RuntimeError("Duplicate run identity")
    return {"experiment_id": cfg["experiment_id"], "repetitions": REPETITIONS, "runs": runs}


def frozen_inputs(panel_out, ledger_out, cfg):
    panel, amendment, tasks, private = scope(panel_out)
    evidence = {task["instance_id"]: task_evidence(panel_out, private[task["instance_id"]]) for task in tasks}
    plan = execution_plan(tasks, cfg)
    exclusion = study.candidate_exclusion(ledger_out, required=True)
    if study.load(ledger_out / "driver" / "study.json") != study.config():
        raise RuntimeError("Original archived configuration differs from the accounting baseline")
    inputs = {"panel_sha256": study.digest(panel), "amendment_sha256": study.digest(amendment), "readiness_sha256": file_sha256(panel_out / "readiness.json"), "task_evidence_sha256": study.digest(evidence), "panel_implementation_hashes": modern_panel.implementation_hashes(), "execution_plan_sha256": study.digest(plan), "exclusion_manifest_sha256": study.digest(exclusion), "original_source_sha256": file_sha256(ledger_out / "driver" / "study.py")}
    return inputs, plan, tasks, private


def separate_roots(out, panel_out, ledger_out):
    roots = [Path(path).resolve(strict=True) for path in (out, panel_out, ledger_out)]
    if any(first == second or first.is_relative_to(second) or second.is_relative_to(first) for index, first in enumerate(roots) for second in roots[index + 1:]):
        raise RuntimeError("Experiment, panel and authoritative ledger roots must be separate")
    if (roots[0] / "budget.sqlite").exists():
        raise RuntimeError("Experiment root may not hold a second ledger")
    return roots


def freeze(out, panel_out, ledger_out, spec_path, authorization_path):
    out, panel_out, ledger_out = separate_roots(out, panel_out, ledger_out)
    spec, authorization = study.load(spec_path), study.load(authorization_path)
    cfg = effective_config(spec, ledger_out)
    inputs, plan, tasks, _ = frozen_inputs(panel_out, ledger_out, cfg)
    required = {"authorized": True, "action": "freeze-modern-eval-v1", "spec_sha256": study.digest(spec), "source_sha256": source_hashes(), **inputs}
    if any(authorization.get(key) != value for key, value in required.items()):
        raise RuntimeError("Parent authorization must bind exact spec, panel, readiness, plan, scope and source")
    with (ledger_out / ".writer.lock").open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        metadata, rows = calibration.ledger_baseline(ledger_out)
        if any(row["run"].startswith(cfg["experiment_id"] + "--") for row in rows) or (out / "rollouts").exists() or (out / MANIFEST_NAME).exists():
            raise RuntimeError("Evaluation manifest must be frozen before any experiment attempt")
        held = sum((study.held_cost(row) for row in rows), Decimal(0))
        cap = Decimal(EXPERIMENT_CAP_USD)
        if held + cap > Decimal(metadata["study_cap_usd"]) or Decimal(metadata["prior_committed_usd"]) + held + cap > Decimal(metadata["total_cap_usd"]):
            raise RuntimeError("Experiment allocation exceeds the original remaining study or aggregate budget")
        images = {}
        for task in tasks:
            source = panel_out / "images" / f"{task['instance_id']}.json"
            destination = out / "images" / source.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as stream:
                stream.write(source.read_bytes())
            images[source.name] = file_sha256(destination)
        with (out / "execution-plan.json").open("x") as stream:
            stream.write(json.dumps(plan, indent=2, sort_keys=True) + "\n")
        manifest = {"version": 1, "purpose": "modern-public-evaluation", "spec": spec, "spec_sha256": study.digest(spec), "resource_config_sha256": study.digest(cfg), "original_config_sha256": study.digest(study.config()), "ledger_root": str(ledger_out), "panel_root": str(panel_out), "experiment_root": str(out), "original_metadata": metadata, "historical_request_ids": [row["id"] for row in rows], "historical_rows_sha256": study.digest(rows), "image_records_sha256": images, "authorization": authorization, "authorization_sha256": study.digest(authorization), **inputs}
        with (out / MANIFEST_NAME).open("x") as stream:
            stream.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


SOURCE_AMENDMENT_NAME = "source-amendment-v1.json"


def frozen_source_hashes(out, manifest):
    path = Path(out) / SOURCE_AMENDMENT_NAME
    original = manifest["authorization"].get("source_sha256")
    if not path.exists():
        return original
    amendment = study.load(path)
    changed = {name for name in SOURCE_FILES if amendment.get("to_source_sha256", {}).get(name) != (original or {}).get(name)}
    if amendment.get("version") != 1 or amendment.get("authorized") is not True or amendment.get("eval_manifest_sha256") != study.digest(manifest) or amendment.get("from_source_sha256") != original or set(amendment.get("to_source_sha256", {})) != set(SOURCE_FILES) or changed != {"modern_eval.py"} or not amendment.get("reason") or amendment.get("analysis_artifacts_before_amendment") != []:
        raise RuntimeError("Source amendment must change only modern_eval.py before any phase analysis")
    return amendment["to_source_sha256"]


def validate_manifest(out, panel_out, ledger_out):
    out, panel_out, ledger_out = separate_roots(out, panel_out, ledger_out)
    manifest = study.load(out / MANIFEST_NAME)
    if manifest.get("version") != 1 or manifest.get("purpose") != "modern-public-evaluation" or [manifest.get(key) for key in ("experiment_root", "panel_root", "ledger_root")] != [str(out), str(panel_out), str(ledger_out)]:
        raise RuntimeError("Missing or invalid experiment/panel/ledger binding")
    cfg = effective_config(manifest["spec"], ledger_out)
    inputs, plan, tasks, private = frozen_inputs(panel_out, ledger_out, cfg)
    current = frozen_source_hashes(out, manifest)
    if current != source_hashes():
        raise RuntimeError("Driver source differs from the frozen or amended evaluation source")
    original = manifest["authorization"].get("source_sha256")
    required = {"authorized": True, "action": "freeze-modern-eval-v1", "spec_sha256": study.digest(manifest["spec"]), "source_sha256": original, **inputs}
    if manifest.get("authorization_sha256") != study.digest(manifest.get("authorization")) or any(manifest["authorization"].get(key) != value for key, value in required.items()) or any(manifest.get(key) != value for key, value in inputs.items()):
        raise RuntimeError("Evaluation manifest authorization, source or frozen evidence mismatch")
    if manifest["resource_config_sha256"] != study.digest(cfg) or manifest["original_config_sha256"] != study.digest(study.config()) or study.load(out / "execution-plan.json") != plan:
        raise RuntimeError("Evaluation resources, original configuration or plan changed")
    if manifest["image_records_sha256"] != {f"{task['instance_id']}.json": file_sha256(panel_out / "images" / f"{task['instance_id']}.json") for task in tasks} or any(file_sha256(out / "images" / name) != value for name, value in manifest["image_records_sha256"].items()):
        raise RuntimeError("Pinned image records changed")
    metadata, rows = calibration.ledger_baseline(ledger_out)
    historical = set(manifest["historical_request_ids"])
    if metadata != manifest["original_metadata"] or study.digest([row for row in rows if row["id"] in historical]) != manifest["historical_rows_sha256"] or len(historical) != len([row for row in rows if row["id"] in historical]):
        raise RuntimeError("Historical financial metadata or requests changed")
    return manifest, cfg, plan, tasks, private, rows


def validate_pricing(directory, cfg):
    pricing = study.load(directory / "pricing.json")
    models = pricing["models"]
    if sorted((model["label"], model["model"], model["effort"]) for model in models) != sorted((candidate["label"], candidate["model"], candidate["effort"]) for candidate in cfg["candidates"]):
        raise RuntimeError("Batch pricing must match exactly the five authorized candidates")
    for model in models:
        quote = model["financial_quote"]
        if quote["public_constraints"]["input_bound"] != cfg["max_input_tokens"] or quote["public_constraints"]["max_tokens"] != cfg["max_output_tokens"]:
            raise RuntimeError("Pricing does not finance the frozen resource context")
        snapshot = study.load(directory / "pricing-endpoints" / f"{quote['endpoint_snapshot_sha256']}.json")
        if study.digest(snapshot["body"]) != quote["endpoint_snapshot_sha256"] or snapshot["body"]["data"]["id"] != model["model"]:
            raise RuntimeError("Raw endpoint snapshot hash or model identity mismatch")
        expected = study.endpoint_ceiling(snapshot["body"]["data"]["endpoints"], cfg)
        if any(quote.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Financial quote does not reproduce from immutable endpoint evidence")
        study.financial_prices(model)
        study.routing_max_price(model)
    return pricing


def batch_directory(out, batch_id):
    if not isinstance(batch_id, str) or not SAFE_NAME.fullmatch(batch_id):
        raise RuntimeError("Invalid batch identity")
    return Path(out) / "batches" / batch_id


def quote(out, panel_out, ledger_out, batch_id):
    _, cfg, _, _, _, _ = validate_manifest(out, panel_out, ledger_out)
    directory = batch_directory(out, batch_id)
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir()
    study.catalog(directory, cfg=cfg)
    pricing = validate_pricing(directory, cfg)
    return {"batch_id": batch_id, "pricing_sha256": study.digest(pricing), "fetched_at": pricing["fetched_at"]}


def attempted(out, rows, run):
    return (Path(out) / "rollouts" / run).exists() or any(row["run"] == run for row in rows)


def next_row(out, plan, rows):
    return next((row for row in plan["runs"] if not attempted(out, rows, row["run"])), None)


def phase_release(out, phase, manifest):
    if phase == "discovery":
        return {"phase_rule_sha256": None, "phase_decisions_sha256": None}
    rule_path = Path(out) / ("discovery-rule.json" if phase == "validation" else "holdout-rule.json")
    decisions_path = Path(out) / f"{phase}-decisions.json"
    if not rule_path.is_file() or not decisions_path.is_file():
        raise RuntimeError("Phase release requires its previously frozen rule and decisions")
    rule, decisions = study.load(rule_path), study.load(decisions_path)
    if rule.get("eval_manifest_sha256") != study.digest(manifest) or decisions.get("eval_manifest_sha256") != study.digest(manifest) or decisions.get("rule_sha256") != study.digest(rule):
        raise RuntimeError("Frozen phase rule/decisions belong to another evaluation")
    return {"phase_rule_sha256": study.digest(rule), "phase_decisions_sha256": study.digest(decisions)}


def check_batch_approval(out, manifest, plan, approval, batch_id, row):
    directory = batch_directory(out, batch_id)
    pricing = study.load(directory / "pricing.json")
    phase_rows = [item["run"] for item in plan["runs"] if item["phase"] == row["phase"]]
    runs = approval.get("runs")
    start = phase_rows.index(runs[0]) if isinstance(runs, list) and runs and runs[0] in phase_rows else None
    if start is None or runs != phase_rows[start:start + len(runs)]:
        raise RuntimeError("Batch approval must list a contiguous slice of one phase's frozen order")
    required = {"authorized": True, "action": "modern-eval-batch-v1", "phase": row["phase"], "batch_id": batch_id, "eval_manifest_sha256": study.digest(manifest), "pricing_sha256": study.digest(pricing), "source_sha256": source_hashes(), "accounting_authorization_sha256": manifest["original_metadata"].get("unknown_accounting_authorization_sha256"), **phase_release(out, row["phase"], manifest)}
    if any(approval.get(key) != value for key, value in required.items()) or row["run"] not in runs:
        raise RuntimeError("Exact batch phase/manifest/pricing/source/accounting/rule clearance required for this run")
    if not 0 <= time.time() - pricing["fetched_at"] <= PRICING_MAX_AGE_SECONDS:
        raise RuntimeError("Batch pricing is stale or future-dated; quote a new batch")
    return pricing


class SolverLifetimeClient:
    def __init__(self, client, seconds):
        self.containers = SimpleNamespace(create=lambda **options: client.containers.create(**{**options, "command": f"sleep {seconds}"}))


def solver_environment(out, task, cfg, run_dir):
    import docker
    from minisweagent.environments.docker import DockerEnvironment

    client = docker.from_env(timeout=1800)
    image = modern_panel.pinned_image(client, out, task)
    logger = SimpleNamespace(log_file=run_dir / "isolation" / "solver.log")
    container = study.isolated_create_container(SimpleNamespace(image=image.id), SolverLifetimeClient(client, cfg["wall_seconds"] + 1800), f"solver-{uuid.uuid4().hex}", logger)
    try:
        container.start()
        snapshot = modern_panel.prepare_base_snapshot(container, task, sanitize=True)
        container.reload()
        attrs = container.attrs
        isolation_path = run_dir / "isolation" / "isolation.json"
        isolation = {**study.load(isolation_path), "user": attrs["Config"]["User"], "memory": attrs["HostConfig"]["Memory"], "nano_cpus": attrs["HostConfig"]["NanoCpus"], "pids_limit": attrs["HostConfig"]["PidsLimit"], "snapshot": snapshot}
        if not modern_panel.isolation_valid(isolation, image.id) or attrs["HostConfig"]["Privileged"] is not False or any(re.search(r"(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)=.+", value, re.I) for value in attrs["Config"].get("Env", [])):
            raise RuntimeError("Solver container isolation differs from the proven runtime contract")
        study.save(isolation_path, isolation)
    except BaseException:
        container.remove(force=True)
        raise

    class ProvenContainerEnvironment(DockerEnvironment):
        def _start_container(self):
            self.container_id = container.id

        def cleanup(self):
            pass

    env = ProvenContainerEnvironment(image=image.id, cwd="/testbed", timeout=cfg["action_timeout_seconds"])
    env.study_base_tree = snapshot["base_tree"]
    return env, container


def route_unavailable(receipt):
    error = (receipt.get("response") or {}).get("error")
    message = error.get("message") if isinstance(error, dict) else None
    return receipt.get("dispatch_entered") is True and receipt.get("http_status") == 404 and isinstance(message, str) and UNAVAILABLE_ROUTE.search(message) is not None


def classify(ledger_out, run, result, timed_out):
    with sqlite3.connect(Path(ledger_out) / "budget.sqlite") as db:
        rows = study.request_rows(db)
    blocking = [row for row in rows if row["state"] not in {"settled", "accounted_unknown"}]
    unknown = [row for row in rows if row["run"] == run and row["state"] == "accounted_unknown"]
    limited = timed_out or result.get("exit_status") in {"BudgetLimited", "LimitsExceeded", "TimeExceeded"}
    if blocking:
        return "transport_unknown"
    if unknown:
        return "provider_unavailable" if all(route_unavailable(study.load(row["receipt"])) for row in unknown) else "transport_unknown"
    if result.get("exit_status") == "ProviderRefused":
        return "provider_refused"
    if limited:
        return "budget_limited"
    return "completed" if result.get("exit_status") in {"Submitted", "RepeatedFormatError"} else "infra_invalid"


def grade(out, task, run, patch):
    try:
        receipt = modern_panel.evaluate(out, task, run, patch)
    except Exception as error:
        return {"grade_valid": False, "reason": "grader_infra_invalid", "error": {"kind": getattr(error, "original_type", type(error).__name__), "message": str(error), "retryable": getattr(error, "retryable", False), "run_id": getattr(error, "run_id", None)}}
    result = receipt.get("result")
    case = result[1].get(task["instance_id"], {}) if isinstance(result, list) and len(result) > 1 and isinstance(result[1], dict) else {}
    return {**receipt, "grade_valid": type(case.get("resolved")) is bool}


def rollout(out, ledger_out, task, private, candidate, row, approval, cfg, manifest, batch_id, *, model_factory=None, classifier=None):
    from minisweagent.agents.default import DefaultAgent

    run = row["run"]
    run_dir = Path(out) / "rollouts" / run
    run_dir.mkdir(parents=True, exist_ok=False)
    study.save(run_dir / "approval.json", approval)
    started = time.time()
    metadata = {"run": run, "instance_id": task["instance_id"], "candidate": candidate["label"], "repetition": row["repetition"], "split": row["phase"], "experiment_id": cfg["experiment_id"], "batch_id": batch_id, "eval_manifest_sha256": study.digest(manifest), "approval_sha256": study.digest(approval), "source_sha256": source_hashes()}
    try:
        env, container = solver_environment(out, private, cfg, run_dir)
    except Exception as error:
        study.save(run_dir / "result.json", {**metadata, "elapsed_seconds": time.time() - started, "status": "infra_invalid", "result": {"exit_status": type(error).__name__, "message": str(error)}})
        study.save(run_dir / "evaluation.json", {"grade_valid": False, "reason": "infra_invalid"})
        raise
    deadline = time.monotonic() + cfg["wall_seconds"]
    original_execute = env.execute

    def execute_before_deadline(action, cwd="", *, timeout=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("WallTimeLimited before action execution")
        output = original_execute(action, cwd, timeout=min(timeout or env.config.timeout, cfg["action_timeout_seconds"], remaining))
        if output.get("extra", {}).get("exception_type") == "TimeoutExpired":
            raise TimeoutError("ActionTimeLimited: container command may still be running")
        return output

    env.execute = execute_before_deadline
    result, patch = {}, None
    try:
        factory = study.paid_model if model_factory is None else model_factory
        agent = DefaultAgent(factory(out, run, candidate, deadline, cfg=cfg, ledger_out=ledger_out), env, **study.agent_settings(cfg)["agent"], output_path=run_dir / "trajectory.json")
        try:
            result = agent.run(task=modern_panel.solver_input(task)["problem_statement"])
        except Exception as error:
            result = {"exit_status": type(error).__name__, "message": str(error), "resource_limit": getattr(error, "diagnostics", None)}
        timed_out = result.get("exit_status") == "TimeoutError" or time.monotonic() >= deadline
        status = (classify if classifier is None else classifier)(ledger_out, run, result, timed_out)
        if not timed_out and status in {"completed", "budget_limited"}:
            captured = original_execute({"command": f"git add -N . && git diff --binary {env.study_base_tree}"})
            if captured["returncode"] != 0:
                status = "infra_invalid"
                result = {"exit_status": "PatchCaptureError", "message": captured["exception_info"]}
            else:
                patch = captured["output"]
                (run_dir / "prediction.patch").write_text(patch)
                study.save(run_dir / "prediction.json", {"instance_id": task["instance_id"], "model_name_or_path": candidate["label"], "model_patch": patch})
        study.save(run_dir / "result.json", {**metadata, "elapsed_seconds": time.time() - started, "status": status, "result": result, "resources": study.resource_summary(out, ledger_out, run, cfg, result, wall_exhausted=time.monotonic() >= deadline)})
    finally:
        try:
            container.remove(force=True)
        except Exception as error:
            if getattr(error, "status_code", None) != 404:
                raise
    evaluation = grade(out, private, run, patch) if patch is not None else {"grade_valid": False, "reason": status}
    study.save(run_dir / "evaluation.json", evaluation)
    summary = {"run": run, "status": status, "grade_valid": evaluation["grade_valid"]}
    print(json.dumps(summary))
    if status not in {"completed", "budget_limited"} or evaluation.get("reason") == "grader_infra_invalid":
        raise RunStopped(run, status if evaluation.get("reason") != "grader_infra_invalid" else "grader_infra_invalid")
    return summary


def solve(out, panel_out, ledger_out, batch_id, run, approval_path):
    out, panel_out, ledger_out = separate_roots(out, panel_out, ledger_out)
    with (ledger_out / ".writer.lock").open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, cfg, plan, tasks, private, rows = validate_manifest(out, panel_out, ledger_out)
        row = next_row(out, plan, rows)
        if row is None or row["run"] != run:
            raise RuntimeError("Only the next frozen evaluation row may execute; attempted runs are never retried")
        approval = study.load(approval_path)
        pricing = check_batch_approval(out, manifest, plan, approval, batch_id, row)
        if not os.environ.get("OPENROUTER_API_KEY"):
            raise RuntimeError("No host-only provider key")
        task = next(item for item in tasks if item["instance_id"] == row["instance_id"])
        candidate = next(model for model in pricing["models"] if model["label"] == row["candidate"])
        return rollout(out, ledger_out, task, private[row["instance_id"]], candidate, row, approval, cfg, manifest, batch_id)


def run_batch(out, panel_out, ledger_out, batch_id, approval_path, lease_deadline):
    approval = study.load(approval_path)
    completed = []
    while True:
        manifest, cfg, plan, _, _, rows = validate_manifest(out, panel_out, ledger_out)
        row = next_row(out, plan, rows)
        if row is None or row["run"] not in approval.get("runs", []):
            return {"stopped": "batch_complete", "completed": completed, "next_run": row["run"] if row else None}
        required = cfg["wall_seconds"] + modern_panel.config()["evaluator_timeout_seconds"] + LEASE_MARGIN_SECONDS
        if lease_deadline - time.time() < required:
            return {"stopped": "lease_checkpoint", "completed": completed, "next_run": row["run"], "required_seconds": required}
        completed.append(solve(out, panel_out, ledger_out, batch_id, row["run"], approval_path))


def regrade(out, panel_out, ledger_out, run):
    out, panel_out, ledger_out = separate_roots(out, panel_out, ledger_out)
    with (ledger_out / ".writer.lock").open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _, _, plan, _, private, _ = validate_manifest(out, panel_out, ledger_out)
        row = next((item for item in plan["runs"] if item["run"] == run), None)
        run_dir = out / "rollouts" / run
        if row is None or not (run_dir / "prediction.json").is_file() or study.load(run_dir / "evaluation.json").get("reason") != "grader_infra_invalid":
            raise RuntimeError("Grade-only recovery requires a saved patch whose grader failed")
        prediction = study.load(run_dir / "prediction.json")
        previous = study.load(run_dir / "evaluation.json")
        current = grade(out, private[row["instance_id"]], run, prediction["model_patch"])
        study.save(run_dir / "grades" / f"{uuid.uuid4().hex}.json", {"previous": previous, "current": current})
        study.save(run_dir / "evaluation.json", current)
        return {"run": run, "grade_valid": current["grade_valid"], "reason": current.get("reason")}


def phase_rows(out, ledger_rows, plan, phase):
    rows, operational, missing = {}, {}, []
    arms = defaultdict(lambda: {"statuses": Counter(), "capsFired": Counter()})
    for task_id, label in sorted({(item["instance_id"], item["candidate"]) for item in plan["runs"] if item["phase"] == phase}):
        primary, secondary, complete, excluded = [], [], True, False
        for repetition in range(REPETITIONS[phase]):
            run = f"{plan['experiment_id']}--{task_id}--{label}--{repetition}"
            directory = Path(out) / "rollouts" / run
            if not (directory / "result.json").is_file() or not (directory / "evaluation.json").is_file():
                missing.append(run)
                complete = False
                continue
            result, evaluation = study.load(directory / "result.json"), study.load(directory / "evaluation.json")
            status = result.get("status")
            arms[label]["statuses"][status] += 1
            arms[label]["capsFired"].update(result.get("resources", {}).get("caps_fired", []))
            billed = [row for row in ledger_rows if row["run"] == run]
            known = sum((Decimal(row["actual"]) for row in billed if row["state"] == "settled" and row["actual"] is not None), Decimal(0))
            upper = sum((study.held_cost(row) for row in billed), Decimal(0))
            unresolved = any(row["state"] != "settled" or row["actual"] is None for row in billed)
            attempt = {"known": float(known), "cost": None if unresolved else float(known), "upper": float(upper), "elapsed": result.get("elapsed_seconds"), "status": status}
            if status in OPERATIONAL_STATUSES:
                excluded = True
                secondary.append({**attempt, "resolved": False, "hiddenGradeValid": False})
                continue
            if status == "infra_invalid" or not billed and status != "budget_limited":
                missing.append(run)
                complete = False
                continue
            report = evaluation.get("result")
            case = report[1].get(task_id, {}) if isinstance(report, list) and len(report) > 1 and isinstance(report[1], dict) else {}
            error = evaluation.get("error") or {}
            test_timeout = evaluation.get("reason") == "grader_infra_invalid" and error.get("kind") == "EvaluationError" and "Test timed out after" in str(error.get("message"))
            if test_timeout:
                arms[label]["statuses"]["candidate_test_timeout"] += 1
            resolved = case.get("resolved") if type(case.get("resolved")) is bool else False if test_timeout or status in {"budget_limited", "transport_unknown"} and evaluation.get("reason") in {"budget_limited", "transport_unknown"} else None
            if type(resolved) is not bool:
                missing.append(run)
                complete = False
                continue
            graded = {**attempt, "resolved": resolved, "hiddenGradeValid": type(case.get("resolved")) is bool}
            primary.append(graded)
            secondary.append(graded)
        if complete and not excluded:
            rows[(task_id, label)] = primary
        if complete:
            operational[(task_id, label)] = secondary
    report_arms = {label: {"statuses": dict(value["statuses"]), "capsFired": dict(value["capsFired"])} for label, value in sorted(arms.items())}
    return rows, operational, missing, report_arms


def oracle_choices(tasks, arms, rows):
    def mean(task, arm, key):
        attempts = rows[(task["instance_id"], arm)]
        return sum(attempt[key] for attempt in attempts) / len(attempts)

    return {task["instance_id"]: min(arms, key=lambda arm: (-mean(task, arm, "resolved"), mean(task, arm, "known"), arm)) for task in tasks}


def pools(candidates):
    return {pool: [candidate["label"] for candidate in candidates if candidate["label"].startswith(pool + "-")] for pool in sorted({candidate["label"].split("-", 1)[0] for candidate in candidates})}


def analyze_phase(out, panel_out, ledger_out, phase):
    manifest, cfg, plan, tasks, _, ledger_rows = validate_manifest(out, panel_out, ledger_out)
    manifest_hash = study.digest(manifest)
    phase_tasks = [task for task in tasks if task["split"] == phase]
    rows, operational, missing, arms = phase_rows(out, ledger_rows, plan, phase)
    report = {"version": 1, "phase": phase, "eval_manifest_sha256": manifest_hash, "missingOrInvalidRuns": missing, "arms": arms, "pools": {}}
    report["outcomeDefinition"] = "Primary: resolved within frozen calibration resources. Budget/time exhaustion and unresolved transport are completion failures with held upper cost. Provider-unavailable/refused rows are operational, excluded as paired cases from that pool only. Infrastructure-invalid or missing rows block the phase freeze."
    report["operationalDefinition"] = "Secondary operational metrics count provider-unavailable/refused rows as unresolved at their retained upper cost; they never drive freezes or gates."
    report["billingDefinition"] = "Unresolved bills are not zero: settled charges are lower bounds and every retained hold is part of the upper bound."
    report["limitations"] = ["Seven public 2026 repository families are a feasibility panel, not population-level evidence; contamination remains possible.", "Policy predictions use issue text only, never hidden tests or task IDs.", "Selection replays independent fixed-model runs, not production classifier-inclusive routing.", "Costs exclude VM infrastructure and predictor CPU.", "Authorized Opus exclusion prevents a superiority claim over the original full pool."]
    frozen = {"version": 1, "eval_manifest_sha256": manifest_hash, "source_sha256": source_hashes(), "exclusion_manifest_sha256": manifest["exclusion_manifest_sha256"], "pools": {}}
    prior = None if phase == "discovery" else study.load(Path(out) / ("discovery-rule.json" if phase == "validation" else "holdout-rule.json"))
    if prior is not None and (prior.get("eval_manifest_sha256") != manifest_hash or prior.get("source_sha256") != source_hashes()):
        raise ValueError("Frozen rule belongs to another evaluation or analysis source")
    blocked = False
    for pool, pool_arms in pools(cfg["candidates"]).items():
        pool_missing = [task["instance_id"] for task in phase_tasks if any((task["instance_id"], arm) not in operational for arm in pool_arms)]
        excluded = [task["instance_id"] for task in phase_tasks if task["instance_id"] not in pool_missing and any((task["instance_id"], arm) not in rows for arm in pool_arms)]
        complete = [task for task in phase_tasks if all((task["instance_id"], arm) in rows for arm in pool_arms)]
        coverage = {"phaseTasks": len(phase_tasks), "completeTasks": len(complete), "operationallyExcludedTasks": excluded, "missingTasks": pool_missing, "coverage": len(complete) / len(phase_tasks) if phase_tasks else None}
        if pool_missing:
            blocked = True
            report["pools"][pool] = {"status": "incomplete", **coverage}
            continue
        if prior is not None and prior["pools"].get(pool, {}).get("status") == "insufficient_coverage":
            report["pools"][pool] = {"status": "no_frozen_rule", **coverage}
            frozen["pools"][pool] = prior["pools"][pool]
            continue
        if not complete or Decimal(len(complete)) < MINIMUM_POOL_COVERAGE * len(phase_tasks):
            report["pools"][pool] = {"status": "insufficient_coverage", **coverage}
            frozen["pools"][pool] = {"status": "insufficient_coverage", **coverage}
            continue
        if phase == "discovery":
            priors = {arm: sum(sum(row["resolved"] for row in rows[(task["instance_id"], arm)]) / len(rows[(task["instance_id"], arm)]) for task in complete) / len(complete) for arm in pool_arms}
            mean_cost = {arm: None if any(row["cost"] is None for task in complete for row in rows[(task["instance_id"], arm)]) else sum(row["known"] for task in complete for row in rows[(task["instance_id"], arm)]) / sum(len(rows[(task["instance_id"], arm)]) for task in complete) for arm in pool_arms}
            baseline = min(pool_arms, key=lambda arm: (-priors[arm], mean_cost[arm] if mean_cost[arm] is not None else float("inf"), arm))
            rule = {"status": "frozen", "baseline": baseline, "active": "full", "gainThreshold": 0.1, "priors": priors, "trainingMeanCost": mean_cost, "training": [{"text": task["problem_statement"], "quality": {arm: sum(row["resolved"] for row in rows[(task["instance_id"], arm)]) / len(rows[(task["instance_id"], arm)]) for arm in pool_arms}} for task in complete], "coverage": coverage}
            frozen["pools"][pool] = rule
        else:
            rule = prior["pools"][pool]
            baseline = rule["baseline"]
            if baseline not in pool_arms or set(rule["priors"]) != set(pool_arms):
                raise ValueError("Frozen policy contains a candidate outside the authorized scope")
        references = {arm: analyze.metrics(complete, {task["instance_id"]: arm for task in complete}, rows, baseline) for arm in pool_arms}
        selections = {surface: {task["instance_id"]: analyze.predict(task, rule, surface) for task in complete} for surface in ["prefix", "full"]}
        estimates = {surface: analyze.metrics(complete, choices, rows, baseline) for surface, choices in selections.items()}
        active = rule.get("active", "full")
        if phase == "validation":
            candidate, base = estimates["full"], references[baseline]
            accepted = candidate["quality"] > base["quality"] and candidate["costPerSuccessUpperUsd"] is not None and (base["quality"] == 0 or (base["costPerSuccessLowerUsd"] is not None and candidate["costPerSuccessUpperUsd"] <= base["costPerSuccessLowerUsd"]))
            active = "full" if accepted else "fixed"
            frozen["pools"][pool] = {**rule, "active": active, "validationPassed": accepted, "validationCoverage": coverage}
        repeatable = [{"task": task["instance_id"], "alternative": arm} for task in complete for arm in pool_arms if arm != baseline and all(not row["resolved"] for row in rows[(task["instance_id"], baseline)]) and all(row["resolved"] for row in rows[(task["instance_id"], arm)])]
        graded = [task for task in complete if all(row["hiddenGradeValid"] for arm in pool_arms for row in rows[(task["instance_id"], arm)])]
        operational_tasks = [task for task in phase_tasks if all((task["instance_id"], arm) in operational for arm in pool_arms)]
        report["pools"][pool] = {
            "status": "complete",
            **coverage,
            "baseline": baseline,
            "fixedReferences": references,
            "issueTextAblations": estimates,
            "activePolicy": active,
            "activeMetrics": references[baseline] if active == "fixed" else estimates["full"],
            "hindsightOracle": analyze.metrics(complete, oracle_choices(complete, pool_arms, rows), rows, baseline),
            "repeatableOperationalRescues": repeatable if phase == "discovery" else None,
            "repeatableRescues": [rescue for rescue in repeatable if all(row["hiddenGradeValid"] for arm in [baseline, rescue["alternative"]] for row in rows[(rescue["task"], arm)])] if phase == "discovery" else None,
            "commonHiddenGradedPanel": {"tasks": len(graded), "families": len({task["repo"] for task in graded}), "fixedReferences": {arm: analyze.metrics(graded, {task["instance_id"]: arm for task in graded}, rows, baseline) for arm in pool_arms}},
            "operationalSecondary": {"tasks": len(operational_tasks), "fixedReferences": {arm: analyze.metrics(operational_tasks, {task["instance_id"]: arm for task in operational_tasks}, operational, baseline) for arm in pool_arms}, "issueTextFull": analyze.metrics(operational_tasks, {task["instance_id"]: analyze.predict(task, rule, "full") for task in operational_tasks}, operational, baseline)},
        }
    if phase != "holdout" and not blocked:
        analyze.write_frozen(Path(out) / ("discovery-rule.json" if phase == "discovery" else "holdout-rule.json"), frozen)
    study.save(Path(out) / f"{phase}-analysis.json", report)
    return report


def freeze_decisions(out, panel_out, ledger_out, phase):
    if phase not in {"validation", "holdout"}:
        raise ValueError("Only unseen validation/holdout decisions can be frozen")
    manifest, cfg, plan, tasks, _, ledger_rows = validate_manifest(out, panel_out, ledger_out)
    if any(row["phase"] == phase and attempted(out, ledger_rows, row["run"]) for row in plan["runs"]):
        raise ValueError("Decisions must be frozen before any row of their phase is attempted")
    rule = study.load(Path(out) / ("discovery-rule.json" if phase == "validation" else "holdout-rule.json"))
    if rule.get("eval_manifest_sha256") != study.digest(manifest) or rule.get("source_sha256") != source_hashes():
        raise ValueError("Frozen rule belongs to another evaluation or analysis source")
    choices = {pool: {task["instance_id"]: training["baseline"] if training["active"] == "fixed" else analyze.predict(task, training, "full") for task in tasks if task["split"] == phase} for pool, training in rule["pools"].items() if training.get("status") == "frozen"}
    active = {candidate["label"] for candidate in cfg["candidates"]}
    if any(choice not in active for pool in choices.values() for choice in pool.values()):
        raise ValueError("Frozen policy selects a candidate outside the authorized scope")
    artifact = {"phase": phase, "eval_manifest_sha256": study.digest(manifest), "rule_sha256": study.digest(rule), "exclusion_manifest_sha256": manifest["exclusion_manifest_sha256"], "choices": choices, "unfrozenPools": sorted(pool for pool, training in rule["pools"].items() if training.get("status") != "frozen")}
    analyze.write_frozen(Path(out) / f"{phase}-decisions.json", artifact)
    return artifact







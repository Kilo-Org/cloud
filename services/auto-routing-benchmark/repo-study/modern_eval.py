"""Solver rollout pieces still used by the router study.

The historical modern evaluation study paths were removed in the gateway
cutover. Only pin verification, the isolated solver environment, outcome
classification, grading, and the rollout loop remain.
"""

import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from types import SimpleNamespace
import uuid

import modern_panel
import study

HERE = Path(__file__).resolve().parent
SOURCE_FILES = ("modern_eval.py", "modern_panel.py", "study.py", "analyze.py")
UNAVAILABLE_ROUTE = re.compile(r"no allowed providers|no endpoints found", re.IGNORECASE)


class RunStopped(RuntimeError):
    def __init__(self, run, status):
        super().__init__(f"STOP after {run}: {status}; preserve receipts and ledger, never retry this run")
        self.run = run
        self.status = status


def source_hashes():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def verify_pins():
    import minisweagent

    root = Path(minisweagent.__file__).resolve().parent
    revision = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], check=True, capture_output=True, text=True).stdout.strip()
    if revision != study.config()["mini_revision"] or dirty:
        raise RuntimeError("Solver must use the clean pinned mini-SWE-agent revision")
    modern_panel.verify_harness()


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

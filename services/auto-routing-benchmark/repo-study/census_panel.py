import hashlib
import re
import uuid
from pathlib import Path
from types import SimpleNamespace

import modern_panel as modern
import study

HERE = Path(__file__).resolve().parent
AUTHORIZATIONS = Path("/Users/igor/Projects/.artifacts/router-headroom-census-20261028")


def config():
    return study.load(HERE / "census-panel.json")


def implementation_hashes():
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(__file__), Path(modern.__file__), Path(study.__file__)]}


def evidence_implementation_hashes(*, source_transition=None):
    current = implementation_hashes()
    if source_transition is None:
        return current
    previous, amended = source_transition["from_source_sha256"], source_transition["to_source_sha256"]
    if not set(current).issubset(previous) or current != {name: amended.get(name) for name in current}:
        raise RuntimeError("Census readiness drivers differ from the authorized source transition")
    return {name: previous[name] for name in current}


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def create_only(path, value):
    path = Path(path)
    if path.exists():
        if study.load(path) != value:
            raise RuntimeError(f"Frozen census artifact changed: {path.name}")
        return
    modern.private_save(path, value)


def panel_shape(cfg):
    target = cfg["target_tasks"]
    minimum, maximum = cfg["min_tasks_per_repository"], cfg["max_tasks_per_repository"]
    families = cfg.get("families")
    if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in [target, minimum, maximum]) or minimum > maximum:
        raise ValueError("Invalid census target or per-repository task bounds")
    if families is not None and (isinstance(families, bool) or not isinstance(families, int) or families <= 0 or not families * minimum <= target <= families * maximum):
        raise ValueError("Family target is incompatible with census task bounds")
    return target, minimum, maximum, families


def authorization_inputs(cfg, preregistration, amendment):
    paths = {"preregistration_sha256": Path(preregistration), "panel_amendment_sha256": Path(amendment)}
    hashes = {key: file_hash(path) for key, path in paths.items()}
    if any(hashes[key] != cfg[key] for key in hashes):
        raise RuntimeError("Census authorization file differs from its approved byte hash")
    change = study.load(paths["panel_amendment_sha256"])
    if change.get("amends_preregistration_sha256") != hashes["preregistration_sha256"] or change.get("model_outcomes_observed") is not False or change.get("paid_calls_before_amendment") != 0:
        raise RuntimeError("Panel amendment does not prospectively amend this preregistration")
    if any(change["panel"].get(key) != cfg[key] for key in ["created_at_min", "target_tasks", "min_tasks_per_repository", "max_tasks_per_repository"]):
        raise RuntimeError("Census shape differs from the approved panel amendment")
    return hashes, paths


def exclusion_config(cfg, prior_panel, modern_panel, modern_cfg):
    tasks = list(prior_panel["tasks"]) + list(modern_panel["tasks"])
    families = [row["repo"] for row in tasks]
    families.extend(row["repo"] for row in modern_panel.get("selection", {}).get("families", []))
    return {**cfg, "family_pool": None,
            "excluded_families": sorted({modern.canonical_repo(repo) for repo in cfg["excluded_families"] + modern_cfg["excluded_families"] + families}),
            "excluded_alias_families": sorted({modern.canonical_repo(repo) for repo in cfg["excluded_alias_families"] + modern_cfg["excluded_alias_families"]}),
            "excluded_instance_ids": sorted(set(cfg["excluded_instance_ids"] + modern_cfg["excluded_instance_ids"] + [row["instance_id"] for row in tasks]))}


def candidate_order(rows, cfg, prior_tasks):
    rejections = []
    _, minimum, _, _ = panel_shape(cfg)
    groups = modern.eligible_rows(rows, {**cfg, "tasks_per_family": minimum}, prior_tasks, rejections, record_all_rejections=True)
    families, tasks = [], []
    for family in sorted(groups, key=lambda name: modern.rank(cfg, "family", name)):
        ordered = [{**row, "split": "census"} for row in groups[family]]
        families.append({"repo": family, "selection_hash": modern.rank(cfg, "family", family), "instance_ids": [row["instance_id"] for row in ordered]})
        tasks.extend(ordered)
    return families, tasks, sorted(rejections, key=lambda item: (item["family"], item.get("instance_id", "")))


def prepare(out, prior_panel, modern_panel_path, *, rows=None, cfg=None, preregistration=None, amendment=None):
    out = Path(out).resolve()
    cfg = config() if cfg is None else cfg
    authorizations, authorization_paths = authorization_inputs(cfg, preregistration or AUTHORIZATIONS / "preregistration.json", amendment or AUTHORIZATIONS / "amendment-v1-panel-shape.json")
    prior, previous = study.load(prior_panel), study.load(modern_panel_path)
    modern_cfg = modern.config()
    if not prior.get("tasks") or not previous.get("tasks"):
        raise ValueError("Both classic and modern historical panels must contain tasks")
    inputs = {"prior_panel_sha256": study.digest(prior), "modern_panel_sha256": study.digest(previous), "modern_config_sha256": study.digest(modern_cfg), "source_config_sha256": study.digest(cfg)}
    inputs.update(authorizations)
    if (out / "candidates.json").exists():
        manifest, _, _ = check_candidates(out)
        if manifest["inputs"] != inputs:
            raise RuntimeError("Historical exclusions or source config changed after candidate freeze")
        return manifest
    if out.exists() and any(out.iterdir()):
        raise RuntimeError("Census preparation requires an empty separate output directory")
    if rows is None:
        from datasets import load_dataset
        rows = list(load_dataset(cfg["dataset"], revision=cfg["dataset_revision"], split=cfg["dataset_split"]))
    else:
        rows = list(rows)
    effective = exclusion_config(cfg, prior, previous, modern_cfg)
    families, tasks, rejected = candidate_order(rows, effective, prior["tasks"] + previous["tasks"])
    target, minimum, maximum, family_target = panel_shape(effective)
    capacity = sum(min(maximum, len(family["instance_ids"])) for family in families)
    if capacity < target or (family_target is not None and len(families) < family_target):
        raise RuntimeError(f"Eligible candidates can supply only {capacity} tasks across {len(families)} families; need {target} tasks")
    manifest = {"schema": "census-candidate-order-v1", "config_sha256": study.digest(effective), "inputs": inputs,
                "dataset": cfg["dataset"], "dataset_revision": cfg["dataset_revision"], "dataset_split": cfg["dataset_split"],
                "source_rows_sha256": study.digest(rows), "seed": cfg["seed"], "families": families,
                "tasks": [{**{key: row[key] for key in modern.PUBLIC_FIELDS}, "family": row["family"], "split": "census", "selection_hash": modern.rank(cfg, "task", row["instance_id"]), "fixture_sha256": study.digest(row)} for row in tasks],
                "eligibility_rejections": rejected, "implementation_hashes": implementation_hashes(),
                "algorithm": "SHA256 canonical JSON [seed,kind,value]; every eligible family and all its eligible tasks, frozen before any readiness lookup; up to the configured maximum ready tasks per family, stopping at the target task count", "outcomes_used": False}
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    out.chmod(0o700)
    for name, value in [("census-config.json", effective), ("provenance/classic-panel.json", prior), ("provenance/modern-panel.json", previous), ("provenance/modern-config.json", modern_cfg), ("evaluator/candidates.json", tasks), ("candidates.json", manifest)]:
        create_only(out / name, value)
    for key, source in authorization_paths.items():
        destination = out / "authorizations" / ("preregistration.json" if key == "preregistration_sha256" else "panel-amendment.json")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination.write_bytes(source.read_bytes())
        destination.chmod(0o600)
    return manifest


def check_candidates(out, *, source_transition=None):
    out = Path(out).resolve()
    manifest = study.load(out / "candidates.json")
    cfg = study.load(out / "census-config.json")
    tasks = study.load(out / "evaluator" / "candidates.json")
    if manifest["config_sha256"] != study.digest(cfg):
        raise RuntimeError("Frozen census configuration changed")
    if manifest["inputs"]["source_config_sha256"] != study.digest(config()):
        raise RuntimeError("Census source configuration changed after candidate freeze")
    for key, path in [("prior_panel_sha256", "classic-panel.json"), ("modern_panel_sha256", "modern-panel.json"), ("modern_config_sha256", "modern-config.json")]:
        if manifest["inputs"][key] != study.digest(study.load(out / "provenance" / path)):
            raise RuntimeError("Historical exclusion provenance changed")
    for key, name in [("preregistration_sha256", "preregistration.json"), ("panel_amendment_sha256", "panel-amendment.json")]:
        if file_hash(out / "authorizations" / name) != manifest["inputs"][key] or manifest["inputs"][key] != cfg[key]:
            raise RuntimeError("Frozen census authorization bytes changed")
    ordered = [row["instance_id"] for row in tasks]
    if ordered != [task_id for family in manifest["families"] for task_id in family["instance_ids"]] or len(set(ordered)) != len(ordered):
        raise RuntimeError("Candidate order or identities changed")
    if [(row["instance_id"], study.digest(row)) for row in tasks] != [(row["instance_id"], row["fixture_sha256"]) for row in manifest["tasks"]]:
        raise RuntimeError("Frozen candidate payload changed")
    if manifest["implementation_hashes"] != evidence_implementation_hashes(source_transition=source_transition):
        raise RuntimeError("Census readiness drivers changed after candidate freeze")
    return manifest, cfg, tasks


def select_ready(manifest, records, cfg):
    target, minimum, maximum, family_target = panel_shape(cfg)
    selected, families = [], []
    for family in manifest["families"]:
        ready = []
        remaining = target - len(selected)
        slots = family_target - len(families) if family_target is not None else None
        count = min(maximum, remaining - minimum * (slots - 1) if slots is not None else remaining)
        if count < minimum:
            break
        for task_id in family["instance_ids"]:
            if task_id not in records:
                return {"instance_ids": selected, "families": families, "next_instance": task_id, "complete": False, "exhausted": False}
            if not isinstance(records[task_id].get("ready"), bool):
                raise ValueError(f"Nonterminal readiness record: {task_id}")
            if records[task_id]["ready"]:
                ready.append(task_id)
            if len(ready) == count:
                break
        if len(ready) >= minimum:
            selected.extend(ready)
            families.append({**family, "instance_ids": ready})
        if len(selected) == target and (family_target is None or len(families) == family_target):
            return {"instance_ids": selected, "families": families, "next_instance": None, "complete": True, "exhausted": False}
        if family_target is not None and len(families) == family_target:
            break
    return {"instance_ids": selected, "families": families, "next_instance": None, "complete": False, "exhausted": True}


def load_progress(out, manifest, cfg, *, source_transition=None):
    hashes = evidence_implementation_hashes(source_transition=source_transition)
    path = out / "readiness-progress.json"
    progress = study.load(path) if path.exists() else {"schema": "census-readiness-progress-v1", "candidates_sha256": study.digest(manifest), "attempt_order": [], "records": {}}
    if progress["candidates_sha256"] != study.digest(manifest) or set(progress["attempt_order"]) != set(progress["records"]) or len(progress["attempt_order"]) != len(progress["records"]):
        raise RuntimeError("Readiness progress is not bound to the frozen candidate order")
    replay = {}
    for task_id in progress["attempt_order"]:
        if select_ready(manifest, replay, cfg)["next_instance"] != task_id:
            raise RuntimeError("Readiness checks ran out of preregistered replacement order")
        record = progress["records"][task_id]
        path = out / "readiness-tasks" / f"{task_id}.json"
        if not path.exists() or study.load(path) != record or record.get("implementation_hashes") != hashes or record.get("candidates_sha256") != study.digest(manifest):
            raise RuntimeError("Readiness record changed or belongs to different drivers")
        replay[task_id] = record
    return progress


class StructuralIneligibility(RuntimeError):
    def __init__(self, reason, details):
        super().__init__(str(details))
        self.reason, self.details = reason, details


def rejection_reason(out, task, stage, error):
    message = str(error)
    if "submodule gitlinks" in message:
        reason = "base_commit_contains_gitlinks"
    elif stage == "validate":
        path = out / "fixtures" / f"{task['instance_id']}.json"
        fixture = study.load(path) if path.exists() else {}
        semantic = [label for attempt in fixture.get("attempts", []) for label in attempt.get("semantic_failures", [])]
        return {"stage": stage, "reason": "fixture_semantic_failure" if semantic else "fixture_infrastructure_invalid", "semantic_failures": semantic, "kind": type(error).__name__, "message": message}
    else:
        reason = {"repository": "repository_identity_unverified", "license": "base_commit_license_unverified", "resources": "source_resource_contract", "pin": "image_pin_failure", "base": "base_snapshot_ineligible", "image-audit": "image_audit_ineligible", "runtime": "runtime_proof_ineligible", "evidence": "readiness_evidence_invalid"}[stage]
    return {"stage": stage, "reason": reason, "kind": type(error).__name__, "message": message}


def structural_rejection(out, task, stage, error):
    if isinstance(error, StructuralIneligibility):
        return {"stage": stage, "reason": error.reason, "details": error.details}
    task_id = task["instance_id"]
    if stage == "base":
        path = out / "base-checks" / task_id / "probe.json"
        probe = study.load(path) if path.exists() else {}
        if probe.get("fixture_sha256") == study.digest(task):
            if probe.get("base_gitlinks"):
                return {"stage": stage, "reason": "base_commit_contains_gitlinks", "details": probe["base_gitlinks"]}
            if probe.get("setup_patch_overlap"):
                return {"stage": stage, "reason": "image_setup_overlaps_gold_or_test_paths", "details": probe["setup_patch_overlap"]}
    if stage == "validate":
        reason = rejection_reason(out, task, stage, error)
        if reason.get("semantic_failures"):
            return reason
    if stage in {"image-audit", "runtime"}:
        path = out / ("image-audits" if stage == "image-audit" else "runtime") / f"{task_id}.json"
        audit = study.load(path) if path.exists() else {}
        if audit.get("fixture_sha256") == study.digest(task) and audit.get("forbidden_hits"):
            return {"stage": stage, "reason": "retained_forbidden_image_content", "details": audit["forbidden_hits"]}
    if stage == "runtime":
        if str(error) in {"Runtime smoke requires the source dataset string test_cmd", "Runtime smoke supports only the source dataset pytest runner"}:
            return {"stage": stage, "reason": "unsupported_source_test_runner", "details": task["install_config"]}
        path = out / "runtime-logs" / task_id / "unchanged.json"
        unchanged = study.load(path) if path.exists() else {}
        if unchanged.get("fixture_sha256") == study.digest(task) and unchanged.get("exit_code") == 1 and "diff --git " in unchanged.get("output", ""):
            return {"stage": stage, "reason": "runtime_smoke_modified_base_source", "details": unchanged}
        for name in ["import", "smoke"]:
            path = out / "runtime-logs" / task_id / f"{name}.json"
            proof = study.load(path) if path.exists() else {}
            if proof.get("valid") is False and ("discovery_attempts" in proof if name == "import" else "attempts" in proof):
                return {"stage": stage, "reason": "runtime_import_ineligible" if name == "import" else "runtime_retained_test_ineligible", "details": proof}
    return None


def probe_base(out, task, image, client):
    logger = SimpleNamespace(log_file=out / "base-checks" / task["instance_id"] / "base.log")
    container = study.isolated_create_container(SimpleNamespace(image=image.id), client, f"census-base-{uuid.uuid4().hex}", logger)
    try:
        container.start()
        snapshot = modern.prepare_base_snapshot(container, task, sanitize=True, report_path=out / "base-checks" / task["instance_id"] / "probe.json")
        modern.private_save(out / "base-checks" / task["instance_id"] / "snapshot.json", snapshot)
    finally:
        container.remove(force=True)


def readiness_task(out, task, cfg):
    out = Path(out).resolve()
    driver = modern.panel_driver(cfg, implementation_hashes(), [task])
    task_id, stage, client = task["instance_id"], "resources", None
    record = {"ready": False, "instance_id": task_id, "family": task["family"], "fixture_sha256": study.digest(task), "rejections": []}
    try:
        resources = driver.resource_contract(task, out)
        if not resources["compatible"]:
            raise StructuralIneligibility("source_resource_contract", resources)
        stage = "repository"
        identity = modern.github_json(f"https://api.github.com/repos/{task['family']}")
        canonical = modern.canonical_repo(identity["full_name"])
        if canonical != task["family"]:
            raise StructuralIneligibility("repository_identity_unverified", {"expected": task["family"], "canonical": canonical})
        if isinstance(identity.get("id"), bool) or not isinstance(identity.get("id"), int):
            raise RuntimeError("Repository metadata lacks a valid immutable numeric identity")
        for path in sorted((out / "repositories").glob("*.json")) if (out / "repositories").exists() else []:
            previous = study.load(path)
            if previous["id"] == identity["id"] and modern.canonical_repo(previous["full_name"]) != task["family"]:
                raise StructuralIneligibility("duplicate_canonical_repository_identity", {"identity": identity, "previous": previous})
        identity = {key: identity.get(key) for key in ["full_name", "id", "html_url"]}
        create_only(out / "repositories" / f"{task_id}.json", identity)
        stage = "license"
        evidence = modern.license_evidence(task)
        if evidence.get("spdx_id") not in cfg["accepted_repo_licenses"]:
            record["rejections"].append({"stage": stage, "reason": "repository_license_not_allowlisted", "spdx_id": evidence.get("spdx_id"), "details": evidence.get("rejection")})
            modern.private_save(out / "licenses" / f"{task_id}.json", evidence)
            return record
        create_only(out / "licenses" / f"{task_id}.json", evidence)
        create_only(out / "license-checks" / f"{task_id}.json", modern.verify_license_blob(task, evidence))
        stage = "pin"
        import docker
        if not task["image"].startswith("swerebench/"):
            raise StructuralIneligibility("unexpected_public_image_namespace", {"image": task["image"]})
        client = docker.from_env(timeout=3600)
        image = modern.pinned_image(client, out, task)
        stage = "base"
        probe_base(out, task, image, client)
        stage = "image-audit"
        driver.audit_images(out, [task_id])
        stage = "validate"
        driver.validate(out, [task_id])
        stage = "runtime"
        driver.runtime_proof(out, [task_id])
        stage = "evidence"
        record["evidence"] = validate_task_evidence(out, task, cfg)
        record["ready"] = True
    except Exception as error:
        reason = structural_rejection(out, task, stage, error)
        if reason is None:
            modern.private_save(out / "readiness-errors" / f"{task_id}-{uuid.uuid4().hex}.json", {"instance_id": task_id, "fixture_sha256": study.digest(task), "implementation_hashes": implementation_hashes(), "stage": stage, "kind": type(error).__name__, "message": str(error), "terminal_structural_rejection": False})
            raise
        record["rejections"].append(reason)
    finally:
        if client is not None:
            client.close()
    return record


def remove_task_images(out, task):
    import docker

    path = out / "images" / f"{task['instance_id']}.json"
    if not path.exists():
        return {"removed": [], "reason": "no_pinned_image"}
    image = study.load(path)
    client = docker.from_env(timeout=3600)
    removed, errors = [], []
    try:
        for reference in dict.fromkeys([image["digest"], image["source_image"], image["id"]]):
            try:
                local = client.images.get(reference)
                if local.id != image["id"]:
                    continue
                client.images.remove(reference, force=False, noprune=False)
                removed.append(reference)
            except Exception as error:
                if getattr(error, "status_code", None) != 404:
                    errors.append({"reference": reference, "message": str(error)})
    finally:
        client.close()
    return {"removed": removed, "errors": errors, "digest_retained": image["digest"]}


def readiness(out, instance=None, remove_images=False, *, checker=None):
    out = Path(out).resolve()
    manifest, cfg, tasks = check_candidates(out)
    progress = load_progress(out, manifest, cfg)
    by_id = {task["instance_id"]: task for task in tasks}
    state = select_ready(manifest, progress["records"], cfg)
    if instance is not None and instance != state["next_instance"]:
        raise ValueError(f"Readiness must check exactly the next candidate: {state['next_instance']}")
    checker = readiness_task if checker is None else checker
    while state["next_instance"] is not None:
        task_id = state["next_instance"]
        record_path = out / "readiness-tasks" / f"{task_id}.json"
        if record_path.exists():
            record = study.load(record_path)
            if record.get("candidates_sha256") != study.digest(manifest) or record.get("implementation_hashes") != implementation_hashes():
                raise RuntimeError("Interrupted readiness record has mismatched provenance")
        else:
            record = {**checker(out, by_id[task_id], cfg), "instance_id": task_id, "family": by_id[task_id]["family"], "fixture_sha256": study.digest(by_id[task_id]), "implementation_hashes": implementation_hashes(), "candidates_sha256": study.digest(manifest)}
            if not isinstance(record.get("ready"), bool) or (not record["ready"] and not record.get("rejections")):
                raise RuntimeError("Readiness checker did not retain a terminal structural decision")
            create_only(record_path, record)
        progress["records"][task_id] = record
        progress["attempt_order"].append(task_id)
        modern.private_save(out / "readiness-progress.json", progress)
        if remove_images:
            try:
                removal = remove_task_images(out, by_id[task_id])
            except Exception as error:
                removal = {"removed": [], "errors": [{"kind": type(error).__name__, "message": str(error)}]}
            modern.private_save(out / "image-removals" / f"{task_id}.json", removal)
        state = select_ready(manifest, progress["records"], cfg)
        if instance is not None:
            break
    report = {"schema": "census-readiness-v1", "candidates_sha256": study.digest(manifest), "implementation_hashes": implementation_hashes(), "state": state, "checked": len(progress["records"]), "rejections": [{"instance_id": key, **reason} for key in progress["attempt_order"] for reason in progress["records"][key].get("rejections", [])], "paid_inference_authorized": False}
    modern.private_save(out / "readiness.json", report)
    return report


def validate_task_evidence(out, task, cfg, *, source_transition=None):
    task_id = task["instance_id"]
    hashes = evidence_implementation_hashes(source_transition=source_transition)
    driver = modern.panel_driver(cfg, hashes, [task])
    paths = {name: out / directory / f"{task_id}.json" for name, directory in [("image", "images"), ("fixture", "fixtures"), ("image_audit", "image-audits"), ("runtime", "runtime"), ("license", "licenses"), ("license_check", "license-checks"), ("repository", "repositories")]}
    if any(not path.is_file() for path in paths.values()):
        raise RuntimeError("Incomplete per-task readiness evidence")
    records = {name: study.load(path) for name, path in paths.items()}
    image, fixture, runtime = records["image"], records["fixture"], records["runtime"]
    if not re.fullmatch(r"swerebench/[^@]+@sha256:[0-9a-f]{64}", image.get("digest", "")) or image.get("architecture") != "amd64" or image.get("source_image") != task["image"]:
        raise RuntimeError("Image is not an exact source-bound amd64 registry digest")
    image_id = image["id"]
    if fixture.get("eligible") is not True or not driver.retained_grades_valid(out, task, fixture, image_id):
        raise RuntimeError("Baseline/gold/gold-repeat/empty grades or retained artifacts are invalid")
    for receipt in fixture["receipts"].values():
        path = out / "evaluations" / f"{receipt['run_id']}.json"
        if not path.is_file() or study.load(path) != receipt:
            raise RuntimeError("Retained evaluator receipt differs from accepted fixture evidence")
    for name in ["fixture", "image_audit", "runtime"]:
        if records[name].get("image_id") != image_id or records[name].get("fixture_sha256") != study.digest(task):
            raise RuntimeError("Readiness evidence identifies a different image or task payload")
    for name in ["image_audit", "runtime"]:
        record = records[name]
        if not modern.scan_report_valid(record, task) or not modern.isolation_valid(record, image_id) or record.get("container_privileged") is not False or record.get("implementation_hashes") != hashes or record.get("resources", {}).get("compatible") is not True:
            raise RuntimeError("Leak audit, source resource envelope, driver hashes or container isolation is invalid")
    snapshot = runtime.get("snapshot", {})
    if snapshot.get("sanitized") is not True or snapshot.get("base_gitlinks") != [] or not snapshot.get("base_tree") or snapshot.get("snapshot_tree") != snapshot["base_tree"] or not modern.runtime_smoke_valid(task, runtime.get("smoke", {})) or runtime.get("unchanged_candidate_diff_exit_code") != 0 or runtime.get("solver_input_sha256") != study.digest(modern.solver_input(task)):
        raise RuntimeError("Sanitized gitlink-free base, import/retained-test proof or unchanged diff is invalid")
    license = records["license"]
    content = license.get("content", "").encode()
    blob = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
    check = records["license_check"]
    if license.get("spdx_id") not in cfg["accepted_repo_licenses"] or license.get("base_commit") != task["base_commit"] or modern.canonical_repo(license.get("repo", "")) != task["family"] or license.get("instance_id") != task_id or license.get("git_blob_sha") != blob or license.get("content_sha256") != hashlib.sha256(content).hexdigest() or any(check.get(key) != license.get(key) for key in ["base_commit", "git_blob_sha", "content_sha256"]):
        raise RuntimeError("Base-commit repository license evidence is invalid")
    if modern.canonical_repo(records["repository"]["full_name"]) != task["family"]:
        raise RuntimeError("Repository identity differs from the frozen family")
    extra = [out / name for receipt in fixture["receipts"].values() for name in receipt["artifacts"]]
    extra.extend(out / "evaluations" / f"{receipt['run_id']}.json" for receipt in fixture["receipts"].values())
    for directory in [out / "runtime-logs" / task_id, out / "base-checks" / task_id]:
        if directory.exists():
            extra.extend(path for path in directory.rglob("*") if path.is_file())
    evidence = {}
    for path in list(paths.values()) + extra:
        path = path.resolve()
        if not path.is_relative_to(out.resolve()) or not path.is_file():
            raise RuntimeError("Readiness evidence escaped its root or is missing")
        evidence[str(path.relative_to(out.resolve()))] = file_hash(path)
    return evidence


def task_evidence(out, task, *, source_transition=None):
    out = Path(out).resolve()
    manifest, cfg, _ = check_candidates(out, source_transition=source_transition)
    path = out / "readiness-tasks" / f"{task['instance_id']}.json"
    record = study.load(path)
    if record.get("ready") is not True or record.get("fixture_sha256") != study.digest(task) or record.get("implementation_hashes") != manifest["implementation_hashes"] or record.get("candidates_sha256") != study.digest(manifest):
        raise RuntimeError("Task has no current successful readiness decision")
    evidence = validate_task_evidence(out, task, cfg, source_transition=source_transition)
    if evidence != record.get("evidence"):
        raise RuntimeError("Readiness evidence changed after the structural decision")
    return {**evidence, str(path.relative_to(out)): file_hash(path)}


def freeze_panel(out):
    out = Path(out).resolve()
    manifest, cfg, tasks = check_candidates(out)
    progress = load_progress(out, manifest, cfg)
    state = select_ready(manifest, progress["records"], cfg)
    if not state["complete"]:
        raise RuntimeError(f"Census needs {cfg['target_tasks']} ready tasks; next={state['next_instance']}; exhausted={state['exhausted']}")
    by_id = {row["instance_id"]: row for row in tasks}
    selected = [by_id[task_id] for task_id in state["instance_ids"]]
    evidence = {row["instance_id"]: task_evidence(out, row) for row in selected}
    public = []
    for row in selected:
        image = study.load(out / "images" / f"{row['instance_id']}.json")
        license = study.load(out / "licenses" / f"{row['instance_id']}.json")
        public.append({**{key: row[key] for key in modern.PUBLIC_FIELDS}, "family": row["family"], "split": "census", "fixture_sha256": study.digest(row), "license_sha256": study.digest(license), "image_digest": image["digest"], "image_id": image["id"]})
    panel = {"schema": cfg["schema"], "config_sha256": study.digest(cfg), "dataset": cfg["dataset"], "dataset_revision": cfg["dataset_revision"], "dataset_source_url": modern.source_url(cfg), "dataset_license": "CC-BY-4.0", "harness_revision": cfg["harness_revision"], "seed": cfg["seed"], "tasks": public,
             "selection": {"candidates_sha256": study.digest(manifest), "readiness_progress_sha256": study.digest(progress), "preregistration_sha256": manifest["inputs"]["preregistration_sha256"], "panel_amendment_sha256": manifest["inputs"]["panel_amendment_sha256"], "families": state["families"], "implementation_hashes": implementation_hashes(), "outcomes_used": False, "replacement_rule": manifest["algorithm"]}, "limitations": cfg["limitations"]}
    frozen = {"schema": "census-panel-freeze-v1", "panel_sha256": study.digest(panel), "candidates_sha256": study.digest(manifest), "readiness_progress_sha256": study.digest(progress), "implementation_hashes": implementation_hashes(), "task_evidence": evidence, "preregistration_sha256": manifest["inputs"]["preregistration_sha256"], "panel_amendment_sha256": manifest["inputs"]["panel_amendment_sha256"], "paid_inference_authorized": False}
    for name, value in [("evaluator/tasks.json", selected), ("licenses.json", [study.load(out / "licenses" / f"{row['instance_id']}.json") for row in selected]), ("panel.json", panel), ("panel-freeze.json", frozen)]:
        create_only(out / name, value)
    return panel


def check_panel(out, *, source_transition=None):
    out = Path(out).resolve()
    manifest, cfg, _ = check_candidates(out, source_transition=source_transition)
    panel, frozen, tasks = study.load(out / "panel.json"), study.load(out / "panel-freeze.json"), study.load(out / "evaluator" / "tasks.json")
    progress = load_progress(out, manifest, cfg, source_transition=source_transition)
    state = select_ready(manifest, progress["records"], cfg)
    if not state["complete"] or len(tasks) != cfg["target_tasks"] or [row["instance_id"] for row in tasks] != state["instance_ids"]:
        raise RuntimeError("Final census panel differs from the preregistered replacement selection")
    if frozen["panel_sha256"] != study.digest(panel) or frozen["candidates_sha256"] != study.digest(manifest) or frozen["readiness_progress_sha256"] != study.digest(progress) or frozen["implementation_hashes"] != manifest["implementation_hashes"] or any(frozen[key] != manifest["inputs"][key] for key in ["preregistration_sha256", "panel_amendment_sha256"]):
        raise RuntimeError("Final census panel provenance changed")
    if [(row["instance_id"], study.digest(row)) for row in tasks] != [(row["instance_id"], row["fixture_sha256"]) for row in panel["tasks"]] or study.load(out / "licenses.json") != [study.load(out / "licenses" / f"{row['instance_id']}.json") for row in tasks]:
        raise RuntimeError("Final census task payload or license evidence changed")
    if frozen["task_evidence"] != {row["instance_id"]: task_evidence(out, row, source_transition=source_transition) for row in tasks}:
        raise RuntimeError("Final census readiness evidence changed")
    return panel, tasks

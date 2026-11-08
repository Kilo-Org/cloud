
import base64
import hashlib
import importlib
import inspect
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import uuid
from collections import defaultdict
from contextlib import contextmanager
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch as mock_patch

import study

HERE = Path(__file__).resolve().parent
PUBLIC_FIELDS = ("instance_id", "repo", "base_commit", "problem_statement", "created_at", "image")
HIDDEN_FIELDS = ("patch", "test_patch", "hints_text", "interface", "FAIL_TO_PASS", "PASS_TO_PASS")
SOLVER_FIELDS = ("problem_statement",)
POOL_PROVENANCE = {"author": "FreshPanelResearch source research, narrowed by ModernPanelOwner before inference", "unit": "exact canonical repository", "same_owner_policy": "Distinct repositories remain distinct families; shared-maintainer/style correlation is a limitation, not grounds for post-freeze regrouping", "unused_license_join_pins": "v1 config records an optional full-dataset join; this implementation does not execute it or claim it verifies any license"}


def implementation_hashes():
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(__file__), Path(study.__file__)]}


def private_save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    study.save(path, value)
    path.chmod(0o600)


def solver_input(task):
    return {key: task[key] for key in SOLVER_FIELDS}


def config():
    return study.load(HERE / "modern-panel.json")


def panel_driver(cfg, hashes, tasks):
    driver = SimpleNamespace(config=lambda: cfg, implementation_hashes=lambda: dict(hashes))
    def select(out, ids):
        unknown = set(ids) - {row["instance_id"] for row in tasks}
        if unknown:
            raise ValueError(f"Unknown tasks: {sorted(unknown)}")
        return [row for row in tasks if not ids or row["instance_id"] in ids]
    driver.selected_tasks = select
    for function in [resource_contract, verify_harness, fork_adapter, evaluate, current_attempts_valid, validate, container_audit, audit_images, runtime_smoke, runtime_proof, retained_grades_valid]:
        setattr(driver, function.__name__, partial(function, context=driver))
    return driver


def canonical_repo(repo):
    value = repo.strip().lower().removesuffix(".git")
    if not re.fullmatch(r"[a-z0-9_.-]+/[a-z0-9_.-]+", value):
        raise ValueError(f"Invalid repository identity: {repo}")
    return value


def rank(cfg, kind, value):
    return study.digest([cfg["seed"], kind, value])


def source_url(cfg):
    return f"https://huggingface.co/datasets/{cfg['dataset']}/tree/{cfg['dataset_revision']}"


def github_json(url):
    import requests

    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    response = requests.get(url, headers=headers, timeout=60)
    response.raise_for_status()
    return response.json()


def license_evidence(row):
    url = f"https://api.github.com/repos/{row['repo']}/license?ref={row['base_commit']}"
    try:
        body = github_json(url)
    except Exception as error:
        if getattr(getattr(error, "response", None), "status_code", None) == 404:
            return {"instance_id": row["instance_id"], "spdx_id": None, "rejection": "no_license_at_base_commit", "source_url": url}
        raise
    if body.get("encoding") != "base64" or not body.get("content"):
        return {"instance_id": row["instance_id"], "spdx_id": None, "rejection": "missing_license_content", "source_url": url}
    content = base64.b64decode(body["content"]).decode("utf-8")
    result = {"instance_id": row["instance_id"], "repo": row["repo"], "base_commit": row["base_commit"], "spdx_id": (body.get("license") or {}).get("spdx_id"), "source_url": url, "path": body["path"], "git_blob_sha": body["sha"], "content_sha256": hashlib.sha256(content.encode()).hexdigest(), "content": content}
    verify_license_blob(row, result)
    return result


def verify_license_blob(row, evidence):
    from urllib.parse import quote

    url = f"https://api.github.com/repos/{row['repo']}/contents/{quote(evidence['path'], safe='/')}?ref={row['base_commit']}"
    body = github_json(url)
    content = base64.b64decode(body.get("content", ""))
    blob = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
    if body.get("encoding") != "base64" or body.get("sha") != evidence["git_blob_sha"] or blob != evidence["git_blob_sha"] or hashlib.sha256(content).hexdigest() != evidence["content_sha256"]:
        raise RuntimeError("License evidence does not match the contents API at the exact base commit")
    return {"source_url": url, "git_blob_sha": blob, "content_sha256": evidence["content_sha256"], "base_commit": row["base_commit"]}


def resource_contract(task, out=None, *, context=None):
    context = context or sys.modules[__name__]
    import shutil

    def quantity(value):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        match = re.fullmatch(r"([0-9.]+)\s*([kmgt]?)(?:i?b?)?", str(value).strip().lower())
        if not match:
            raise ValueError(f"Unrecognised source resource requirement: {value}")
        return float(match[1]) * 1024 ** ("kmgt".find(match[2]) + 1 if match[2] else 0)
    source = {key: task.get(key) for key in ["harbor_cpus", "harbor_memory", "harbor_storage", "harbor_verifier_timeout_sec"]}
    limits = {"harbor_cpus": 2, "harbor_memory": 6 * 1024 ** 3, "harbor_verifier_timeout_sec": context.config()["evaluator_timeout_seconds"]}
    reasons, errors = [], []
    free = shutil.disk_usage(out).free if out is not None else None
    for key, value in source.items():
        if value is None:
            continue
        try:
            required = quantity(value)
            limit = free if key == "harbor_storage" else limits[key]
            if limit is not None and required > limit:
                reasons.append(key)
        except (ValueError, TypeError) as error:
            reasons.append(key)
            errors.append({"field": key, "error": str(error)})
    return {"source_requirements": source, "execution_limits": limits, "host_available_storage_bytes": free, "compatible": not reasons, "incompatible_fields": reasons, "invalid_source_fields": errors}


def eligible_rows(rows, cfg, prior, rejections=None, *, record_all_rejections=False):
    excluded = {canonical_repo(r) for r in cfg["excluded_families"] + cfg["excluded_alias_families"]}
    excluded.update(canonical_repo(row["repo"]) for row in prior)
    excluded_ids = set(cfg["excluded_instance_ids"]) | {row["instance_id"] for row in prior}
    pool = {canonical_repo(repo) for repo in cfg["family_pool"]} if cfg.get("family_pool") is not None else None
    seen = {}
    groups = defaultdict(list)
    for raw in rows:
        row = dict(raw)
        family = canonical_repo(row["repo"])
        task_id = row["instance_id"]
        def reject(reason):
            if record_all_rejections and rejections is not None:
                rejections.append({"scope": "row", "family": family, "instance_id": task_id, "reason": reason})
        if family in excluded:
            reject("prior_or_explicitly_excluded_repository")
            continue
        if pool is not None and family not in pool:
            reject("outside_frozen_family_pool")
            continue
        if task_id in excluded_ids:
            reject("prior_or_explicitly_excluded_instance")
            continue
        if task_id.endswith("_interface"):
            reject("interface_variant")
            continue
        if row["created_at"][:10] < cfg["created_at_min"]:
            reject("before_created_at_min")
            continue
        resources = resource_contract(row)
        if not resources["compatible"]:
            if rejections is not None:
                rejections.append({"scope": "row", "family": family, "instance_id": task_id, "reason": "source_resource_contract", "details": resources})
            continue
        install = row.get("install_config")
        if not isinstance(install, dict) or not install.get("python") or not install.get("test_cmd") or not install.get("log_parser"):
            reject("missing_python_install_or_test_parser")
            continue
        if not re.search(r"^diff --git a/.+\.py b/", row.get("patch", ""), re.MULTILINE):
            reject("no_python_source_patch")
            continue
        if not all(row.get(key) for key in ["base_commit", "problem_statement", "patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "docker_image"]):
            reject("incomplete_evaluator_fields")
            continue
        if not re.fullmatch(r"[0-9a-f]{40}", row["base_commit"]):
            raise ValueError(f"Invalid base commit: {task_id}")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", task_id):
            raise ValueError(f"Unsafe instance ID: {task_id}")
        fingerprint = study.digest(row)
        if task_id in seen:
            if seen[task_id] != fingerprint:
                raise ValueError(f"Conflicting duplicate instance ID: {task_id}")
            reject("identical_duplicate_source_row")
            continue
        seen[task_id] = fingerprint
        row["family"] = family
        row["image"] = row["docker_image"]
        groups[family].append(row)
    return {family: sorted(items, key=lambda row: rank(cfg, "task", row["instance_id"])) for family, items in groups.items() if len(items) >= cfg["tasks_per_family"]}


def select_panel(rows, cfg, prior, repository_lookup=github_json, license_lookup=license_evidence):
    families, selected, licenses, rejected, identities = [], [], [], [], set()
    groups = eligible_rows(rows, cfg, prior, rejected)
    for family in sorted(groups, key=lambda value: rank(cfg, "family", value)):
        identity = repository_lookup(f"https://api.github.com/repos/{family}")
        canonical = canonical_repo(identity["full_name"])
        if canonical != family or identity["id"] in identities:
            rejected.append({"family": family, "reason": "renamed_or_duplicate_repository_identity", "canonical": canonical, "github_id": identity["id"]})
            continue
        identities.add(identity["id"])
        pair = groups[family][:cfg["tasks_per_family"]]
        try:
            evidence = [license_lookup(row) for row in pair]
        except RuntimeError as error:
            rejected.append({"scope": "family", "family": family, "reason": "license_blob_verification_failed", "error": str(error)})
            continue
        if any(item["spdx_id"] not in cfg["accepted_repo_licenses"] for item in evidence):
            rejected.append({"family": family, "reason": "repository_license_not_allowlisted", "licenses": evidence})
            continue
        families.append({"repo": family, "github_id": identity["id"], "canonical_full_name": identity["full_name"], "source_url": identity["html_url"], "selection_hash": rank(cfg, "family", family)})
        selected.extend(pair)
        licenses.extend(evidence)
        if len(families) == cfg["families"]:
            break
    if len(families) != cfg["families"]:
        raise RuntimeError(f"Only {len(families)} license-verified eligible families; need {cfg['families']}; no substitutions outside frozen family pool")
    split_order = sorted(families, key=lambda item: rank(cfg, "split", item["repo"]))
    splits = [split for split, count in cfg["split_counts"].items() for _ in range(count)]
    if len(splits) != cfg["families"]:
        raise ValueError("Split counts do not cover all families")
    mapping = {}
    for family, split in zip(split_order, splits):
        family["split"] = split
        family["split_hash"] = rank(cfg, "split", family["repo"])
        mapping[family["repo"]] = split
    for row in selected:
        row["split"] = mapping[row["family"]]
    return selected, families, licenses, rejected


def prepare(out, prior_path):
    from datasets import load_dataset

    cfg = config()
    prior_manifest = study.load(prior_path)
    prior = prior_manifest["tasks"]
    if len(prior) != 12 or len({row["instance_id"] for row in prior}) != 12:
        raise ValueError("Provide the original twelve-task panel manifest")
    if (out / "panel.json").exists():
        panel, _ = check_panel(out)
        if panel["selection"]["prior_panel_sha256"] != study.digest(prior_manifest):
            raise RuntimeError("Original prior panel changed after modern freeze")
        return panel
    rows = list(load_dataset(cfg["dataset"], split=cfg["dataset_split"], revision=cfg["dataset_revision"]))
    selected, families, licenses, rejected = select_panel(rows, cfg, prior)
    panel = {"schema": cfg["schema"], "config_sha256": study.digest(cfg), "dataset": cfg["dataset"], "dataset_revision": cfg["dataset_revision"], "dataset_source_url": source_url(cfg), "dataset_license": "CC-BY-4.0", "harness_revision": cfg["harness_revision"], "selection": {"seed": cfg["seed"], "algorithm": "SHA256 canonical JSON [seed,kind,value]; family eligibility then first two task hashes; independent family split hash", "prior_panel_sha256": study.digest(prior_manifest), "prior_instances": sorted(row["instance_id"] for row in prior), "prior_families": sorted({canonical_repo(row["repo"]) for row in prior}), "eligible_source_rows_sha256": study.digest(rows), "families": families, "rejected_families": rejected, "outcomes_used": False}, "limitations": cfg["limitations"], "tasks": [{**{key: row[key] for key in PUBLIC_FIELDS}, "family": row["family"], "split": row["split"], "fixture_sha256": study.digest(row), "license_sha256": study.digest(next(item for item in licenses if item["instance_id"] == row["instance_id"]))} for row in selected]}
    panel["selection"]["implementation_hashes"] = implementation_hashes()
    panel["selection"]["pool_provenance"] = POOL_PROVENANCE
    if out.exists() and any(out.iterdir()):
        raise RuntimeError("Preparation requires an empty separate modern output directory")
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    out.chmod(0o700)
    private_save(out / "evaluator" / "tasks.json", selected)
    (out / "evaluator").chmod(0o700)
    study.save(out / "licenses.json", licenses)
    study.save(out / "panel.json", panel)
    return panel


def check_panel(out):
    cfg, panel = config(), study.load(out / "panel.json")
    tasks, licenses = study.load(out / "evaluator" / "tasks.json"), study.load(out / "licenses.json")
    if panel["config_sha256"] != study.digest(cfg) or len(tasks) != 16:
        raise RuntimeError("Modern configuration or task count changed after freeze")
    if {r["instance_id"]: study.digest(r) for r in tasks} != {r["instance_id"]: r["fixture_sha256"] for r in panel["tasks"]}:
        raise RuntimeError("Evaluator task payload changed after freeze")
    if {r["instance_id"]: study.digest(r) for r in licenses} != {r["instance_id"]: r["license_sha256"] for r in panel["tasks"]}:
        raise RuntimeError("Repository license evidence changed after freeze")
    out.chmod(0o700)
    (out / "evaluator").chmod(0o700)
    (out / "evaluator" / "tasks.json").chmod(0o600)
    return panel, tasks


def verify_harness(*, context=None):
    context = context or sys.modules[__name__]
    module = importlib.import_module("swebench.harness.eval")
    root = Path(module.__file__).resolve().parents[2]
    expected = context.config()["harness_revision"]
    actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    if actual != expected or dirty:
        raise RuntimeError("Modern harness must be the clean pinned fork in its separate venv")
    signature = inspect.signature(module.run_instance)
    if list(signature.parameters)[:6] != ["test_spec", "pred", "rm_image", "force_rebuild", "client", "run_id"]:
        raise RuntimeError("Unexpected fork evaluator API")
    return module


def pinned_image(client, out, task):
    record_path = out / "images" / f"{task['instance_id']}.json"
    if record_path.exists():
        record = study.load(record_path)
        try:
            image = client.images.get(record["digest"])
        except Exception as error:
            if getattr(error, "status_code", None) != 404:
                raise
            image = client.images.pull(record["digest"], platform="linux/amd64")
        if image.id != record["id"] or record["source_image"] != task["image"]:
            raise RuntimeError("Pinned image content differs")
        return image
    if not task["image"].startswith("swerebench/"):
        raise RuntimeError("Unexpected public image namespace")
    image = client.images.pull(task["image"], platform="linux/amd64")
    digests = sorted(image.attrs.get("RepoDigests", []))
    repository = task["image"].split(":")[0].split("@")[0]
    matching = [ref for ref in digests if ref.startswith(repository + "@sha256:")]
    if len(matching) != 1 or image.attrs.get("Architecture") != "amd64":
        raise RuntimeError("Pulled image lacks an unambiguous amd64 registry digest")
    if client.images.get(matching[0]).id != image.id:
        raise RuntimeError("Registry digest does not identify pulled image")
    study.save(record_path, {"source_image": task["image"], "digest": matching[0], "id": image.id, "repo_digests": digests, "architecture": "amd64"})
    return image


def selected_tasks(out, ids):
    _, tasks = check_panel(out)
    unknown = set(ids) - {row["instance_id"] for row in tasks}
    if unknown:
        raise ValueError(f"Unknown tasks: {sorted(unknown)}")
    return [row for row in tasks if not ids or row["instance_id"] in ids]


def pin_images(out, ids):
    import docker

    client = docker.from_env(timeout=1800)
    for task in selected_tasks(out, ids):
        pinned_image(client, out, task)


class EmptyPatchContainer:
    def __init__(self, container, patch_path):
        self._container = container
        self._apply = f"git apply --verbose {patch_path}"

    def __getattr__(self, name):
        return getattr(self._container, name)

    def exec_run(self, command, *args, **kwargs):
        if command == self._apply:
            command = command.replace("git apply --verbose", "git apply --allow-empty --verbose", 1)
        return self._container.exec_run(command, *args, **kwargs)


def prepare_base_snapshot(container, task, sanitize=False, *, report_path=None):
    base = task["base_commit"]
    probe = "import json,subprocess; run=lambda *a: subprocess.check_output(['git',*a],cwd='/testbed',text=True).strip(); print(json.dumps({'image_head_tree':run('rev-parse','HEAD^{tree}'),'base_tree':run('rev-parse',BASE+'^{tree}'),'setup_changed_files':run('diff','--name-only',BASE,'HEAD').splitlines(),'working_changed_files':run('diff','--name-only','HEAD').splitlines(),'base_gitlinks':[line.split('\\t',1)[1] for line in run('ls-tree','-r',BASE).splitlines() if line.startswith('160000 ')]}))".replace("BASE", repr(base))
    container.exec_run(["git", "config", "--global", "--add", "safe.directory", "/testbed"])
    result = container.exec_run(["python", "-c", probe])
    if result.exit_code:
        raise RuntimeError("Could not inspect source image setup/base tree relation")
    report = json.loads(result.output.decode())
    touched = {parts[3].removeprefix("b/") for key in ["patch", "test_patch"] for line in task[key].splitlines() if line.startswith("diff --git ") and len(parts := shlex.split(line)) == 4}
    report["setup_patch_overlap"] = sorted((set(report["setup_changed_files"]) | set(report["working_changed_files"])) & touched)
    if report_path is not None:
        private_save(report_path, {**report, "fixture_sha256": study.digest(task)})
    if report["setup_patch_overlap"]:
        raise RuntimeError(f"Image setup changed gold/test patch paths: {report['setup_patch_overlap']}")
    if sanitize and report["base_gitlinks"]:
        raise RuntimeError(f"Commit-free solver snapshots cannot preserve submodule gitlinks: {report['base_gitlinks']}")
    command = f"mkdir -p .git/info && printf '* -text -filter -ident -working-tree-encoding\\n' > .git/info/attributes && git checkout --detach {shlex.quote(base)} && rm -f .git/index && git reset --hard {shlex.quote(base)} && git clean -ffdq && git diff --exit-code {report['base_tree']}"
    if sanitize:
        command += " && tracked=$(mktemp) && git ls-files -z > \"$tracked\" && rm -rf .git && git init -q && printf '* -text -filter -ident -working-tree-encoding\\n' > .git/info/attributes && git add -f --pathspec-from-file=\"$tracked\" --pathspec-file-nul && rm \"$tracked\" && git add -N . && test \"$(git rev-list --all --count)\" = 0 && test -z \"$(git remote)\""
    command += f" && test \"$(git write-tree)\" = {report['base_tree']} && rm -f /root/.gitconfig && git write-tree"
    result = container.exec_run(["/bin/bash", "-c", command], workdir="/testbed")
    if result.exit_code or result.output.decode().strip().splitlines()[-1] != report["base_tree"]:
        raise RuntimeError("Solver/evaluator snapshot does not equal the unchanged base tree")
    report.update(snapshot_tree=report["base_tree"], ignored_artifact_policy="git clean -ffdq without -x; retained import/test proof must pass", sanitized=sanitize)
    return report


def isolation_valid(record, image_id):
    try:
        interfaces = json.loads(record.get("interfaces", "[]"))
    except (ValueError, TypeError):
        return False
    return record.get("image", record.get("image_id")) == image_id and record.get("network") == "none" and record.get("mounts") == [] and record.get("cap_drop") == ["ALL"] and "no-new-privileges" in record.get("security_opt", []) and "-j DROP" in record.get("output_filter", "") and bool(interfaces) and all(item.get("ifname") == "lo" for item in interfaces) and record.get("user") == "root" and record.get("memory") == 6 * 1024 ** 3 and record.get("nano_cpus") == 2000000000 and record.get("pids_limit") == 256


@contextmanager
def fork_adapter(harness, image_id, empty, task=None, state=None, *, context=None):
    context = context or sys.modules[__name__]
    from swebench.harness.constants import DOCKER_PATCH

    containers = []
    original_exec = harness.exec_run_with_timeout

    def execute_tests(*args, **kwargs):
        if state is not None:
            state["test_started"] = True
        return original_exec(*args, **kwargs)

    def build(test_spec, client, run_id, logger, rm_image, force_rebuild, container_kwargs):
        if rm_image or force_rebuild or container_kwargs:
            raise RuntimeError("Modern evaluation forbids image mutation and custom container options")
        if test_spec.instance_image_key != image_id:
            raise RuntimeError("Evaluator requested an unpinned image")
        container = study.isolated_create_container(SimpleNamespace(image=image_id), client, run_id, logger)
        containers.append(container)
        if task is not None:
            original_start = container.start
            def start_on_base():
                original_start()
                snapshot = prepare_base_snapshot(container, task)
                isolation_path = Path(logger.log_file).parent / "isolation.json"
                container.reload()
                actual = container.attrs
                limits = {"user": actual["Config"]["User"], "memory": actual["HostConfig"]["Memory"], "nano_cpus": actual["HostConfig"]["NanoCpus"], "pids_limit": actual["HostConfig"]["PidsLimit"]}
                private_save(isolation_path, {**study.load(isolation_path), **limits, "snapshot": snapshot, "implementation_hashes": context.implementation_hashes()})
            container.start = start_on_base
        return EmptyPatchContainer(container, DOCKER_PATCH) if empty else container

    def cleanup(client, container, logger):
        if container is not None:
            container.remove(force=True)

    with mock_patch.object(harness, "build_container", build), mock_patch.object(harness, "cleanup_container", cleanup), mock_patch.object(harness, "copy_to_container", study.copy_evaluator_file), mock_patch.object(harness, "exec_run_with_timeout", execute_tests):
        try:
            yield
        finally:
            for container in containers:
                try:
                    container.remove(force=True)
                except Exception as error:
                    if getattr(error, "status_code", None) != 404:
                        raise


def make_spec(task, image_id):
    import requests
    from swebench.harness.test_spec.test_spec import make_test_spec

    original_get = requests.get
    def bounded_get(*args, **kwargs):
        kwargs["timeout"] = kwargs.get("timeout") or (10, 60)
        return original_get(*args, **kwargs)
    with mock_patch.object(requests, "get", bounded_get):
        return make_test_spec({**task, "image_name": image_id})


def transient_pretest_error(error):
    import requests

    current = error
    while current is not None:
        if isinstance(current, requests.exceptions.SSLError):
            return False
        if isinstance(current, (requests.exceptions.Timeout, requests.exceptions.ConnectionError, TimeoutError, ConnectionError)):
            return True
        if type(current).__module__.startswith("docker.") and getattr(current, "status_code", None) in {500, 502, 503, 504}:
            return True
        current = current.__cause__ or current.__context__
    return False


class EvaluationFailure(RuntimeError):
    def __init__(self, error, test_started, run_id):
        super().__init__(str(error))
        self.test_started = test_started
        self.retryable = not test_started and transient_pretest_error(error)
        self.original_type = type(error).__name__
        self.run_id = run_id


def evaluate(out, task, label, candidate_patch, *, context=None):
    context = context or sys.modules[__name__]
    run_id = f"modern-{label}-{uuid.uuid4().hex}"
    state = {"test_started": False}
    receipt = {"run_id": run_id, "instance_id": task["instance_id"], "label": label, "fixture_sha256": study.digest(task), "harness_revision": context.config()["harness_revision"], "implementation_hashes": context.implementation_hashes(), "prediction_sha256": hashlib.sha256(candidate_patch.encode()).hexdigest()}
    previous = Path.cwd()
    try:
        resources = context.resource_contract(task, out)
        if not resources["compatible"]:
            raise RuntimeError(f"Source resource requirements exceed the frozen execution envelope: {resources}")
        import docker
        harness = context.verify_harness()
        client = docker.from_env(timeout=1800)
        image = pinned_image(client, out, task)
        receipt["image_id"] = image.id
        spec = make_spec(task, image.id)
        if spec.FAIL_TO_PASS != task["FAIL_TO_PASS"] or spec.PASS_TO_PASS != task["PASS_TO_PASS"]:
            raise RuntimeError("Official hidden test identities changed in adapter")
        prediction = {"instance_id": task["instance_id"], "model_name_or_path": label, "model_patch": candidate_patch}
        os.chdir(out)
        with context.fork_adapter(harness, image.id, candidate_patch == "", task, state):
            result = harness.run_instance(spec, prediction, rm_image=False, force_rebuild=False, client=client, run_id=run_id, timeout=context.config()["evaluator_timeout_seconds"])
            log_dir = harness.get_log_dir(prediction, run_id, task["instance_id"])
            artifacts = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [log_dir / name for name in ["report.json", "test_output.txt", "eval.sh", "patch.diff", "isolation.json"]] if path.is_file()}
            if len(artifacts) != 5:
                raise RuntimeError("Official grade/log/patch/isolation artifacts were not retained")
        if not state["test_started"]:
            raise RuntimeError("Official test execution did not occur; cached/no-op grades are ineligible")
        receipt.update(result=result, artifacts=artifacts, test_started=state["test_started"])
    except Exception as error:
        failure = EvaluationFailure(error, state["test_started"], run_id)
        receipt.update(status="infrastructure_invalid", error={"kind": failure.original_type, "message": str(error), "retryable": failure.retryable}, test_started=state["test_started"])
        private_save(out / "evaluations" / f"{run_id}.json", receipt)
        raise failure from error
    finally:
        os.chdir(previous)
    private_save(out / "evaluations" / f"{run_id}.json", receipt)
    return receipt


def valid_grade(task, case, gold):
    if case.get("resolved") is not gold or case.get("patch_successfully_applied") is not True:
        return False
    statuses = case.get("tests_status", {})
    for kind in ["FAIL_TO_PASS", "PASS_TO_PASS"]:
        observed = statuses.get(kind, {})
        success, failure = observed.get("success", []), observed.get("failure", [])
        if sorted(success + failure) != sorted(task[kind]):
            return False
        if kind == "PASS_TO_PASS" or gold:
            if failure:
                return False
        elif not failure or success:
            return False
    return True


def current_attempts_valid(attempts, *, context=None):
    context = context or sys.modules[__name__]
    if any(item.get("semantic_failures") for item in attempts):
        return False
    current = [item for item in attempts if item.get("implementation_hashes") == context.implementation_hashes()]
    return bool(current) and len(current) <= 2 and current[-1].get("eligible") is True and not current[-1].get("errors") and not current[-1].get("semantic_failures") and all(item.get("retryable_pretest_failure") is True and not item.get("semantic_failures") and bool(item.get("errors")) and all(error.get("retryable_pretest") is True and error.get("test_started") is False for error in item["errors"]) for item in current[:-1])


def validate(out, ids, *, context=None):
    context = context or sys.modules[__name__]
    failed = []
    for task in context.selected_tasks(out, ids):
        path = out / "fixtures" / f"{task['instance_id']}.json"
        previous = study.load(path) if path.exists() else {}
        attempts = previous.get("attempts", [])
        current = [item for item in attempts if item.get("implementation_hashes") == context.implementation_hashes()]
        if any(item.get("semantic_failures") for item in attempts):
            failed.append(task["instance_id"])
            continue
        while len(current) < 2 and (not current or current[-1].get("retryable_pretest_failure") is True):
            attempt = {"number": len(attempts) + 1, "version_attempt": len(current) + 1, "receipts": {}, "errors": [], "semantic_failures": [], "implementation_hashes": context.implementation_hashes(), "eligible": False, "retryable_pretest_failure": False}
            attempts.append(attempt)
            current.append(attempt)
            image_path = out / "images" / f"{task['instance_id']}.json"
            image_id = study.load(image_path)["id"] if image_path.exists() else None
            private_save(path, {"eligible": False, "fixture_sha256": study.digest(task), "image_id": image_id, "receipts": attempt["receipts"], "attempts": attempts})
            for label in ["baseline", "gold", "gold-repeat", "empty"]:
                try:
                    receipt = context.evaluate(out, task, label, task["patch"] if label.startswith("gold") else "")
                    attempt["receipts"][label] = receipt
                    case = receipt["result"][1][task["instance_id"]]
                    if not valid_grade(task, case, label.startswith("gold")):
                        attempt["semantic_failures"].append(label)
                    private_save(path, {"eligible": False, "fixture_sha256": study.digest(task), "image_id": image_id, "receipts": attempt["receipts"], "attempts": attempts})
                except Exception as error:
                    retryable = isinstance(error, EvaluationFailure) and error.retryable
                    attempt["errors"].append({"label": label, "kind": getattr(error, "original_type", type(error).__name__), "message": str(error), "classification": "infrastructure_invalid", "test_started": getattr(error, "test_started", None), "retryable_pretest": retryable, "run_id": getattr(error, "run_id", None)})
                    if retryable and not attempt["semantic_failures"]:
                        attempt["retryable_pretest_failure"] = True
                    break
            cases = {label: receipt["result"][1][task["instance_id"]] for label, receipt in attempt["receipts"].items()}
            attempt["eligible"] = not attempt["errors"] and not attempt["semantic_failures"] and set(cases) == {"baseline", "gold", "gold-repeat", "empty"} and cases["baseline"] == cases["empty"] and cases["gold"] == cases["gold-repeat"]
            if not attempt["eligible"] and not attempt["errors"]:
                attempt["semantic_failures"].append("inconsistent_repeated_grades")
            image_path = out / "images" / f"{task['instance_id']}.json"
            image_id = study.load(image_path)["id"] if image_path.exists() else None
            private_save(path, {"eligible": context.current_attempts_valid(attempts), "fixture_sha256": study.digest(task), "image_id": image_id, "receipts": attempt["receipts"], "attempts": attempts, "retry_policy": "At most two current-code attempts; only recognised PRE-TEST connection/Docker-5xx/HTTP-timeout errors retry. Semantic failures or inconsistent gold grades require a new manifest, never a retry. Superseded infrastructure attempts remain recorded but do not veto a real source-code fix."})
        if not context.current_attempts_valid(attempts):
            failed.append(task["instance_id"])
    if failed:
        raise RuntimeError(f"Fixture acceptance failed; every attempt retained, no reselection: {failed}")


def scan_files(root, payload):
    import hashlib
    import json
    import os
    import pathlib
    import re
    import stat
    import subprocess
    import tarfile

    root = pathlib.Path(root).resolve()
    forbidden = {"test.patch", "gold.patch", "eval.sh", ".git-credentials", ".netrc", "id_rsa", "id_ed25519"}
    errors, hits, links, exclusions, informational = [], [], [], [], []
    candidates = {item["text"].encode().strip(): item for item in payload["needles"] if item["kind"] == "added_line"}
    present = set()
    testbed = root / "testbed"
    if candidates:
        try:
            probe = subprocess.run(["git", "-c", f"safe.directory={testbed}", "-C", str(testbed), "cat-file", "-e", payload["base_commit"]], capture_output=True)
            if probe.returncode == 0:
                with subprocess.Popen(["git", "-c", f"safe.directory={testbed}", "-C", str(testbed), "archive", payload["base_commit"]], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
                    with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
                        for entry in archive:
                            if entry.isfile():
                                with archive.extractfile(entry) as stream:
                                    present.update(line.strip() for line in stream if line.strip() in candidates)
                if process.returncode != 0:
                    raise RuntimeError("Cannot read pinned base archive for marker filtering")
            else:
                paths = subprocess.check_output(["git", "-c", f"safe.directory={testbed}", "-C", str(testbed), "ls-files", "-z"]).split(b"\0")
                for relative in paths:
                    if relative:
                        path = testbed / os.fsdecode(relative)
                        if path.is_file() and not path.is_symlink():
                            with path.open("rb") as stream:
                                present.update(line.strip() for line in stream if line.strip() in candidates)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            errors.append({"path": str(testbed), "operation": "base_marker_filter", "error": str(error)})
    needles = [(item["text"].encode(), item["kind"], hashlib.sha256(item["text"].encode()).hexdigest()) for item in payload["needles"] if item["kind"] != "added_line" or item["text"].encode().strip() not in present]
    counts = {key: 0 for _, _, key in needles}
    raw = [(needle, kind, key) for needle, kind, key in needles if kind not in {"added_line", "FAIL_TO_PASS_id"}]
    ids = [(needle, kind, key) for needle, kind, key in needles if kind == "FAIL_TO_PASS_id"]
    id_pattern = re.compile(b"|".join(re.escape(needle) for needle, _, _ in sorted(ids, key=lambda item: -len(item[0])))) if ids else None
    line_keys = {}
    for needle, kind, key in needles:
        if kind == "added_line":
            line_keys.setdefault(needle.strip(), []).append(key)
    sequences = {tuple(line.encode().strip() for line in sequence) for sequence in payload.get("added_sequences", []) if len(set(sequence)) == 3 and all(line.encode().strip() not in present for line in sequence)}
    overlap = max([len(needle) for needle, kind, key in needles if kind != "added_line"] + [1]) - 1
    max_line = max([len(line) for line in line_keys] + [1]) + 4096
    scanned, oversized = 0, 0
    def walk_error(error):
        errors.append({"path": error.filename, "operation": "walk", "error": str(error)})
    for directory, dirs, files in os.walk(root, onerror=walk_error, followlinks=False):
        if pathlib.Path(directory) == root:
            dirs[:] = [name for name in dirs if name not in {"proc", "sys", "dev"}]
        for name in dirs + files:
            path = pathlib.Path(directory) / name
            if name in forbidden:
                hits.append({"path": str(path), "kind": "forbidden_filename"})
            try:
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode):
                    raw_target = os.readlink(path)
                    try:
                        target = path.resolve(strict=False)
                    except RuntimeError:
                        links.append({"path": str(path), "raw_target": raw_target, "resolution": "symlink_cycle"})
                        exclusions.append({"path": str(path), "reason": "symlink cycle has no resolved regular-file contents"})
                        continue
                    links.append({"path": str(path), "target": str(target), "raw_target": raw_target, "dangling": not target.exists()})
                    if name in forbidden or target.name in forbidden:
                        hits.append({"path": str(path), "kind": "forbidden_symlink"})
                    if not target.is_relative_to(root):
                        errors.append({"path": str(path), "operation": "external_symlink", "target": str(target)})
                    elif root == pathlib.Path("/") and str(target).split("/")[1] in {"proc", "sys", "dev"}:
                        exclusions.append({"path": str(path), "target": str(target), "reason": "explicit pseudo-filesystem exclusion"})
                    elif not target.exists():
                        exclusions.append({"path": str(path), "target": str(target), "reason": "dangling symlink has no readable file contents"})
                    continue
                if not stat.S_ISREG(info.st_mode):
                    if not stat.S_ISDIR(info.st_mode):
                        exclusions.append({"path": str(path), "reason": "nonregular endpoint has no persistent regular-file contents", "mode": stat.S_IFMT(info.st_mode)})
                    continue
                if info.st_size > 16777216:
                    oversized += 1
                with path.open("rb") as stream:
                    previous, pending = b"", b""
                    found, found_lines, matched_sequences, line_history = set(), set(), set(), []
                    while chunk := stream.read(1048576):
                        data = previous + chunk
                        matches = [(kind, key) for needle, kind, key in raw if key not in found and needle in data]
                        if id_pattern is not None:
                            for match in id_pattern.finditer(data):
                                matches.extend((kind, key) for needle, kind, key in ids if key not in found and needle in match[0])
                        for kind, key in matches:
                            if key not in found:
                                found.add(key)
                                counts[key] += 1
                                hits.append({"path": str(path), "kind": kind, "needle_sha256": key})
                        if line_keys:
                            complete = (pending + chunk).split(b"\n")
                            pending = complete.pop()
                            for line in complete:
                                normalized = line.strip()
                                found_lines.update(line_keys.get(normalized, []))
                                line_history = (line_history + [normalized])[-3:]
                                if tuple(line_history) in sequences:
                                    matched_sequences.add(tuple(line_history))
                            if len(pending) > max_line:
                                pending = pending[-max_line:]
                        previous = data[-overlap:] if overlap else b""
                    found_lines.update(line_keys.get(pending.strip(), []))
                    line_history = (line_history + [pending.strip()])[-3:]
                    if tuple(line_history) in sequences:
                        matched_sequences.add(tuple(line_history))
                    for key in found_lines:
                        counts[key] += 1
                    if found_lines:
                        evidence = {"path": str(path), "kind": "added_line_cooccurrence", "needle_sha256": sorted(found_lines), "distinct_lines": len(found_lines), "matched_consecutive_sequences": len(matched_sequences)}
                        (hits if matched_sequences else informational).append(evidence)
                scanned += 1
            except (PermissionError, OSError, RuntimeError) as error:
                errors.append({"path": str(path), "operation": "inspect_or_read", "error": str(error)})
    return {"clean": scanned > 0 and not hits and not errors, "scanned_files": scanned, "forbidden_hits": hits, "informational_added_line_hits": informational, "scan_errors": errors, "symlinks": links, "explicit_exclusions": exclusions, "oversized_files_streamed": oversized, "needle_sha256_counts": counts, "needles_payload_sha256": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(), "added_lines_kept": len(candidates) - len(present), "added_lines_dropped_verbatim_base": len(present), "added_line_leak_threshold": "three distinct consecutive long added lines, in source-patch order, all absent verbatim from the pinned base; other added-line matches are informational", "scope": "all regular files streamed without a size cutoff; internal symlinks inventoried and canonical targets scanned; dangling links/nonregular endpoints inventoried without reading; proc/sys/dev excluded explicitly; every regular-file read or walk error blocks readiness"}


def scan_payload(task):
    needles = [{"kind": key, "text": task[key]} for key in ["patch", "test_patch", "hints_text", "interface"] if isinstance(task.get(key), str) and len(task[key]) >= 16]
    needles.extend({"kind": "FAIL_TO_PASS_id", "text": name} for name in task["FAIL_TO_PASS"] if len(name) >= 16)
    needles.extend({"kind": "added_line", "text": line[1:]} for key in ["patch", "test_patch"] for line in task[key].splitlines() if line.startswith("+") and not line.startswith("+++") and len(line[1:]) >= 32)
    sequences = []
    for key in ["patch", "test_patch"]:
        run = []
        for line in task[key].splitlines():
            if line.startswith("+") and not line.startswith("+++") and len(line[1:]) >= 32:
                run.append(line[1:])
                if len(run) >= 3:
                    sequences.append(run[-3:])
            else:
                run = []
    return {"base_commit": task["base_commit"], "needles": needles, "added_sequences": sequences}


def scan_command(payload_path):
    source = inspect.getsource(scan_files)
    return ["python", "-c", source + "\nimport json,pathlib,sys\np=pathlib.Path(sys.argv[1]); payload=json.loads(p.read_text()); p.unlink(); print(json.dumps(scan_files('/',payload)))", str(payload_path)]


def scan_report_valid(report, task=None):
    expected = hashlib.sha256(json.dumps(scan_payload(task), sort_keys=True).encode()).hexdigest() if task is not None else report.get("needles_payload_sha256")
    return report.get("clean") is True and report.get("scanned_files", 0) > 0 and report.get("forbidden_hits") == [] and report.get("scan_errors") == [] and isinstance(report.get("needle_sha256_counts"), dict) and bool(expected) and report.get("needles_payload_sha256") == expected


def container_audit(out, task, image, container, directory, *, context=None):
    context = context or sys.modules[__name__]
    container.reload()
    attrs = container.attrs
    host = attrs["HostConfig"]
    if attrs["Image"] != image.id or attrs["Mounts"] or host["NetworkMode"] != "none" or host["CapDrop"] != ["ALL"] or "no-new-privileges" not in host["SecurityOpt"]:
        raise RuntimeError("Actual container isolation differs from contract")
    credential_names = [value.split("=", 1)[0] for value in attrs["Config"].get("Env", []) if re.search(r"(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)=.+", value, re.I)]
    if credential_names:
        private_save(out / directory / f"{task['instance_id']}.json", {"fixture_sha256": study.digest(task), "image_id": image.id, "clean": False, "forbidden_hits": [{"kind": "credential_environment_variable", "name": name} for name in credential_names], "implementation_hashes": context.implementation_hashes()})
        raise RuntimeError("Image contains a credential-like environment variable")
    payload_path = Path("/tmp") / f"modern-audit-{uuid.uuid4().hex}.json"
    with tempfile.TemporaryDirectory() as temporary:
        source = Path(temporary) / "needles.json"
        private_save(source, scan_payload(task))
        study.copy_evaluator_file(container, source, payload_path)
        result = container.exec_run(scan_command(payload_path), privileged=True)
    if result.exit_code:
        raise RuntimeError("Leak audit did not execute")
    report = json.loads(result.output.decode())
    report.update(instance_id=task["instance_id"], fixture_sha256=study.digest(task), image_id=image.id, network=host["NetworkMode"], mounts=attrs["Mounts"], cap_drop=host["CapDrop"], security_opt=host["SecurityOpt"], user=attrs["Config"]["User"], memory=host["Memory"], nano_cpus=host["NanoCpus"], pids_limit=host["PidsLimit"], container_privileged=host["Privileged"], scan_process="privileged exec only; container processes keep every capability dropped", resources=context.resource_contract(task, out))
    report["implementation_hashes"] = context.implementation_hashes()
    report["clean"] = scan_report_valid(report, task) and report["resources"]["compatible"] and host["Privileged"] is False
    private_save(out / directory / f"{task['instance_id']}.json", report)
    if not report["clean"]:
        raise RuntimeError(f"Image/runtime leak audit failed: {task['instance_id']}")
    return report


def audit_images(out, ids, *, context=None):
    context = context or sys.modules[__name__]
    import docker

    client = docker.from_env(timeout=3600)
    for task in context.selected_tasks(out, ids):
        image = pinned_image(client, out, task)
        container = client.containers.create(image=image.id, user="root", command="sleep 1800", network_mode="none", cap_drop=["ALL"], security_opt=["no-new-privileges"], pids_limit=256, mem_limit="6g", nano_cpus=2000000000)
        try:
            container.start()
            network = study.blackhole_network(container)
            report = context.container_audit(out, task, image, container, "image-audits")
            private_save(out / "image-audits" / f"{task['instance_id']}.json", {**report, **network})
        finally:
            container.remove(force=True)


def package_import_proof(module_name):
    import importlib
    import importlib.metadata
    import json
    import pathlib
    import urllib.parse

    module = importlib.import_module(module_name)
    origins = [str(pathlib.Path(value).resolve()) for value in ([module.__file__] if getattr(module, "__file__", None) else list(module.__path__))]
    distributions = []
    for name in importlib.metadata.packages_distributions().get(module_name.split(".")[0], []):
        distribution = importlib.metadata.distribution(name)
        direct = json.loads(distribution.read_text("direct_url.json") or "{}")
        root = pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(direct.get("url", "")).path)).resolve() if direct.get("url") else pathlib.Path(distribution.locate_file("")).resolve()
        distributions.append({"name": name, "version": distribution.version, "direct_url": direct, "source_root": str(root), "base_source": root.is_relative_to("/testbed")})
    return {"module": module_name, "origins": origins, "distributions": distributions, "valid": bool(origins) and all(pathlib.Path(path).is_relative_to("/testbed") for path in origins) and all(item["base_source"] for item in distributions)}


def discover_package_import():
    import importlib.metadata
    import json
    import pathlib
    import pkgutil
    import re
    import urllib.parse

    normal = lambda value: re.sub(r"[-_.]+", "-", value).lower()
    candidates, sources, attempts = {}, [], []
    for distribution in importlib.metadata.distributions():
        direct = json.loads(distribution.read_text("direct_url.json") or "{}")
        root = pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(direct.get("url", "")).path)).resolve() if direct.get("url") else pathlib.Path(distribution.locate_file("")).resolve()
        if not root.is_relative_to("/testbed"):
            continue
        name = distribution.metadata.get("Name", "")
        declared = [value for value in (distribution.read_text("top_level.txt") or "").splitlines() if re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", value)]
        sources.append({"distribution": name, "version": distribution.version, "source_root": str(root), "declared_top_level": declared})
        for module in declared:
            score = 0 if normal(module) == normal(name) else 1 if normal(module) in normal(name) else 2
            candidates[module] = min(candidates.get(module, 99), score)
        for location in [root, root / "src", root / "backend"]:
            if location.is_dir():
                for module in pkgutil.iter_modules([str(location)]):
                    if not module.name.startswith(("_", "test")) and module.name not in {"setup", "conftest", "docs", "examples", "build"}:
                        score = 3 if normal(module.name) == normal(name) else 4 if normal(module.name) in normal(name) else 5
                        candidates[module.name] = min(candidates.get(module.name, 99), score)
    ordered = sorted(candidates, key=lambda value: (candidates[value], value))
    if not ordered:
        return {"valid": False, "metadata_sources": sources, "discovery_attempts": [], "reason": "No package declared by or discovered under a base-source distribution"}
    module = ordered[0]
    try:
        proof = package_import_proof(module)
        attempts.append({"module": module, "valid": proof["valid"]})
        return {**proof, "metadata_sources": sources, "discovery_attempts": attempts, "selection": "best declared distribution-name match, then observed source-package match; failed primary imports never fall back to an easier module"}
    except Exception as error:
        attempts.append({"module": module, "valid": False, "error": str(error)})
        return {"valid": False, "metadata_sources": sources, "discovery_attempts": attempts, "reason": "Primary base-source package import failed"}


def test_node_added_by_hidden_patch(task, node):
    added = set(re.findall(r"^\+\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)", task["test_patch"], re.MULTILINE))
    return any(component.split("[")[0] in added for component in node.split("::")[1:])


def runtime_smoke(out, task, container, *, context=None):
    context = context or sys.modules[__name__]
    from swebench.harness.docker_utils import exec_run_with_timeout
    from swebench.harness.log_parsers import MAP_REPO_TO_PARSER
    from swebench.harness.test_spec.test_spec import REMOTE_CONDA_ACTIVATE

    activation = REMOTE_CONDA_ACTIVATE + "; conda activate testbed"
    import_source = inspect.getsource(package_import_proof) + "\n" + inspect.getsource(discover_package_import) + "\nimport json; print(json.dumps(discover_package_import()))"
    result = container.exec_run(["/bin/bash", "-c", activation + " && python -c " + shlex.quote(import_source)], workdir="/testbed")
    import_report = json.loads(result.output.decode().splitlines()[-1]) if result.exit_code == 0 else {"valid": False, "output": result.output.decode()}
    private_save(out / "runtime-logs" / task["instance_id"] / "import.json", import_report)
    if not import_report.get("valid"):
        raise RuntimeError(f"Sanitized package import/source-distribution proof failed: {import_report}")
    test_cmd = task["install_config"]["test_cmd"]
    if not isinstance(test_cmd, str):
        raise RuntimeError("Runtime smoke requires the source dataset string test_cmd")
    runner = [token for token in shlex.split(test_cmd) if not token.endswith(".py")]
    if not runner or runner[0] != "pytest":
        raise RuntimeError("Runtime smoke supports only the source dataset pytest runner")
    spec = make_spec(task, container.attrs["Image"])
    attempts, skipped = [], []
    for node in sorted(task["PASS_TO_PASS"], key=lambda value: hashlib.sha256(value.encode()).hexdigest()):
        path = node.split("::")[0]
        if "::" not in node or not path.endswith(".py") or Path(path).is_absolute() or ".." in Path(path).parts:
            continue
        if container.exec_run(["test", "-f", "/testbed/" + path]).exit_code != 0:
            skipped.append({"node": node, "reason": "file_absent_at_base"})
            continue
        command = activation + " && cd /testbed && " + shlex.join(runner + [node])
        output, timed_out, elapsed = exec_run_with_timeout(container, ["/bin/bash", "-c", command], context.config()["evaluator_timeout_seconds"])
        status = MAP_REPO_TO_PARSER[task["install_config"]["log_parser"]](output, spec).get(node)
        valid = not timed_out and status in {"PASSED", "XFAIL"}
        not_collected = status is None and not timed_out and any(message in output.lower() for message in ["not found:", "not collected", "no tests ran", "error collecting"])
        attempt = {"node": node, "status": status, "valid": valid, "declaration_added_by_test_patch": test_node_added_by_hidden_patch(task, node), "not_present_at_base": not_collected, "timed_out": timed_out, "elapsed_seconds": elapsed, "output_sha256": hashlib.sha256(output.encode()).hexdigest()}
        attempts.append(attempt)
        private_save(out / "runtime-logs" / task["instance_id"] / f"retained-attempt-{len(attempts)}.json", {**attempt, "test_output": output})
        proof = {"import": import_report, "retained_node": node, "retained_status": status, "timed_out": timed_out, "output_sha256": attempt["output_sha256"], "attempts": attempts, "skipped": skipped, "valid": valid}
        private_save(out / "runtime-logs" / task["instance_id"] / "smoke.json", proof)
        if valid:
            return proof
        if not not_collected or len(attempts) >= 8:
            raise RuntimeError("Retained-node proof failed; actual failed tests are never replaced by an easier test")
    private_save(out / "runtime-logs" / task["instance_id"] / "smoke.json", {"import": import_report, "attempts": attempts, "skipped": skipped, "valid": False, "reason": "no_retained_base_test_node"})
    raise RuntimeError("No retained PASS_TO_PASS node could be proved present in the unchanged base snapshot")


def runtime_smoke_valid(task, smoke):
    imported = smoke.get("import", {})
    origins = imported.get("origins", [])
    attempts = smoke.get("attempts", [])
    if not attempts or len(attempts) > 8 or any(not attempt.get("not_present_at_base") for attempt in attempts[:-1]) or attempts[-1].get("node") != smoke.get("retained_node") or attempts[-1].get("status") != smoke.get("retained_status"):
        return False
    return smoke.get("valid") is True and smoke.get("retained_node") in task["PASS_TO_PASS"] and smoke.get("retained_status") in {"PASSED", "XFAIL"} and smoke.get("timed_out") is False and bool(smoke.get("output_sha256")) and imported.get("valid") is True and bool(origins) and all(Path(path).is_relative_to("/testbed") for path in origins) and all(item.get("base_source") is True and Path(item["source_root"]).is_relative_to("/testbed") for item in imported.get("distributions", []))


def runtime_proof(out, ids, *, context=None):
    context = context or sys.modules[__name__]
    import docker

    client = docker.from_env(timeout=3600)
    for task in context.selected_tasks(out, ids):
        image = pinned_image(client, out, task)
        logger = SimpleNamespace(log_file=out / "runtime-logs" / task["instance_id"] / "runtime.log")
        container = study.isolated_create_container(SimpleNamespace(image=image.id), client, f"runtime-{uuid.uuid4().hex}", logger)
        try:
            container.start()
            snapshot = prepare_base_snapshot(container, task, sanitize=True)
            smoke = context.runtime_smoke(out, task, container)
            unchanged = container.exec_run(["/bin/bash", "-c", f"git add -N . && git diff --exit-code {snapshot['base_tree']} && test -z \"$(git ls-files --others --exclude-standard)\""], workdir="/testbed")
            private_save(out / "runtime-logs" / task["instance_id"] / "unchanged.json", {"fixture_sha256": study.digest(task), "exit_code": unchanged.exit_code, "output": unchanged.output.decode(errors="replace")})
            if unchanged.exit_code:
                raise RuntimeError("Runtime smoke left a nonempty unchanged-candidate patch")
            report = context.container_audit(out, task, image, container, "runtime")
            isolation = study.load(Path(logger.log_file).parent / "isolation.json")
            report.update(snapshot=snapshot, smoke=smoke, unchanged_candidate_diff_exit_code=unchanged.exit_code, solver_input_sha256=study.digest(solver_input(task)), **{key: isolation[key] for key in ["interfaces", "routes", "output_filter"]})
            private_save(out / "runtime" / f"{task['instance_id']}.json", report)
        finally:
            container.remove(force=True)


def retained_grades_valid(out, task, fixture, image_id, *, context=None):
    context = context or sys.modules[__name__]
    receipts = fixture.get("receipts", {})
    if set(receipts) != {"baseline", "gold", "gold-repeat", "empty"} or not context.current_attempts_valid(fixture.get("attempts", [])):
        return False
    cases = {}
    for label, receipt in receipts.items():
        if receipt.get("test_started") is not True:
            return False
        if receipt.get("image_id") != image_id or receipt.get("fixture_sha256") != study.digest(task) or receipt.get("harness_revision") != context.config()["harness_revision"] or receipt.get("implementation_hashes") != context.implementation_hashes():
            return False
        case = receipt.get("result", [None, {}])[1].get(task["instance_id"], {})
        if not valid_grade(task, case, label.startswith("gold")):
            return False
        artifacts = receipt.get("artifacts", {})
        if {Path(name).name for name in artifacts} != {"report.json", "test_output.txt", "eval.sh", "patch.diff", "isolation.json"}:
            return False
        for name, expected in artifacts.items():
            path = (out / name).resolve()
            if not path.is_relative_to(out.resolve()) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                return False
            if path.name == "report.json" and study.load(path) != receipt["result"][1]:
                return False
            if path.name == "isolation.json":
                isolation = study.load(path)
                if not isolation_valid(isolation, image_id) or isolation.get("implementation_hashes") != context.implementation_hashes() or isolation.get("snapshot", {}).get("snapshot_tree") != isolation.get("snapshot", {}).get("base_tree"):
                    return False
        cases[label] = case
    return cases["baseline"] == cases["empty"] and cases["gold"] == cases["gold-repeat"]


def audit(out):
    panel, tasks = check_panel(out)
    missing = []
    for task in tasks:
        task_id = task["instance_id"]
        paths = {key: out / directory / f"{task_id}.json" for key, directory in [("image", "images"), ("fixture", "fixtures"), ("image_audit", "image-audits"), ("runtime", "runtime")]}
        if any(not path.exists() for path in paths.values()):
            missing.append({"instance_id": task_id, "missing": [key for key, path in paths.items() if not path.exists()]})
            continue
        records = {key: study.load(path) for key, path in paths.items()}
        image_id = records["image"]["id"]
        valid = records["fixture"].get("eligible") is True and all(records[key].get("image_id") == image_id and records[key].get("fixture_sha256") == study.digest(task) for key in ["fixture", "image_audit", "runtime"])
        valid = valid and resource_contract(task, out)["compatible"]
        valid = valid and all(scan_report_valid(records[key], task) and isolation_valid(records[key], image_id) and records[key].get("implementation_hashes") == implementation_hashes() for key in ["image_audit", "runtime"])
        runtime = records["runtime"]
        valid = valid and runtime.get("snapshot", {}).get("sanitized") is True and runtime.get("snapshot", {}).get("snapshot_tree") == runtime.get("snapshot", {}).get("base_tree") and runtime_smoke_valid(task, runtime.get("smoke", {})) and runtime.get("unchanged_candidate_diff_exit_code") == 0 and runtime.get("solver_input_sha256") == study.digest(solver_input(task))
        valid = valid and retained_grades_valid(out, task, records["fixture"], image_id)
        try:
            evidence = next(item for item in study.load(out / "licenses.json") if item["instance_id"] == task_id)
            license_check = verify_license_blob(task, evidence)
            private_save(out / "license-checks" / f"{task_id}.json", license_check)
        except Exception as error:
            valid = False
            missing.append({"instance_id": task_id, "reason": "base_commit_license_verification_failed", "error": str(error)})
        if not valid:
            missing.append({"instance_id": task_id, "reason": "ineligible_or_mismatched_evidence"})
    report = {"schema": "modern-panel-readiness-v1", "panel_sha256": study.digest(panel), "executable_panel_ready": not missing, "provider_permission_established_by_adapter": False, "implementation_hashes": implementation_hashes(), "pool_provenance": POOL_PROVENANCE, "solver_input_contract": list(SOLVER_FIELDS), "host_egress_requirement": "Pinned fork make_test_spec may fetch raw.githubusercontent.com requirements/environment files on host; failures are infrastructure-invalid attempts, never model failures", "blockers": missing, "limitations": config()["limitations"]}
    study.save(out / "readiness.json", report)
    return report






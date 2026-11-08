import argparse
import hashlib
import json
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

SPEC_SCHEMA = "router-quality-cost-panel-v1"
HISTORICAL = ("classic", "calibration", "modern", "census")


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def load_driver(driver_dir):
    sys.path.insert(0, str(Path(driver_dir).resolve(strict=True)))
    import census_panel
    import modern_panel
    import study

    return SimpleNamespace(census=census_panel, modern=modern_panel, study=study)


def read_spec(path):
    spec = json.loads(Path(path).read_text())
    selection = spec.get("evaluation_panel", {})
    split = spec.get("split", {})
    if spec.get("schema") != SPEC_SCHEMA or not spec.get("experiment_id"):
        raise RuntimeError("Unsupported panel specification")
    if selection.get("min_tasks_per_repository") != 1 or selection.get("max_tasks_per_repository") != 1:
        raise RuntimeError("Each repository must contribute exactly one task")
    tuning, target = split.get("tuning_tasks"), selection.get("target_tasks")
    if type(tuning) is not int or type(target) is not int or not 0 < tuning < target:
        raise RuntimeError("The tuning split must leave a nonempty final holdout")
    return spec


def derived_authorization(spec_path):
    spec = read_spec(spec_path)
    return {"schema": "router-quality-cost-panel-authorization-v1", "amends_preregistration_sha256": file_hash(spec_path),
            "model_outcomes_observed": False, "paid_calls_before_amendment": 0,
            "panel": {key: spec["evaluation_panel"][key] for key in ("created_at_min", "target_tasks", "min_tasks_per_repository", "max_tasks_per_repository")}}


def panel_config(driver, spec_path, historical):
    spec = read_spec(spec_path)
    selection = spec["evaluation_panel"]
    if any(not historical[name].get("tasks") for name in HISTORICAL):
        raise RuntimeError("Every historical exclusion panel must contain tasks")
    return {**driver.census.config(), "schema": SPEC_SCHEMA, "experiment": spec["experiment_id"],
            "dataset": selection["dataset"], "dataset_revision": selection["revision"], "dataset_split": selection["split"],
            **{key: selection[key] for key in ("seed", "created_at_min", "target_tasks", "min_tasks_per_repository", "max_tasks_per_repository")},
            "families": selection["target_tasks"], "preregistration_sha256": file_hash(spec_path),
            "panel_amendment_sha256": hashlib.sha256(json_bytes(derived_authorization(spec_path))).hexdigest(),
            "historical_panels_sha256": {name: driver.study.digest(historical[name]) for name in HISTORICAL},
            "limitations": spec["limitations"]}


def create_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as stream:
        stream.write(json_bytes(value))
    path.chmod(0o600)
    return value


def prior_panel(historical):
    tasks = historical["classic"]["tasks"] + historical["calibration"]["tasks"] + historical["census"]["tasks"]
    return {"tasks": tasks, "selection": {"families": historical["census"].get("selection", {}).get("families", [])}}


# The pinned import-discovery probe needs Python 3.9 APIs. Older task images cannot run it at all,
# which is a fixed property of the image, not an infrastructure fault.
UNSUPPORTED_RUNTIME_PYTHON = (("ModuleNotFoundError", "importlib.metadata"), ("AttributeError", "is_relative_to"))


@contextmanager
def adapter(driver, cfg):
    original = driver.census.structural_rejection

    def structural_rejection(out, task, stage, error):
        reason = original(out, task, stage, error)
        message = str(error)
        if reason is None and stage == "runtime" and message.startswith("Sanitized package import/source-distribution proof failed") and any(all(part in message for part in marker) for marker in UNSUPPORTED_RUNTIME_PYTHON):
            return {"stage": stage, "reason": "runtime_python_unsupported", "details": message}
        return reason

    with patch.object(driver.census, "config", lambda: cfg), patch.object(driver.census, "structural_rejection", structural_rejection):
        yield


def prepare(driver, out, spec_path, panels, rows=None):
    out = Path(out).resolve()
    historical = {name: driver.study.load(panels[name]) for name in HISTORICAL}
    cfg = panel_config(driver, spec_path, historical)
    if (out / "candidates.json").exists():
        return check_candidates(driver, out, spec_path)
    with tempfile.TemporaryDirectory(prefix="router-panel-inputs-") as directory:
        temporary = Path(directory)
        create_json(temporary / "prior.json", prior_panel(historical))
        create_json(temporary / "panel-authorization.json", derived_authorization(spec_path))
        with adapter(driver, cfg):
            manifest = driver.census.prepare(out, temporary / "prior.json", panels["modern"], rows=rows, cfg=cfg,
                                             preregistration=spec_path, amendment=temporary / "panel-authorization.json")
    for name in HISTORICAL:
        create_json(out / "router-provenance" / f"{name}.json", historical[name])
    with frozen_spec(out).open("xb") as stream:
        stream.write(Path(spec_path).read_bytes())
    frozen_spec(out).chmod(0o600)
    return manifest


def load_config(driver, out, spec_path):
    out = Path(out).resolve()
    historical = {name: driver.study.load(out / "router-provenance" / f"{name}.json") for name in HISTORICAL}
    cfg = panel_config(driver, spec_path, historical)
    if driver.study.load(out / "provenance" / "classic-panel.json") != prior_panel(historical) or driver.study.load(out / "provenance" / "modern-panel.json") != historical["modern"]:
        raise RuntimeError("Historical exclusions differ from their frozen original panels")
    if driver.study.load(out / "authorizations" / "panel-amendment.json") != derived_authorization(spec_path):
        raise RuntimeError("Derived panel authorization changed")
    return cfg


def check_candidates(driver, out, spec_path):
    with adapter(driver, load_config(driver, out, spec_path)):
        manifest, _, _ = driver.census.check_candidates(out)
    return manifest


@contextmanager
def github_cache(driver, path, out):
    source = Path(path).resolve(strict=True)
    raw = source.read_bytes()
    manifest = json.loads(raw)
    if manifest.get("version") != 1 or not isinstance(manifest.get("responses"), dict):
        raise RuntimeError("Invalid public GitHub cache manifest")
    driver.census.create_only(Path(out) / "github-cache-manifest.json", manifest)
    provenance = {"mode": "public-json-cache", "cache_file_sha256": hashlib.sha256(raw).hexdigest(),
                  "cache_document_sha256": driver.study.digest(manifest), "used_urls": {}}

    def get(url):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "api.github.com" or not parsed.path.startswith("/repos/") or parsed.fragment:
            raise RuntimeError("Only exact public GitHub repository API URLs are cacheable")
        entry = manifest["responses"].get(url)
        if not isinstance(entry, dict):
            raise RuntimeError(f"Missing exact public GitHub cache URL; no network fallback: {url}")
        status, body = entry.get("status"), entry.get("body")
        if type(status) is not int or status not in (200, 404) or not isinstance(body, dict):
            raise RuntimeError("Cache only public JSON200 responses or explicit public JSON404 responses")
        provenance["used_urls"][url] = {"body_sha256": driver.study.digest(body), "http_status": status}
        if status != 200:
            from requests import HTTPError
            raise HTTPError(f"Cached public GitHub response {status}: {url}", response=SimpleNamespace(status_code=status))
        return body

    with patch.object(driver.modern, "github_json", get):
        yield provenance


def readiness(driver, out, spec_path, cache_path, remove_images):
    with adapter(driver, load_config(driver, out, spec_path)), github_cache(driver, cache_path, out) as provenance:
        result = driver.census.readiness(out, None, remove_images)
        result["github_access"] = provenance
        driver.modern.private_save(Path(out) / "readiness.json", result)
    if result["state"]["exhausted"]:
        raise RuntimeError("Fresh supply exhausted before the frozen target; never shrink the panel")
    return result


def split_tasks(driver, spec, tasks):
    seed = spec["split"]["seed"]
    ordered = sorted(tasks, key=lambda task: driver.study.digest([seed, task["instance_id"]]))
    count = spec["split"]["tuning_tasks"]
    return {"tuning": [task["instance_id"] for task in ordered[:count]], "final": [task["instance_id"] for task in ordered[count:]]}


def check_panel(driver, out, spec_path):
    out = Path(out).resolve()
    cfg = load_config(driver, out, spec_path)
    with adapter(driver, cfg):
        public, private = driver.census.check_panel(out)
    access = driver.study.load(out / "readiness.json").get("github_access", {})
    cached = driver.study.load(out / "github-cache-manifest.json")
    if access.get("mode") != "public-json-cache" or driver.study.digest(cached) != access.get("cache_document_sha256"):
        raise RuntimeError("Retained public GitHub cache differs from readiness provenance")
    for url, evidence in access.get("used_urls", {}).items():
        entry = cached["responses"].get(url, {})
        if evidence != {"http_status": entry.get("status"), "body_sha256": driver.study.digest(entry.get("body"))}:
            raise RuntimeError("Used public GitHub response differs from its frozen body hash")
    if len({driver.modern.canonical_repo(task["repo"]) for task in private}) != cfg["target_tasks"]:
        raise RuntimeError("The panel requires one task from each distinct repository")
    return public, private


def task_evidence(driver, out, spec_path, task):
    with adapter(driver, load_config(driver, out, spec_path)):
        return driver.census.task_evidence(Path(out).resolve(), task)


def frozen_spec(out):
    return Path(out).resolve() / "router-panel-spec.json"


def freeze(driver, out, spec_path):
    out = Path(out).resolve()
    with adapter(driver, load_config(driver, out, spec_path)):
        driver.census.freeze_panel(out)
    public, _ = check_panel(driver, out, spec_path)
    split = split_tasks(driver, read_spec(spec_path), public["tasks"])
    record = {"schema": "router-quality-cost-split-v1", "panel_sha256": driver.study.digest(public),
              "spec_sha256": file_hash(spec_path), "outcomes_used": False, **split}
    driver.census.create_only(out / "split.json", record)
    return record


def main():
    parser = argparse.ArgumentParser(description="Fresh one-task-per-repository router panel; no paid inference")
    parser.add_argument("command", choices=["prepare", "readiness", "freeze", "check"])
    parser.add_argument("--driver-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--spec", required=True, type=Path)
    for name in HISTORICAL:
        parser.add_argument(f"--{name}-panel", type=Path)
    parser.add_argument("--rows", type=Path)
    parser.add_argument("--github-cache", type=Path)
    parser.add_argument("--remove-images", action="store_true")
    args = parser.parse_args()
    driver = load_driver(args.driver_dir)
    if args.command == "prepare":
        panels = {name: getattr(args, f"{name}_panel") for name in HISTORICAL}
        if any(path is None for path in panels.values()):
            raise SystemExit("prepare requires every historical panel")
        manifest = prepare(driver, args.out, args.spec, panels, rows=driver.study.load(args.rows) if args.rows else None)
        result = {"candidates": len(manifest["tasks"]), "families": len(manifest["families"])}
    elif args.command == "readiness":
        if args.github_cache is None:
            raise SystemExit("readiness requires --github-cache")
        result = readiness(driver, args.out, args.spec, args.github_cache, args.remove_images)["state"]
    elif args.command == "freeze":
        result = freeze(driver, args.out, args.spec)
    else:
        result = {"tasks": len(check_panel(driver, args.out, args.spec)[0]["tasks"])}
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import closing, contextmanager
from decimal import Decimal, InvalidOperation
import fcntl
import hashlib
import importlib
import importlib.util
import json
import math
import multiprocessing
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time
from types import SimpleNamespace
import uuid

DRIVER_ROOT = Path(__file__).resolve().parent.parent / "repo-study"
sys.path.insert(0, str(DRIVER_ROOT))
import text_tariffs
from text_tariffs import resolve_variant


MANIFEST = "router-study-manifest.json"
SPEC_VERSION = 6
# Legacy ledger ceiling from imported metadata; never by itself permission.
CAP = Decimal("250")
# Nested capped-exploration ceilings inside the cumulative new authorization.
PILOT_CAP_USD = Decimal("60")
RUN_CAP_USD = Decimal("60")
MODES = ("efficient", "frontier")
GATEWAY_MODELS = {mode: f"kilo-auto/{mode}" for mode in MODES}
ROUTING_TABLE_KEYS = {"efficient": "routing_table_v1", "frontier": "routing_table_frontier_v1"}
PRICING_MAX_AGE_SECONDS = 7200
LEASE_MARGIN_SECONDS = 600
SAFE = re.compile(r"[a-z0-9][a-z0-9_-]{0,79}")
REPO = Path(__file__).resolve().parents[3]
SOURCE_ROOTS = ("services/auto-routing", "packages/auto-routing-contracts", "packages/usage-contracts", "packages/worker-utils", "packages/db")
SOURCE_EXCLUDED = {"node_modules", "dist", "coverage"}
MODEL_UNAVAILABLE = text_tariffs.MODEL_UNAVAILABLE
RUNTIME_SOURCE = "repo/services/auto-routing-benchmark/scripts/router-runtime.ts"
MUTEX = threading.RLock()


def helper(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CAMPAIGN = helper("router-ledger")


def campaign_path(out):
    path = Path(out) / "budget.sqlite"
    manifest = load(Path(out) / MANIFEST)
    expected = Path(manifest["spec"]["campaign_ledger"]).resolve(strict=True)
    if not path.is_symlink() or path.resolve(strict=True) != expected:
        raise ValueError("Run ledger must remain linked to the one frozen global campaign ledger")
    return expected

class ProviderUnavailable(RuntimeError):
    pass


def money(value):
    if isinstance(value, bool) or value is None:
        raise ValueError("Missing or invalid money")
    try:
        result = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError("Invalid money") from error
    if not result.is_finite() or result < 0:
        raise ValueError("Money must be finite and nonnegative")
    return result


def load(path):
    return json.loads(Path(path).read_text())


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def frozen_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
    path.chmod(0o600)


def frozen_bytes(content, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with destination.open("xb") as stream:
        stream.write(content)
    destination.chmod(0o600)


def frozen_copy(source, destination):
    frozen_bytes(Path(source).read_bytes(), destination)


def driver(directory):
    directory = Path(directory).resolve(strict=True)
    if directory != DRIVER_ROOT.resolve(strict=True):
        raise ValueError("Use the bundled study driver; external executable drivers are not admitted")
    modules = {}
    for name in ("study", "modern_panel", "modern_eval", "census_panel", "census"):
        module = importlib.import_module(name)
        if Path(module.__file__).resolve().parent != directory:
            raise RuntimeError(f"Driver import escaped --driver-dir: {name}")
        modules[name] = module
    return modules


def sources(directory):
    result = {}
    paths = [path for root in SOURCE_ROOTS for path in (REPO / root).rglob("*")]
    for path in (REPO / "services/auto-routing-benchmark/scripts").glob("router-*"):
        paths += [path, *path.rglob("*")] if path.is_dir() else [path]
    paths.append(REPO / "pnpm-lock.yaml")
    for path in sorted(set(paths)):
        parts = path.relative_to(REPO).parts
        if path.is_file() and not SOURCE_EXCLUDED.intersection(parts) and not any(part.startswith(".") for part in parts):
            result["repo/" + "/".join(parts)] = file_hash(path)
    for path in sorted(Path(directory).iterdir()):
        if path.is_file() and path.suffix in {".py", ".json"}:
            result["driver/" + path.name] = file_hash(path)
    if RUNTIME_SOURCE not in result or "driver/study.py" not in result:
        raise RuntimeError("Actual router runtime and pinned driver sources must exist before freeze")
    return result


def variant_label(fields):
    variant = fields.get("variant")
    if variant is not None:
        if not isinstance(variant, str) or not variant:
            raise ValueError("Invalid router variant")
        return "variant=" + variant
    effort = fields.get("reasoningEffort")
    if effort is not None and (not isinstance(effort, str) or not effort):
        raise ValueError("Invalid legacy reasoning effort")
    return "effort=" + (effort or "")




def table_pairs(table):
    pairs = set()
    for rows in (table.get("routes") or {}).values():
        for row in rows:
            model = row.get("model")
            if not isinstance(model, str) or ":" in model or "/" not in model:
                raise ValueError("Routing table candidate is not an exact concrete model")
            pairs.add((model, variant_label(row)))
    if not pairs:
        raise ValueError("Frozen routing table has no concrete candidates")
    return pairs


def mode_pairs(snapshot, mode):
    key = ROUTING_TABLE_KEYS[mode]
    pairs = set()
    for version in ("baseline", "candidate"):
        kv = snapshot[version]["kv"]
        if key not in kv:
            raise ValueError(f"Snapshot lacks the exact {mode} routing table")
        pairs.update(table_pairs(json.loads(kv[key])))
    return pairs


DEFAULT_CLASSIFIER_MODEL = "typesafe/jev-1.13"


def classifier_model(snapshot):
    """Classifier model named by the frozen baseline KV, or the contract default."""
    baseline = snapshot.get("baseline") if isinstance(snapshot, dict) else None
    kv = baseline.get("kv") if isinstance(baseline, dict) else None
    if not isinstance(kv, dict):
        raise ValueError("Snapshot lacks baseline KV for the classifier model")
    if isinstance(kv.get("classifier_model"), str) and kv["classifier_model"]:
        return kv["classifier_model"]
    winner = json.loads(kv.get("classifier_system_one_winner", "null"))
    if isinstance(winner, dict) and isinstance(winner.get("model"), str) and winner["model"]:
        return winner["model"]
    return DEFAULT_CLASSIFIER_MODEL


def router_fingerprint(mode, pool):
    """Live router arm attempt identity: gateway model plus the frozen mode pool."""
    return digest({"arm": "router", "gateway_model": GATEWAY_MODELS[mode], "pool": [list(pair) for pair in sorted(tuple(pair) for pair in pool)]})


def snapshot_contract(snapshot):
    """Frozen pool pairs from the baseline/candidate routing tables.

    The snapshot defines the unchanged pool only. Paid router dispatch goes
    to the live gateway model; no classifier is selected or priced here.
    """
    if not isinstance(snapshot, dict) or not {"baseline", "candidate"} <= set(snapshot):
        raise ValueError("Snapshot must contain baseline and candidate KV")
    pairs = set()
    for version in ("baseline", "candidate"):
        entry = snapshot[version]
        if not isinstance(entry, dict) or set(entry) != {"kv"} or not isinstance(entry["kv"], dict):
            raise ValueError("Each snapshot version must contain only its KV dictionary")
        kv = entry["kv"]
        if not all(isinstance(key, str) and isinstance(value, str) for key, value in kv.items()):
            raise ValueError("KV values must be exact strings")
        tables = [json.loads(value) for key, value in kv.items() if key.startswith("routing_table")]
        if not tables or "model_capabilities_v2" not in kv:
            raise ValueError("Snapshot lacks routing tables or capability data")
        for table in tables:
            pairs |= table_pairs(table)
    return sorted(pairs)


def arm_slug(model):
    slug = re.sub(r"[^a-z0-9_-]+", "-", model.lower()).strip("-")
    if not slug:
        raise ValueError("Fixed model has no safe arm identity")
    return slug


def fixed_arm_id(model):
    return "fixed-" + arm_slug(model)


def arm_definitions(spec):
    """Logical arms per mode. Counts derive from the frozen pools; no sharing."""
    candidates = {item["router"]: item["id"] for item in spec["configurations"]}
    arms = {}
    for mode in MODES:
        entries = [
            {"arm_id": "router", "arm_kind": "router", "configuration": candidates[mode], "version": "router", "model": None, "variant": None},
            {"arm_id": "control", "arm_kind": "control", "configuration": "control", "version": "control", "model": None, "variant": None},
        ]
        for fixed in spec["fixed_models"][mode]:
            entries.append({"arm_id": fixed_arm_id(fixed["model"]), "arm_kind": "fixed", "configuration": fixed_arm_id(fixed["model"]), "version": "fixed", "model": fixed["model"], "variant": fixed["variant"]})
        if len({entry["arm_id"] for entry in entries}) != len(entries):
            raise ValueError("Arm identities collide after slugging; frozen arm identities must be distinct")
        arms[mode] = entries
    return arms


def control_choice(spec, mode, instance_id, repetition):
    """Content-blind frozen selection: seed/mode/task-id/repetition only, never task content."""
    distribution = spec["control"]["distribution"][mode]
    fraction = Decimal(int(digest([spec["control"]["seed"], mode, instance_id, repetition]), 16)) / Decimal(2 ** 256)
    cumulative = Decimal(0)
    for entry in distribution:
        cumulative += Decimal(entry["weight"])
        if fraction < cumulative:
            return entry["model"], entry["variant"]
    return distribution[-1]["model"], distribution[-1]["variant"]


def _validate_objectives(objectives):
    if not isinstance(objectives, dict) or set(objectives) != set(MODES):
        raise ValueError("Freeze one objective per mode before any final outcome")
    efficient = objectives["efficient"]
    if not isinstance(efficient, dict) or set(efficient) != {"kind", "success_floor"} or efficient["kind"] != "efficient-minimize-cost-preserve-success":
        raise ValueError("Efficient objective must minimize full-task cost while preserving a frozen success floor")
    floor = efficient["success_floor"]
    if not isinstance(floor, dict) or floor.get("type") not in {"comparator-relative", "absolute"} or floor["type"] == "absolute" and (set(floor) != {"type", "min_pass_rate"} or not isinstance(floor["min_pass_rate"], str) or not 0 <= money(floor["min_pass_rate"]) <= 1) or floor["type"] != "absolute" and set(floor) != {"type"}:
        raise ValueError("Efficient success floor must be a preregistered comparator-relative or absolute rule; there is no baseline arm")
    frontier = objectives["frontier"]
    if not isinstance(frontier, dict) or set(frontier) != {"kind", "cost_budget"} or frontier["kind"] != "frontier-maximize-success-within-cost":
        raise ValueError("Frontier objective must maximize verified success within a frozen cost budget")
    budget = frontier["cost_budget"]
    if not isinstance(budget, dict) or budget.get("type") not in {"comparator-relative", "absolute"} or budget["type"] == "absolute" and (set(budget) != {"type", "max_total_usd"} or not isinstance(budget["max_total_usd"], str) or money(budget["max_total_usd"]) <= 0) or budget["type"] != "absolute" and set(budget) != {"type"}:
        raise ValueError("Frontier cost budget must be a preregistered comparator-relative or absolute rule; there is no baseline arm")


def _validate_arms_spec(spec):
    fixed = spec["fixed_models"]
    if not isinstance(fixed, dict) or set(fixed) != set(MODES):
        raise ValueError("Freeze fixed-model variant policies for both modes")
    for mode in MODES:
        entries = fixed[mode]
        if not isinstance(entries, list) or not entries or any(not isinstance(entry, dict) or set(entry) != {"model", "variant"} or not isinstance(entry["model"], str) or ":" in entry["model"] or "/" not in entry["model"] or not isinstance(entry["variant"], str) or "=" not in entry["variant"] for entry in entries) or len({entry["model"] for entry in entries}) != len(entries):
            raise ValueError("Each mode needs one frozen supported variant policy per distinct fixed model")
    control = spec["control"]
    if not isinstance(control, dict) or set(control) != {"seed", "distribution", "cost_matching"} or not isinstance(control["seed"], str) or not control["seed"]:
        raise ValueError("Content-blind control needs a frozen seed, distribution and cost-matching rule")
    matching = control["cost_matching"]
    if not isinstance(matching, dict) or set(matching) != {"criterion", "reference_arm", "tolerance_fraction"} or matching["criterion"] != "total-cost-ratio-vs-reference" or matching["reference_arm"] != "router" or not isinstance(matching["tolerance_fraction"], str) or not 0 <= money(matching["tolerance_fraction"]) < 1:
        raise ValueError("Freeze the control cost-matching criterion and tolerance before outcomes")
    distribution = control["distribution"]
    if not isinstance(distribution, dict) or set(distribution) != set(MODES):
        raise ValueError("Content-blind control needs a frozen selection distribution per mode")
    for mode in MODES:
        entries = distribution[mode]
        allowed = {(entry["model"], entry["variant"]) for entry in fixed[mode]}
        if not isinstance(entries, list) or not entries or any(not isinstance(entry, dict) or set(entry) != {"model", "variant", "weight"} or (entry["model"], entry["variant"]) not in allowed or not isinstance(entry["weight"], str) or money(entry["weight"]) <= 0 for entry in entries) or sum((money(entry["weight"]) for entry in entries), Decimal(0)) != 1 or len({(entry["model"], entry["variant"]) for entry in entries}) != len(entries):
            raise ValueError("Control distribution must weight frozen fixed model/variant pairs and sum to one per mode")
    _validate_objectives(spec["objectives"])
    arm_definitions(spec)


def validate_spec(spec, modules):
    expected = {"version", "experiment_id", "configurations", "tasks", "resources", "pilot_cap_usd", "kilo_organization_id", "classifier_allowance_usd", "gateway_routing_table_version", "variant_catalog", "execution_manifest", "campaign_ledger", "repetitions", "seed", "prospective_grant_id", "fixed_models", "control", "objectives"}
    if not isinstance(spec, dict) or set(spec) != expected or spec["version"] != SPEC_VERSION or not isinstance(spec["experiment_id"], str) or not SAFE.fullmatch(spec["experiment_id"]):
        raise ValueError("Exact version6 capped-exploration router study spec required; old manifests are audit-only")
    if type(spec["repetitions"]) is not int or spec["repetitions"] != 2 or not isinstance(spec["seed"], str) or not spec["seed"]:
        raise ValueError("Exactly two paired repetitions and a frozen nonempty order seed are required")
    try:
        text_tariffs.validate_organization_id(spec["kilo_organization_id"])
    except ValueError as error:
        raise ValueError("Freeze the canonical Kilo organization UUID that gateway requests bill") from error
    if spec["gateway_routing_table_version"] is not None and (not isinstance(spec["gateway_routing_table_version"], str) or not spec["gateway_routing_table_version"]):
        raise ValueError("Gateway routing table version must be a nonempty string or null when none is published")
    for key in ("campaign_ledger", "execution_manifest"):
        if not isinstance(spec[key], str) or not Path(spec[key]).is_absolute() or not Path(spec[key]).exists():
            raise ValueError(f"{key} must be an existing absolute path")
    configs = spec["configurations"]
    if not isinstance(configs, list) or len(configs) != 2 or any(not isinstance(item, dict) or set(item) != {"id", "snapshot", "router"} or item["router"] not in {"efficient", "frontier"} or not isinstance(item["id"], str) or not SAFE.fullmatch(item["id"]) or item["id"] == "baseline" for item in configs) or len({item["id"] for item in configs}) != 2 or {item["router"] for item in configs} != {"efficient", "frontier"}:
        raise ValueError("Require exactly one distinct candidate configuration per mode")
    tasks = spec["tasks"]
    if not isinstance(tasks, dict) or set(tasks) != {"tuning", "final"} or any(not isinstance(ids, list) or not ids or len(ids) != len(set(ids)) for ids in tasks.values()) or set(tasks["tuning"]) & set(tasks["final"]):
        raise ValueError("Tuning and final task sets must be nonempty, distinct and disjoint")
    resources, base = spec["resources"], modules["census"].RESOURCES
    if not isinstance(resources, dict) or set(resources) != set(base) | {"max_input_tokens", "http_request_timeout_seconds", "token_overrun_policy", "run_cost_limit_usd"} or any(resources[key] != value for key, value in base.items() if key != "run_cost_limit_usd"):
        raise ValueError("Use the pinned census solver resources with the approved per-run money cap")
    if type(resources["max_input_tokens"]) is not int or resources["max_input_tokens"] <= 0 or resources["http_request_timeout_seconds"] != 600 or resources["token_overrun_policy"] != "settle-known-v1":
        raise ValueError("Invalid frozen solver input, timeout or settlement contract")
    if not isinstance(spec["pilot_cap_usd"], str) or money(spec["pilot_cap_usd"]) <= 0 or money(spec["pilot_cap_usd"]) > PILOT_CAP_USD:
        raise ValueError("Pilot cap must be a positive frozen amount within the independent pilot ceiling")
    if not isinstance(resources["run_cost_limit_usd"], str) or money(resources["run_cost_limit_usd"]) <= 0 or money(resources["run_cost_limit_usd"]) > RUN_CAP_USD:
        raise ValueError("Frozen per-run resource cap must stay within the per-run ceiling")
    if len(tasks["tuning"]) != 18 or len(tasks["final"]) != 32:
        raise ValueError("Retain all 18 tuning and 32 final tasks; do not shrink the panel")
    if not isinstance(spec["classifier_allowance_usd"], str) or money(spec["classifier_allowance_usd"]) <= 0:
        raise ValueError("Classifier allowance must be a frozen positive amount added to every router-arm reservation and settlement")
    _validate_arms_spec(spec)
    with CAMPAIGN.readonly(spec["campaign_ledger"]) as db:
        CAMPAIGN.metadata(db)
        if CAMPAIGN.effective_authorization(db, spec["prospective_grant_id"]) is None:
            raise ValueError("Prospective authorization is missing")
    return spec


def router_panel(modules):
    spec = importlib.util.spec_from_file_location("router_panel", Path(__file__).with_name("router-panel.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    driver = SimpleNamespace(census=modules["census_panel"], modern=modules["modern_panel"], study=modules["study"])
    return module, driver


def panel_inputs(panel_out, kind, modules, spec):
    if kind != "router":
        raise ValueError("Version6 requires the preregistered router panel and exact frozen split")
    module, panel_driver = router_panel(modules)
    panel_spec = module.frozen_spec(panel_out)
    panel, private = module.check_panel(panel_driver, panel_out, panel_spec)
    evidence_of = lambda task: module.task_evidence(panel_driver, panel_out, panel_spec, task)
    split_path = Path(panel_out) / "split.json"
    split = load(split_path)
    expected_split = module.split_tasks(panel_driver, module.read_spec(panel_spec), panel["tasks"])
    expected_record = {"schema": "router-quality-cost-split-v1", "panel_sha256": modules["study"].digest(panel), "spec_sha256": file_hash(panel_spec), "outcomes_used": False, **expected_split}
    if split != expected_record or spec["tasks"] != expected_split:
        raise ValueError("Tasks and their order must exactly equal the preregistered split; subsets and switches are forbidden")
    by_id = {task["instance_id"]: task for task in private}
    selected = spec["tasks"]["tuning"] + spec["tasks"]["final"]
    if set(selected) != set(by_id) or len(selected) != len(private):
        raise ValueError("The full frozen panel must be covered exactly once per split")
    evidence = {task_id: evidence_of(by_id[task_id]) for task_id in selected}
    provenance = [panel_spec, Path(panel_out) / "authorizations" / "preregistration.json", Path(panel_out) / "authorizations" / "panel-amendment.json"]
    provenance += [Path(panel_out) / "router-provenance" / f"{name}.json" for name in module.HISTORICAL]
    return {"panel_kind": kind, "panel_sha256": digest(panel), "split_file_sha256": file_hash(split_path), "split": split, "preregistration_and_exclusions_sha256": {str(path.relative_to(panel_out)): file_hash(path) for path in provenance}, "task_evidence_sha256": digest(evidence), "private_tasks_sha256": file_hash(Path(panel_out) / "evaluator" / "tasks.json")}, by_id


def make_plan(spec, tasks):
    arms = arm_definitions(spec)
    rows = []
    phases = (("pilot", [spec["tasks"]["tuning"][0]], 1), ("final", sorted(spec["tasks"]["final"], key=lambda task: digest([spec["seed"], "final", task])), spec["repetitions"]))
    for phase, ordered, repetitions in phases:
        for task_id in ordered:
            for repetition in range(repetitions):
                for router in MODES:
                    # Router-only pilot stays two runs and precedes final work.
                    selected = [arms[router][0]] if phase == "pilot" else list(arms[router])
                    selected.sort(key=lambda arm: digest([spec["seed"], phase, repetition, task_id, router, arm["arm_id"]]))
                    for arm in selected:
                        model, variant = arm["model"], arm["variant"]
                        if arm["arm_kind"] == "control":
                            model, variant = control_choice(spec, router, task_id, repetition)
                        run = f"rs-{phase}-{router}-{digest([spec['experiment_id'], phase, task_id, router, arm['arm_id'], repetition])}"
                        rows.append({"run": run, "instance_id": task_id, "repo": tasks[task_id]["repo"], "phase": phase, "router": router, "arm_id": arm["arm_id"], "arm_kind": arm["arm_kind"], "configuration": arm["configuration"], "candidate": f"{router}-{arm['arm_id']}", "repetition": repetition, "version": arm["version"], "model": model, "variant": variant})
    if len({row["run"] for row in rows}) != len(rows) or any(re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", row["run"]) is None for row in rows):
        raise ValueError("Unsafe or duplicate run identity")
    # Distinct physical observation per logical arm/task/repetition (no sharing).
    expected = 2 + len(spec["tasks"]["final"]) * spec["repetitions"] * sum(len(arms[mode]) for mode in MODES)
    if len(rows) != expected:
        raise ValueError("Derived plan does not cover every mandatory arm, task and repetition")
    return {"experiment_id": spec["experiment_id"], "seed": spec["seed"], "repetitions": spec["repetitions"], "order": "phase, seeded task, repetition and paired shuffled arm order", "arms": arms, "sharing": "none; one physical observation per logical arm/task/repetition", "expected_runs": expected, "runs": rows}


def catalog_coverage(catalog, pairs):
    if not isinstance(catalog, dict) or any(not isinstance(variants, dict) for variants in catalog.values()):
        raise ValueError("Variant catalog must map model to its exact catalog variants")
    for model, label in pairs:
        resolve_variant(catalog, model, label)


def freeze_inputs(panel_out, kind, directory, spec, modules):
    validate_spec(spec, modules)
    bindings, tasks = panel_inputs(panel_out, kind, modules, spec)
    raw = {item["id"]: Path(item["snapshot"]).read_bytes() for item in spec["configurations"]}
    snapshots = {key: json.loads(value) for key, value in raw.items()}
    baseline = next(iter(snapshots.values()))["baseline"]
    pairs = set()
    pools = {}
    for item in spec["configurations"]:
        snapshot = snapshots[item["id"]]
        pairs.update(snapshot_contract(snapshot))
        if snapshot["baseline"] != baseline:
            raise ValueError("Every candidate snapshot must carry exactly the same real baseline")
        pools[item["router"]] = sorted(mode_pairs(snapshot, item["router"]))
    for mode in MODES:
        pool_models = {model for model, _ in pools[mode]}
        fixed_models = {entry["model"] for entry in spec["fixed_models"][mode]}
        if fixed_models != pool_models:
            raise ValueError(f"Fixed models must exactly cover every model in the {mode} frozen baseline/candidate pool")
        for entry in spec["fixed_models"][mode]:
            if (entry["model"], entry["variant"]) not in set(pools[mode]):
                raise ValueError("Each fixed model variant policy must name a variant supported in the frozen tables")
    catalog = load(spec["variant_catalog"])
    catalog_coverage(catalog, pairs)
    plan = make_plan(spec, tasks)
    execution = helper("router-proof").execution_identity(spec["execution_manifest"])
    fingerprints = {mode: router_fingerprint(mode, pools[mode]) for mode in MODES}
    with CAMPAIGN.readonly(spec["campaign_ledger"]) as db:
        campaign = CAMPAIGN.metadata(db)
        authorization = CAMPAIGN.effective_authorization(db, spec["prospective_grant_id"])
    approval = {"authorized": True, "action": "freeze-router-study-v6", "prospective_grant_id": spec["prospective_grant_id"], "prospective_grant_approval_sha256": authorization["approval_sha256"], "effective_authorization": CAMPAIGN.authorization_summary(authorization), "spec_sha256": digest(spec), "source_sha256": sources(directory), "snapshot_file_sha256": {key: hashlib.sha256(value).hexdigest() for key, value in raw.items()}, "router_fingerprints": fingerprints, "variant_catalog_sha256": file_hash(spec["variant_catalog"]), "gateway_models": GATEWAY_MODELS, "classifier_model": classifier_model(next(iter(snapshots.values()))), "model_variants": [list(pair) for pair in sorted(pairs)], "mode_pools": {mode: [list(pair) for pair in pools[mode]] for mode in MODES}, "arms": plan["arms"], "execution_plan_sha256": digest(plan), "execution_identity": execution, "campaign_metadata": campaign, **bindings}
    return approval, plan




def freeze(out, panel_out, kind, directory, spec, approval, modules):
    required, plan = freeze_inputs(panel_out, kind, directory, spec, modules)
    if approval != required:
        raise ValueError("Parent freeze approval must equal freeze-inputs exactly")
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    for task_id in spec["tasks"]["tuning"] + spec["tasks"]["final"]:
        frozen_copy(panel_out / "images" / f"{task_id}.json", out / "images" / f"{task_id}.json")
    for item in spec["configurations"]:
        frozen_copy(item["snapshot"], out / "snapshots" / f"{item['id']}.json")
    frozen_copy(spec["variant_catalog"], out / "variant-catalog.json")
    frozen_copy(panel_out / "split.json", out / "split.json")
    manifest = {"version": SPEC_VERSION, "spec": spec, "approval": approval, "approval_sha256": digest(approval), "panel_kind": kind, "panel_root": str(panel_out), "driver_root": str(directory), "out_root": str(out)}
    with sqlite3.connect(spec["campaign_ledger"], timeout=60) as db:
        db.execute("BEGIN IMMEDIATE")
        CAMPAIGN.register_manifest(db, manifest)
        frozen_write(out / "execution-plan.json", plan)
        frozen_write(out / MANIFEST, manifest)
        (out / "budget.sqlite").symlink_to(Path(spec["campaign_ledger"]).resolve(strict=True))
    return {"manifest_sha256": digest(manifest), "runs": len(plan["runs"]), "ledger": spec["campaign_ledger"]}


def validate(out, panel_out, directory, modules):
    manifest = load(out / MANIFEST)
    if manifest.get("version") != SPEC_VERSION:
        raise ValueError("Historical manifests lack execution/split/campaign evidence and are audit-only")
    if [manifest.get(key) for key in ("out_root", "panel_root", "driver_root")] != [str(out), str(panel_out), str(directory)]:
        raise ValueError("Frozen root binding changed")
    spec, approval = validate_spec(manifest["spec"], modules), manifest["approval"]
    bindings, tasks = panel_inputs(panel_out, manifest["panel_kind"], modules, spec)
    if manifest["approval_sha256"] != digest(approval) or sources(directory) != approval["source_sha256"] or digest(spec) != approval["spec_sha256"] or any(approval.get(key) != value for key, value in bindings.items()):
        raise ValueError("Frozen source, spec, tasks or readiness evidence changed")
    plan = make_plan(spec, tasks)
    if load(out / "execution-plan.json") != plan or digest(plan) != approval["execution_plan_sha256"]:
        raise ValueError("Frozen execution plan changed")
    if {item["id"]: file_hash(out / "snapshots" / f"{item['id']}.json") for item in spec["configurations"]} != approval["snapshot_file_sha256"] or file_hash(out / "variant-catalog.json") != approval["variant_catalog_sha256"]:
        raise ValueError("Frozen pool snapshot or variant catalog changed")
    for task_id in spec["tasks"]["tuning"] + spec["tasks"]["final"]:
        if file_hash(out / "images" / f"{task_id}.json") != file_hash(panel_out / "images" / f"{task_id}.json"):
            raise ValueError("Pinned rollout image record changed")
    if helper("router-proof").execution_identity(spec["execution_manifest"]) != approval["execution_identity"] or file_hash(out / "split.json") != approval["split_file_sha256"]:
        raise ValueError("Prepared executable or frozen split bytes changed")
    with CAMPAIGN.readonly(campaign_path(out)) as db:
        if CAMPAIGN.metadata(db) != approval["campaign_metadata"] or db.execute("SELECT manifest_json FROM campaign_manifests WHERE sha256=?", (digest(manifest),)).fetchone() != (json.dumps(manifest, sort_keys=True),):
            raise ValueError("Global campaign ledger or manifest registration changed")
        authorization = CAMPAIGN.effective_authorization(db, spec["prospective_grant_id"])
        frozen = approval["effective_authorization"]
        if authorization["approval_sha256"] != approval["prospective_grant_approval_sha256"] or authorization["origin_snapshot_sha256"] != frozen["origin_snapshot_sha256"] or money(authorization["cumulative_additional_cap_usd"]) < money(frozen["cumulative_additional_cap_usd"]):
            raise ValueError("Prospective authorization or origin snapshot binding changed")
    return manifest, plan, tasks


def solver_cfg(manifest, modules):
    cfg = {**modules["study"].config(), **manifest["spec"]["resources"]}
    cfg["variant_catalog"] = load(Path(manifest["out_root"]) / "variant-catalog.json")
    cfg["kilo_organization_id"] = manifest["spec"]["kilo_organization_id"]
    cfg["classifier_allowance_usd"] = manifest["spec"]["classifier_allowance_usd"]
    cfg["gateway_routing_table_version"] = manifest["spec"]["gateway_routing_table_version"]
    return cfg


def quote_cfg(manifest, modules, candidate):
    return {**solver_cfg(manifest, modules), "candidate": {"model": candidate["model"], "effort": candidate["effort"]}}


def pricing_coverage(pricing, unavailable, expected):
    if not isinstance(unavailable, list):
        raise ValueError("Unavailable model variants must be a frozen list")
    missing = []
    for row in unavailable:
        if not isinstance(row, dict) or set(row) != {"model", "effort", "reason", "at"} or row["reason"] != MODEL_UNAVAILABLE or isinstance(row["at"], bool) or not isinstance(row["at"], (int, float)) or not math.isfinite(row["at"]):
            raise ValueError("Invalid model-availability evidence record")
        missing.append((row["model"], row["effort"]))
    quoted = [(row["model"], row["effort"]) for row in pricing["models"]]
    expected = {tuple(pair) for pair in expected}
    if len(missing) != len(set(missing)) or len(quoted) != len(set(quoted)) or set(missing) & set(quoted) or set(missing) | set(quoted) != expected:
        raise ValueError("Pricing must cover precisely frozen reachable variants minus recorded-unavailable variants")
    return set(missing)


def _copy_endpoint_snapshots(pair_directory, folder):
    for snapshot in (pair_directory / "pricing-endpoints").glob("*.json"):
        destination = folder / "pricing-endpoints" / snapshot.name
        if destination.exists():
            if load(destination)["body"] != load(snapshot)["body"]:
                raise ValueError("Conflicting immutable endpoint snapshots")
        else:
            frozen_copy(snapshot, destination)


def quote(out, panel_out, directory, modules, batch):
    manifest, _, _ = validate(out, panel_out, directory, modules)
    if not SAFE.fullmatch(batch):
        raise ValueError("Unsafe batch identity")
    folder = out / "quotes" / batch
    folder.mkdir(parents=True, exist_ok=False)
    candidates = [{"label": f"pair-{index:03d}", "model": model, "effort": label} for index, (model, label) in enumerate(manifest["approval"]["model_variants"])]
    unavailable, models, quote_times = [], [], []
    for candidate in candidates:
        pair_directory = folder / "pairs" / candidate["label"]
        pair_directory.mkdir(parents=True)
        try:
            modules["study"].catalog(pair_directory, cfg={**solver_cfg(manifest, modules), "candidates": [candidate]})
        except RuntimeError as error:
            if str(error) != MODEL_UNAVAILABLE:
                raise
            at = time.time()
            unavailable.append({"model": candidate["model"], "effort": candidate["effort"], "reason": MODEL_UNAVAILABLE, "at": at})
            quote_times.append(at)
        else:
            pair_pricing = load(pair_directory / "pricing.json")
            models.extend(pair_pricing["models"])
            quote_times.append(pair_pricing["fetched_at"])
        snapshot = pair_directory / "catalog-snapshot.json"
        if snapshot.is_file():
            frozen_copy(snapshot, folder / "catalog-snapshots" / f"{candidate['label']}.json")
        _copy_endpoint_snapshots(pair_directory, folder)
    frozen_write(folder / "unavailable-pairs.json", unavailable)
    frozen_write(folder / "pricing.json", {"source": modules["study"].KILO_CATALOG_URL, "fetched_at": min(quote_times), "financial_quote_policy": modules["study"].FINANCIAL_QUOTE_POLICY, "models": models, "unavailable_pairs": unavailable})
    classifier_directory = folder / "classifier"
    classifier_directory.mkdir(parents=True)
    classifier_candidate = modules["study"].classifier_quote(classifier_directory, manifest["approval"]["classifier_model"])
    _copy_endpoint_snapshots(classifier_directory, folder)
    frozen_write(folder / "classifier-quote.json", classifier_candidate)
    pricing = read_quote(out, batch, manifest, modules)
    return {"batch": batch, "pricing_sha256": digest(pricing), "unavailable_pairs_sha256": digest(pricing["unavailable_pairs"]), "classifier_quote_sha256": digest(classifier_candidate), "classifier_allowance_usd": manifest["spec"]["classifier_allowance_usd"], "classifier_allowance_bound_usd": str(text_tariffs.classifier_allowance_bound(classifier_candidate["financial_quote"])), "manifest_sha256": digest(manifest)}


def read_quote(out, batch, manifest, modules):
    if not SAFE.fullmatch(batch):
        raise ValueError("Unsafe batch identity")
    folder = out / "quotes" / batch
    pricing = load(folder / "pricing.json")
    now = time.time()
    if not 0 <= now - pricing["fetched_at"] <= PRICING_MAX_AGE_SECONDS:
        raise ValueError("Pricing expired or future-dated; quote again and obtain a new approval")
    unavailable = load(folder / "unavailable-pairs.json")
    pricing_coverage(pricing, unavailable, manifest["approval"]["model_variants"])
    if pricing.get("unavailable_pairs") != unavailable:
        raise ValueError("Pricing and frozen unavailable-list binding differ")

    def pair_snapshot(model, effort):
        pair_index = manifest["approval"]["model_variants"].index([model, effort])
        return load(folder / "catalog-snapshots" / f"pair-{pair_index:03d}.json")

    def endpoints_for(financial):
        snapshot = load(folder / "pricing-endpoints" / f"{financial['endpoint_snapshot_sha256']}.json")
        if digest(snapshot["body"]) != financial["endpoint_snapshot_sha256"]:
            raise ValueError("Endpoint price evidence changed")
        return snapshot["body"]["data"]["endpoints"]

    for row in unavailable:
        if not 0 <= now - row["at"] <= PRICING_MAX_AGE_SECONDS:
            raise ValueError("Unavailable model evidence is expired or future-dated")
        snapshot = pair_snapshot(row["model"], row["effort"])
        entry = snapshot["entries"].get(row["model"])
        if entry is None:
            continue
        try:
            modules["study"].catalog_quote(entry, quote_cfg(manifest, modules, {"model": row["model"], "effort": row["effort"]}))
        except RuntimeError as error:
            if str(error) != MODEL_UNAVAILABLE:
                raise
        else:
            raise ValueError("Recorded-unavailable model now reproduces an available catalog quote")
    for candidate in pricing["models"]:
        financial = candidate["financial_quote"]
        snapshot = pair_snapshot(candidate["model"], candidate["effort"])
        if digest(snapshot) != financial["catalog_snapshot_sha256"]:
            raise ValueError("Solver catalog evidence changed")
        entry = snapshot["entries"].get(candidate["model"])
        if entry is None:
            raise ValueError("Solver catalog entry is absent from its snapshot")
        expected = modules["study"].catalog_quote(entry, quote_cfg(manifest, modules, candidate), endpoints=endpoints_for(financial))
        if any(financial.get(key) != value for key, value in expected.items()):
            raise ValueError("Solver financial quote no longer reproduces from its catalog and endpoint evidence")
        modules["study"].financial_prices(candidate)
        financial_attempt_bound(candidate, solver_cfg(manifest, modules))
    classifier = load(folder / "classifier-quote.json")
    if classifier.get("model") != manifest["approval"].get("classifier_model"):
        raise ValueError("Classifier quote belongs to another classifier model")
    if not isinstance(classifier.get("quote_fetched_at"), (int, float)) or not 0 <= now - classifier["quote_fetched_at"] <= PRICING_MAX_AGE_SECONDS:
        raise ValueError("Classifier quote expired or future-dated; quote again and obtain a new approval")
    financial = classifier["financial_quote"]
    expected = text_tariffs.classifier_endpoint_quote(classifier["model"], endpoints_for(financial))
    if any(financial.get(key) != value for key, value in expected.items()):
        raise ValueError("Classifier financial quote no longer reproduces from its endpoint evidence")
    bound = text_tariffs.classifier_allowance_bound(financial)
    if money(manifest["spec"]["classifier_allowance_usd"]) < bound:
        raise ValueError(f"Classifier allowance is below the computed dearest-price bound {bound} for every classifier attempt of one request; raise the frozen allowance")
    return pricing


def financial_attempt_bound(candidate, cfg):
    quote = text_tariffs.validate_quote(candidate)
    return money(quote["attempt_bound_usd"]), "complete Kilo catalog component envelope at frozen quantities, plus any frozen classifier allowance in the quote"


def gateway_router_candidate(pricing, pool, mode, cfg):
    """Worst-case kilo-auto candidate over the complete mode pool, plus allowance.

    Returns None unless every pool pair is quoted: a router arm with an
    unquotable pool model is not admissible. The candidate carries the
    smallest pool context so the solver input cap stays conservative, and
    the frozen pool model set for the routed-model check.
    """
    by_pair = {(item["model"], item["effort"]): item for item in pricing["models"]}
    if not pool or any(tuple(pair) not in by_pair for pair in pool):
        return None
    quoted = [by_pair[tuple(pair)] for pair in pool]
    quote = text_tariffs.worst_case_quote([item["financial_quote"] for item in quoted], GATEWAY_MODELS[mode], "effort=", cfg, cfg.get("classifier_allowance_usd"))
    fetched = [item.get("quote_fetched_at") for item in quoted]
    return {"model": GATEWAY_MODELS[mode], "effort": "effort=", "context_length": min(item["context_length"] for item in quoted), "pool_models": sorted({model for model, _ in pool}), "financial_quote": quote, "quote_fetched_at": min(fetched) if all(isinstance(value, (int, float)) for value in fetched) else None}


def build_financing(manifest, plan, pricing, cfg):
    """Whole-plan cost forecast. Per-row envelope = min(resource cap, proved bound).

    The forecast prices every mandatory row. It guarantees no funding. Its
    total may exceed the cumulative allowance and its pilot total may exceed
    the pilot cap. Dispatch reserves each request against the nested caps.
    """
    spec = manifest["spec"]
    allowance = money(spec["classifier_allowance_usd"])
    run_cap = money(cfg["run_cost_limit_usd"])
    if run_cap <= 0 or run_cap > RUN_CAP_USD:
        raise ValueError("Cost forecast per-run resource cap must stay within the per-run ceiling")
    steps = cfg["step_limit"]
    if type(steps) is not int or steps <= 0:
        raise ValueError("Cost forecast requires a proved positive solver call-count bound")
    by_pair = {(row["model"], row["effort"]): row for row in pricing["models"]}
    unavailable = {(row["model"], row["effort"]) for row in pricing.get("unavailable_pairs", [])}
    pools = {mode: [tuple(pair) for pair in pairs] for mode, pairs in manifest["approval"]["mode_pools"].items()}
    solver_bound = {}
    for pair, candidate in by_pair.items():
        solver_bound[pair] = financial_attempt_bound(candidate, cfg)[0]
    router_bound = {}
    for mode in MODES:
        candidate = gateway_router_candidate(pricing, pools[mode], mode, cfg)
        if candidate is not None:
            router_bound[mode] = financial_attempt_bound(candidate, cfg)[0]
    rows = []
    for row in plan["runs"]:
        if row["arm_kind"] == "router":
            if row["router"] not in router_bound:
                raise ValueError("Router arm requires a valid quote for every pool pair of its mode; an unquoted pool pair blocks admission")
            proved = steps * router_bound[row["router"]]
            basis = {"solver_calls_max": steps, "gateway_model": GATEWAY_MODELS[row["router"]], "solver_attempt_bound_usd": str(router_bound[row["router"]] - allowance), "classifier_allowance_per_request_usd": str(allowance)}
        else:
            pair = (row["model"], row["variant"])
            if pair in unavailable or pair not in solver_bound:
                raise ValueError(f"Mandatory {row['arm_kind']} arm pair has no proved quote and cannot be forecast: {pair}")
            proved = steps * solver_bound[pair]
            basis = {"solver_calls_max": steps, "solver_attempt_bound_usd": str(solver_bound[pair]), "classifier_allowance_per_request_usd": "0", "model": pair[0], "variant": pair[1]}
        envelope = min(run_cap, proved)
        rows.append({"run": row["run"], "phase": row["phase"], "arm_id": row["arm_id"], "arm_kind": row["arm_kind"], "router": row["router"], "envelope_usd": str(envelope), "proved_envelope_usd": str(proved), "resource_cap_usd": str(run_cap), "basis": basis})
    pilot_total = sum((money(row["envelope_usd"]) for row in rows if row["phase"] == "pilot"), Decimal(0))
    pilot_cap = money(spec["pilot_cap_usd"])
    with CAMPAIGN.readonly(spec["campaign_ledger"]) as db:
        authorization = CAMPAIGN.effective_authorization(db, spec["prospective_grant_id"])
    return {"schema": CAMPAIGN.FINANCING_SCHEMA, "forecast_only": True, "funding_guarantee": "none; capped exploration may stop inconclusive", "manifest_sha256": digest(manifest), "execution_plan_sha256": digest(plan), "authorization": CAMPAIGN.authorization_summary(authorization), "pricing_sha256": digest(pricing), "classifier_allowance_usd": str(allowance), "gateway": {"organization_id": spec["kilo_organization_id"], "routing_table_version": spec["gateway_routing_table_version"], "models": GATEWAY_MODELS}, "resources": {key: cfg[key] for key in ("step_limit", "wall_seconds", "action_timeout_seconds", "max_output_tokens", "max_input_tokens", "run_cost_limit_usd") if key in cfg}, "call_count_bound_source": {"solver": "clean pinned mini-SWE-agent DefaultAgent.query increments n_calls before each query, including format errors", "classifier": "billed by the gateway as a separate organization usage row excluded from usage.cost; the frozen per-request allowance is added to every router-arm reservation and settlement, and read_quote rejects an allowance below the computed dearest-price bound"}, "pilot_cap_usd": str(pilot_cap), "pilot_envelope_usd": str(pilot_total), "total_envelope_usd": str(sum((money(row["envelope_usd"]) for row in rows), Decimal(0))), "rows": rows}


def financing_path(out, batch):
    return Path(out) / "financing" / f"{batch}.json"


def finance_plan(out, panel_out, directory, modules, batch):
    manifest, plan, _ = validate(out, panel_out, directory, modules)
    pricing = read_quote(out, batch, manifest, modules)
    financing = build_financing(manifest, plan, pricing, solver_cfg(manifest, modules))
    ledger = campaign_path(out)
    destination = financing_path(out, batch)
    with (ledger.parent / ".writer.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(ledger, timeout=60) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                result = CAMPAIGN.register_financing(db, financing)
                if destination.is_file():
                    if load(destination) != financing:
                        raise ValueError("Frozen cost forecast file differs from the registered forecast")
                else:
                    frozen_write(destination, financing)
                db.execute("COMMIT")
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
    return {"batch": batch, **result}


def load_financing(out, batch, manifest):
    path = financing_path(out, batch)
    if not path.is_file():
        raise ValueError("Whole-plan cost forecast must be registered before any paid dispatch; run finance first")
    financing = load(path)
    if financing.get("manifest_sha256") != digest(manifest):
        raise ValueError("Cost forecast belongs to another frozen manifest")
    with CAMPAIGN.readonly(campaign_path(out)) as db:
        if CAMPAIGN.financing_for(db, digest(financing)) != financing:
            raise ValueError("Cost forecast is not the registered hash-bound forecast")
    return financing


def accounting_tables(db):
    db.execute("CREATE TABLE IF NOT EXISTS router_accounting (request_id TEXT PRIMARY KEY,old_row_json TEXT NOT NULL,new_row_json TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,at REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS router_stop_cleared (stop_reason_rowids TEXT NOT NULL,reason TEXT NOT NULL,at REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS router_dispatches (request_id TEXT PRIMARY KEY,run TEXT NOT NULL,request_sha256 TEXT NOT NULL,created REAL NOT NULL)")
    for table in ("router_accounting", "router_stop_cleared", "router_dispatches"):
        for operation in ("UPDATE", "DELETE"):
            db.execute(f"CREATE TRIGGER IF NOT EXISTS {table}_no_{operation.lower()} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'append-only'); END")


def active_stops(db, phase=None):
    cleared = {}
    for rowids, at in db.execute("SELECT stop_reason_rowids,at FROM router_stop_cleared"):
        for rowid in json.loads(rowids):
            cleared[rowid] = max(cleared.get(rowid, float("-inf")), at)
    return [{"rowid": rowid, "reason": reason} for rowid, scope, reason, at in db.execute("SELECT rowid,phase,reason,created FROM router_stop") if (phase is None or scope is None or scope == phase) and cleared.get(rowid, float("-inf")) < at]


def accounted_row_valid(db, row):
    if row["state"] != "accounted_unknown" or money(row["bound"]) <= 0 or row["actual"] is not None and money(row["actual"]) > money(row["bound"]):
        return False
    audit = db.execute("SELECT old_row_json,new_row_json FROM router_accounting WHERE request_id=?", (row["id"],)).fetchone()
    if audit is None:
        return False
    old, new = map(json.loads, audit)
    return new == row and old["state"] == "unknown" and {**old, "state": "accounted_unknown"} == new


def receipt_generation(receipt):
    """Gateway request identity from a receipt, newest field first.

    The first present non-null field is authoritative: an invalid value
    never falls back to a different field.
    """
    for field in ("gateway_request_id", "generation_id", "provider_generation_id"):
        if field in receipt and receipt[field] is not None:
            generation = receipt[field]
            if not isinstance(generation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", generation):
                return None, field
            return generation, field
    return None, "gateway_request_id"


def account_unknown(out, request_id, evidence_path, modules):
    evidence_bytes = Path(evidence_path).read_bytes()
    evidence = json.loads(evidence_bytes)
    evidence_hash = hashlib.sha256(evidence_bytes).hexdigest()
    with ((out / "budget.sqlite").resolve(strict=True).parent / ".writer.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(out / "budget.sqlite", timeout=60) as db:
            db.execute("BEGIN IMMEDIATE")
            accounting_tables(db)
            row = next((row for row in modules["study"].request_rows(db) if row["id"] == request_id), None)
            if row is None or row["state"] != "unknown" or row["actual"] is not None:
                raise ValueError("Accounting requires an unknown request with no known actual charge")
            receipt = load(row["receipt"])
            generation, _ = receipt_generation(receipt)
            if receipt.get("dispatch_entered") is not True or generation is None or receipt.get("local_request_id") != request_id or receipt.get("run") != row["run"]:
                raise ValueError("Dispatched request receipt must identify this request, run and generation")
            if money(row["bound"]) <= 0 or money(receipt.get("reservation_usd")) != money(row["bound"]):
                raise ValueError("Accounting must retain the full unchanged original reservation")
            if not isinstance(evidence, dict) or set(evidence) != {"gateway_request_id", "http_status", "body"} or evidence["gateway_request_id"] != generation or type(evidence["http_status"]) is not int or not 100 <= evidence["http_status"] <= 599:
                raise ValueError("Evidence requires the exact gateway request id, HTTP status and body")
            claim = db.execute("SELECT state FROM router_runs WHERE run=?", (row["run"],)).fetchone()
            if claim not in {("stopped",), ("interrupted",)}:
                raise ValueError("Only a permanently aborted run can have an unknown charge accounted")
            new = {**row, "state": "accounted_unknown"}
            evidence_destination = (out / "budget.sqlite").resolve(strict=True).parent / "accounting-evidence" / f"{evidence_hash}.json"
            if evidence_destination.exists():
                if file_hash(evidence_destination) != evidence_hash:
                    raise ValueError("Stored accounting evidence differs")
            else:
                frozen_bytes(evidence_bytes, evidence_destination)
            db.execute("INSERT INTO router_accounting VALUES (?,?,?,?,?)", (request_id, json.dumps(row, sort_keys=True), json.dumps(new, sort_keys=True), evidence_hash, time.time()))
            db.execute("UPDATE requests SET state='accounted_unknown' WHERE id=? AND state='unknown' AND actual IS NULL", (request_id,))
    return {"request_id": request_id, "state": "accounted_unknown", "actual": None, "retained_bound_usd": new["bound"], "evidence_sha256": evidence_hash, "run_never_retried": row["run"]}


def clear_stop(out, reason, modules):
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("A nonempty operator reason is required")
    with ((out / "budget.sqlite").resolve(strict=True).parent / ".writer.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(out / "budget.sqlite", timeout=60) as db:
            db.execute("BEGIN IMMEDIATE")
            accounting_tables(db)
            rows = modules["study"].request_rows(db)
            if any(row["state"] != "settled" and not accounted_row_valid(db, row) and not CAMPAIGN.historical_commitment(db, row) for row in rows):
                raise ValueError("Stop clearing requires all charges settled or append-audited at their full unknown bounds")
            rowids = [row["rowid"] for row in active_stops(db)]
            db.execute("INSERT INTO router_stop_cleared VALUES (?,?,?)", (json.dumps(rowids), reason, time.time()))
    return {"cleared_stop_rowids": rowids, "reason": reason, "requests_changed": 0}


def automatic_account(db, row, receipt, out):
    generation, generation_field = receipt_generation(receipt)
    kind = db.execute("SELECT kind FROM router_requests WHERE id=?", (row["id"],)).fetchone()
    eligible_kind = kind == ("solver",)
    if row["state"] != "unknown" or receipt.get("dispatch_entered") is not True or not eligible_kind or money(row["bound"]) <= 0 or money(row["bound"]) != money(receipt.get("reservation_usd")) or row["actual"] is not None and money(row["actual"]) > money(row["bound"]):
        return False
    evidence = {"kind": "automatic-full-bound", "receipt_sha256": digest(receipt), "generation_id": generation, "generation_id_field": generation_field if generation is not None else None, "error_type": receipt.get("error_type") or getattr(sys.exc_info()[0], "__name__", None), "receipt_snapshot": receipt}
    evidence_hash = hashlib.sha256((json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode()).hexdigest()
    path = Path(out) / "accounting-evidence" / f"{evidence_hash}.json"
    if not path.exists():
        frozen_write(path, evidence)
    new = {**row, "state": "accounted_unknown"}
    db.execute("INSERT INTO router_accounting VALUES (?,?,?,?,?)", (row["id"], json.dumps(row, sort_keys=True), json.dumps(new, sort_keys=True), evidence_hash, time.time()))
    db.execute("UPDATE requests SET state='accounted_unknown' WHERE id=? AND state='unknown'", (row["id"],))
    return True


class Budget:
    def __init__(self, ledger, modules, final_reserve="0", auto_run=None, pilot_cap_usd=None, financing=None):
        self.ledger, self.modules = Path(ledger).resolve(strict=True), modules
        self.final_reserve = money(final_reserve)
        self.pilot_cap = PILOT_CAP_USD if pilot_cap_usd is None else money(pilot_cap_usd)
        self.financing = financing
        self.financing_sha = digest(financing) if financing is not None else None
        self.financing_envelopes = {row["run"]: money(row["envelope_usd"]) for row in financing["rows"]} if financing else {}
        self.auto_run = auto_run
        with self.connect() as db:
            CAMPAIGN.metadata(db)
            accounting_tables(db)
            self.authorization = CAMPAIGN.effective_authorization(db)
            self.grant = CAMPAIGN.prospective_grant(db)
            if self.grant is not None and (auto_run is not None or self.pilot_cap <= 0 or self.pilot_cap > PILOT_CAP_USD):
                raise ValueError("Prospective grant requires strict unknown-charge stops and the independent pilot cap")
            if self.grant is not None and financing is not None:
                CAMPAIGN.require_current_financing(db, self.financing_sha)

    def connect(self):
        return sqlite3.connect(self.ledger, isolation_level=None, timeout=60)

    @contextmanager
    def guard(self, ledger_out):
        with MUTEX, (self.ledger.parent / ".request-state.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                if self.auto_run is not None:
                    with self.connect() as db:
                        db.execute("BEGIN IMMEDIATE")
                        rows = self.modules["study"].request_rows(db)
                        kinds = dict(db.execute("SELECT id,kind FROM router_requests"))
                        for row in rows:
                            if row["run"] == self.auto_run and row["state"] == "unknown" and kinds.get(row["id"]) == "solver":
                                automatic_account(db, row, load(row["receipt"]), self.ledger.parent)
                        db.execute("COMMIT")

    def stop(self, reason, phase=None):
        with MUTEX, self.connect() as db:
            db.execute("INSERT INTO router_stop VALUES (?,?,?,?)", (uuid.uuid4().hex, phase, reason, time.time()))

    def stopped(self, phase):
        with self.connect() as db:
            return [row["reason"] for row in active_stops(db, phase)]

    def allowance(self, phase, db=None):
        if db is not None:
            authorization = CAMPAIGN.effective_authorization(db)
        else:
            with self.connect() as connection:
                authorization = CAMPAIGN.effective_authorization(connection)
        if authorization is not None:
            return money(authorization["effective_ceiling_usd"])
        return CAP if phase == "final" else CAP - self.final_reserve

    def pilot_committed(self, db, request_rows, pending=None):
        """Incurred pilot commitments only: settled plus held pilot requests.

        Forecast envelopes, unused active-run remainders and unattempted
        pilot rows never count. `pending` adds the next pilot reservation.
        """
        phases = dict(db.execute("SELECT run,phase FROM router_runs"))
        held = sum((CAMPAIGN.held(row) for row in request_rows if phases.get(row["run"]) == "pilot"), Decimal(0))
        if pending is not None and phases.get(pending[0]) == "pilot":
            held += money(pending[1])
        return held

    def claim(self, row, manifest, cfg):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            phase = row["phase"]
            grant = CAMPAIGN.prospective_grant(db)
            if grant is not None and manifest.get("spec", {}).get("prospective_grant_id") != grant["grant_id"]:
                raise ValueError("Run must bind the immutable prospective grant")
            if phase not in {"pilot", "final"} and grant is not None:
                raise ValueError("Prospective authorization allows only pilot and final")
            reason = CAMPAIGN.admission_block(db)
            if grant is not None:
                frozen_plan = load(Path(manifest["out_root"]) / "execution-plan.json")
                if row not in selected_rows(Path(manifest["out_root"]), manifest, frozen_plan, phase):
                    raise ValueError("Run is outside the exact grant-bound pilot/final plan")
            rows = self.modules["study"].request_rows(db)
            if reason is None and active_stops(db, phase):
                reason = "recorded_stop"
            if reason is None and any(item["state"] not in {"settled", "reserved"} and not accounted_row_valid(db, item) and not CAMPAIGN.historical_commitment(db, item) for item in rows):
                reason = "unknown_charge_stop"
            if grant is not None:
                if self.financing is None or row["run"] not in self.financing_envelopes:
                    db.execute("COMMIT")
                    return "cost_forecast_missing"
                CAMPAIGN.require_current_financing(db, self.financing_sha)
                if phase == "pilot" and self.pilot_committed(db, rows) >= self.pilot_cap:
                    db.execute("COMMIT")
                    return "pilot_cap_pre_admission"
            # A claim records the per-run cap as identity only. It reserves no
            # money. Each request reserves its own bound before dispatch.
            committed = sum((CAMPAIGN.held(item) for item in rows), Decimal(0))
            maximum = min(money(cfg["run_cost_limit_usd"]), RUN_CAP_USD) if grant is not None else money(cfg["run_cost_limit_usd"])
            if maximum <= 0:
                raise ValueError("Per-run cost cap must be positive")
            if reason is None and committed >= self.allowance(phase, db):
                reason = "global_budget_pre_admission"
            if reason is not None:
                db.execute("COMMIT")
                return reason
            manifest_hash = digest(manifest)
            if db.execute("SELECT 1 FROM campaign_manifests WHERE sha256=?", (manifest_hash,)).fetchone() is None:
                raise ValueError("Run admission requires a registered global campaign manifest")
            if row.get("arm_kind", "router") == "router":
                fingerprint = router_fingerprint(row["router"], manifest["approval"]["mode_pools"][row["router"]])
            else:
                catalog = load(Path(manifest["out_root"]) / "variant-catalog.json")
                fingerprint = digest({"router": row["router"], "arm_kind": row["arm_kind"], "model": row["model"], "variant": row["variant"], "resolved_variant": resolve_variant(catalog, row["model"], row["variant"]), "resources": manifest["spec"]["resources"]})
            attempt_key = digest([row["instance_id"], row["router"], phase, row["repetition"], fingerprint])
            if db.execute("SELECT 1 FROM campaign_admissions WHERE attempt_key=?", (attempt_key,)).fetchone():
                db.execute("COMMIT")
                return "never_retry_content_attempt"
            db.execute("INSERT INTO campaign_admissions VALUES (?,?,?,?)", (row["run"], manifest_hash, str(maximum), attempt_key))
            db.execute("INSERT INTO router_runs VALUES (?,?,'active',?)", (row["run"], phase, time.time()))
            db.execute("COMMIT")
        return None

    def limited(self, out, run, message, diagnostics):
        diagnostics = {**diagnostics, "caps": sorted(set(diagnostics.get("caps", [])) | {"recorded_stop"})}
        self.modules["study"].save(Path(out) / "resource-limits" / run / f"{uuid.uuid4().hex}.json", diagnostics)
        return self.modules["study"].BudgetLimited(message, diagnostics)

    def reserve(self, out, run, bound, token_bound, *, cfg, ledger_out, kind="solver"):
        study = self.modules["study"]
        bound = money(bound)
        with self.guard(ledger_out), self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                phase = cfg["router_phase"]
                if self.grant is not None and phase not in {"pilot", "final"}:
                    raise ValueError("Prospective requests may use only pilot or final")
                if self.financing_sha is not None:
                    CAMPAIGN.require_current_financing(db, self.financing_sha)
                if CAMPAIGN.admission_block(db):
                    raise self.limited(out, run, "Global campaign candidate admissions are stopped", {"caps": ["global_candidate_cap"]})
                if active_stops(db, phase):
                    raise self.limited(out, run, "Dispatch stopped by a recorded global or phase stop", {"caps": ["recorded_stop"]})
                if db.execute("SELECT phase,state FROM router_runs WHERE run=?", (run,)).fetchone() != (phase, "active"):
                    raise RuntimeError("A paid request requires its active, never-retried frozen run")
                rows = study.request_rows(db)
                if any(row["state"] not in {"settled", "reserved"} and not accounted_row_valid(db, row) and not CAMPAIGN.historical_commitment(db, row) for row in rows):
                    db.execute("INSERT INTO router_stop VALUES (?,?,?,?)", (uuid.uuid4().hex, None, "unknown_or_breached_charge", time.time()))
                    db.execute("COMMIT")
                    raise self.limited(out, run, "An unknown or breached charge stops all dispatch", {"caps": ["unknown_charge_stop"]})
                if any(row["run"] == run and row["state"] == "accounted_unknown" for row in rows):
                    raise self.limited(out, run, "An aborted run with an accounted unknown is never retried", {"caps": ["never_retry"]})
                held = sum((CAMPAIGN.held(row) for row in rows), Decimal(0))
                run_held = sum((CAMPAIGN.held(row) for row in rows if row["run"] == run), Decimal(0))
                tokens = sum((row["tokens"] if row["state"] == "settled" else row["token_bound"]) or 0 for row in rows if row["run"] == run)
                caps = []
                if held + bound > self.allowance(phase, db):
                    caps.append("phase_money_reservation")
                if held + bound > CAP:
                    caps.append("aggregate_money_reservation")
                if self.grant is not None:
                    if run not in self.financing_envelopes:
                        caps.append("cost_forecast_reservation")
                    if CAMPAIGN.plan_liability(db, pending=(run, bound))["total_liability_usd"] > self.allowance(phase, db):
                        caps.append("phase_money_reservation")
                    if phase == "pilot" and self.pilot_committed(db, rows, pending=(run, bound)) > self.pilot_cap:
                        caps.append("pilot_cap_reservation")
                run_cap = min(money(cfg["run_cost_limit_usd"]), RUN_CAP_USD) if self.grant is not None else money(cfg["run_cost_limit_usd"])
                if run_held + bound > run_cap:
                    caps.append("run_money_reservation")
                if tokens + token_bound > cfg["run_token_limit"]:
                    caps.append("run_token_reservation")
                if caps:
                    diagnostics = {"caps": caps, "settled_plus_held_usd": str(held), "run_settled_plus_held_usd": str(run_held), "next_money_bound_usd": str(bound), "kind": kind}
                    if {"phase_money_reservation", "aggregate_money_reservation", "cost_forecast_reservation", "pilot_cap_reservation"} & set(caps):
                        raise self.limited(out, run, "BudgetLimited: reservation exceeds a frozen global cap", diagnostics)
                    raise study.BudgetLimited("BudgetLimited: reservation exceeds a frozen run cap", diagnostics)
                request_id = uuid.uuid4().hex
                receipt = Path(out) / "receipts" / f"{request_id}.json"
                db.execute("INSERT INTO requests (id,run,bound,actual,tokens,state,receipt,token_bound) VALUES (?,?,?,NULL,NULL,'reserved',?,?)", (request_id, run, str(bound), str(receipt), token_bound))
                db.execute("INSERT INTO router_requests VALUES (?,?)", (request_id, kind))
                db.execute("COMMIT")
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
        return request_id, receipt

    @contextmanager
    def admission(self, ledger_out, run, request_id, cfg):
        with self.guard(ledger_out), self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT run,state,receipt FROM requests WHERE id=?", (request_id,)).fetchone()
            stopped = active_stops(db, cfg["router_phase"])
            unknown = any(item["state"] not in {"settled", "reserved"} and not accounted_row_valid(db, item) and not CAMPAIGN.historical_commitment(db, item) for item in self.modules["study"].request_rows(db))
            active = db.execute("SELECT state FROM router_runs WHERE run=?", (run,)).fetchone()
            if self.financing_sha is not None:
                CAMPAIGN.require_current_financing(db, self.financing_sha)
            if row is None or row[:2] != (run, "reserved") or active != ("active",) or stopped or unknown or CAMPAIGN.admission_block(db) or db.execute("SELECT 1 FROM router_dispatches WHERE request_id=?", (request_id,)).fetchone() is not None:
                db.execute("COMMIT")
                raise self.limited(ledger_out, run, "Final dispatch admission denied", {"caps": ["dispatch_stop"]})
            receipt = self.modules["study"].load(row[2])
            if receipt.get("dispatch_entered") is not False or not isinstance(receipt.get("request_sha256"), str):
                db.execute("COMMIT")
                raise self.limited(ledger_out, run, "Receipt is not an unused reserved dispatch", {"caps": ["dispatch_stop"]})
            db.execute("INSERT INTO router_dispatches VALUES (?,?,?,?)", (request_id, run, receipt["request_sha256"], time.time()))
            db.execute("COMMIT")
        yield

    def settle(self, request_id, state, bound, actual, tokens, *, auto_account=False, receipt=None):
        with self.guard(self.ledger.parent), self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("UPDATE requests SET state=?,bound=?,actual=?,tokens=? WHERE id=? AND state='reserved'", (state, str(bound), None if actual is None else str(actual), tokens, request_id)).rowcount
            if changed != 1:
                raise RuntimeError("Reservation changed before settlement")
            accounted = False
            if auto_account and state == "unknown":
                row = next(row for row in self.modules["study"].request_rows(db) if row["id"] == request_id)
                accounted = automatic_account(db, row, receipt, self.ledger.parent)
            db.execute("COMMIT")
        if state != "settled" and not accounted:
            self.stop(f"{state}_charge:{request_id}")

    def recover_reservations(self, db, run=None):
        rows = db.execute("SELECT id,receipt FROM requests WHERE state='reserved' AND (? IS NULL OR run=?)", (run, run)).fetchall()
        unknown = []
        for request_id, receipt_path in rows:
            admitted = db.execute("SELECT 1 FROM router_dispatches WHERE request_id=?", (request_id,)).fetchone() is not None
            registered = db.execute("SELECT 1 FROM router_requests WHERE id=?", (request_id,)).fetchone() is not None
            try:
                receipt = load(receipt_path) if Path(receipt_path).is_file() else {}
            except (OSError, ValueError):
                receipt = {}
            if not isinstance(receipt, dict):
                receipt = {}
            if registered and not admitted and receipt.get("dispatch_entered", False) is False:
                db.execute("UPDATE requests SET state='settled',bound='0',actual='0',tokens=0 WHERE id=? AND state='reserved'", (request_id,))
            else:
                db.execute("UPDATE requests SET state='unknown' WHERE id=? AND state='reserved'", (request_id,))
                unknown.append(request_id)
        return unknown

    def orphan_stop(self):
        with MUTEX, self.connect() as db:
            orphans = self.recover_reservations(db)
            interrupted = db.execute("UPDATE router_runs SET state='interrupted' WHERE state='active'").rowcount
        if orphans:
            self.stop("orphaned_reservations:" + ",".join(orphans))
        return {"orphaned_requests": orphans, "interrupted_runs": interrupted}


def driver_resource_summary(study, out, ledger_out, run, cfg, result, *, wall_exhausted=False):
    with sqlite3.connect(Path(ledger_out) / "budget.sqlite") as db:
        rows = [row for row in study.request_rows(db) if row["run"] == run]
    receipts = [study.load(row["receipt"]) for row in rows]
    usage = []
    for receipt in receipts:
        response = receipt.get("response")
        value = response.get("usage") if isinstance(response, dict) else None
        usage.append(value if isinstance(value, dict) else {})
    native_prompt = [value.get("prompt_tokens") for value in usage]
    native_completion = [value.get("completion_tokens") for value in usage]
    events = [study.load(path) for path in sorted((Path(out) / "resource-limits" / run).glob("*.json"))]
    caps = {cap for event in events for cap in event.get("caps", [])}
    if result.get("exit_status") == "LimitsExceeded":
        caps.add("agent_step_limit")
    if wall_exhausted or result.get("exit_status") == "TimeExceeded" or "WallTimeLimited" in str(result):
        caps.add("wall_timeout")
    if "ActionTimeLimited" in str(result):
        caps.add("action_timeout")
    if any(row["state"] == "breach" for row in rows):
        caps.add("provider_money_or_token_bound_breach")
    return {
        "configured": {key: cfg[key] for key in ("step_limit", "max_input_tokens", "max_output_tokens", "run_token_limit", "wall_seconds", "run_cost_limit_usd")},
        "action_timeout_seconds": cfg.get("action_timeout_seconds", 60),
        "http_request_timeout_seconds": study.http_request_timeout(cfg),
        "caps_fired": sorted(caps),
        "request_ids": [row["id"] for row in rows],
        "request_count": len(rows),
        "input_token_bounds": [receipt["input_token_bound"] for receipt in receipts],
        "native_prompt_tokens": native_prompt,
        "native_completion_tokens": native_completion,
        "request_money_bounds_usd": [receipt["reservation_usd"] for receipt in receipts],
        "native_cost_usd": [value.get("cost") for value in usage],
        "requested_models": [receipt.get("requested_model") or (receipt.get("request") or {}).get("model") for receipt in receipts],
        "routed_models": [receipt.get("routed_model") for receipt in receipts],
        "missing_native_usage_requests": sum(prompt is None or completion is None for prompt, completion in zip(native_prompt, native_completion)),
        "settled_plus_held_usd": str(sum((study.held_cost(row) for row in rows), Decimal(0))),
        "settled_plus_held_tokens": sum((row["tokens"] if row["state"] == "settled" else row["token_bound"]) or 0 for row in rows),
        "token_estimate_overruns": sum(receipt.get("token_estimate_overrun") is True for receipt in receipts),
        "limit_events": events,
    }


@contextmanager
def driver_adapters(modules):
    study, panel = modules["study"], modules["modern_panel"]
    original_evaluate, original_summary = panel.evaluate, study.resource_summary

    def canonical_evaluate(*args, **kwargs):
        return json.loads(json.dumps(original_evaluate(*args, **kwargs)))

    def resource_summary(out, ledger_out, run, cfg, result, *, wall_exhausted=False):
        return driver_resource_summary(study, out, ledger_out, run, cfg, result, wall_exhausted=wall_exhausted)

    panel.evaluate, study.resource_summary = canonical_evaluate, resource_summary
    try:
        yield
    finally:
        panel.evaluate, study.resource_summary = original_evaluate, original_summary


def dispatch_provider_outage(out, run, pair):
    ledger = Path(out) / "budget.sqlite"
    if not ledger.is_file():
        return None
    with sqlite3.connect(ledger) as db:
        paths = [row[0] for row in db.execute("SELECT receipt FROM requests JOIN router_requests USING(id) WHERE run=? AND kind='solver'", (run,))]
    receipts = [load(path) for path in paths if Path(path).is_file()]
    receipts = [receipt for receipt in receipts if (receipt.get("request") or {}).get("model") == pair[0] and receipt.get("router_variant") == pair[1]]
    if not receipts:
        return None
    receipt = max(receipts, key=lambda value: value.get("started_at", 0))
    if receipt.get("dispatch_entered") is not True or receipt.get("http_status") != 404:
        return None
    response = receipt.get("response")
    response = response if isinstance(response, dict) else {}
    error = response.get("error")
    message = error.get("message", "") if isinstance(error, dict) else str(error or response.get("message") or "")
    has_content = any(bool((choice.get("message") or {}).get("content") or (choice.get("message") or {}).get("tool_calls") or choice.get("text")) for choice in response.get("choices") or [] if isinstance(choice, dict) and isinstance(choice.get("message") or {}, dict))
    if has_content and not re.search(r"no endpoints? found|no routable endpoints?|no allowed providers|does not exist|model.{0,40}not found", str(message), re.IGNORECASE):
        return None
    return {"model": pair[0], "effort": pair[1], "http_status": 404, "reason": f"HTTP404 gateway provider unavailable for model={pair[0]}, variant={pair[1]} before routable content: {message}"}


class RoutedModel:
    """Router arm: one live kilo-auto gateway model per mode. No local router."""

    def __init__(self, out, run, row, deadline, cfg, budget, pricing, modules, pool):
        self.out, self.run, self.row, self.deadline, self.cfg = Path(out), run, row, deadline, cfg
        self.budget, self.modules = budget, modules
        self.pricing = pricing
        self.pool = [tuple(pair) for pair in pool]
        self.pair = (GATEWAY_MODELS[row["router"]], "effort=")
        self.model = None
        self.formatter = modules["study"].paid_model(out, run, {"model": self.pair[0]}, deadline, cfg=cfg, ledger_out=out)

    def __getattr__(self, name):
        return getattr(self.formatter, name)

    def query(self, messages, **kwargs):
        if self.deadline - time.monotonic() <= 0:
            raise TimeoutError("WallTimeLimited before gateway router dispatch")
        if self.budget.stopped(self.cfg["router_phase"]):
            raise self.budget.limited(self.out, self.run, "Global stop before gateway router dispatch", {"caps": ["recorded_stop"]})
        if self.model is None:
            candidate = gateway_router_candidate(self.pricing, self.pool, self.row["router"], self.cfg)
            if candidate is None:
                raise RuntimeError(f"Router arm requires a valid quote for every pool pair of its mode; {self.pair[0]} is not admissible")
            self.model = self.modules["study"].paid_model(self.out, self.run, candidate, self.deadline, cfg=self.cfg, ledger_out=self.out, input_bounder=self.modules["census"].NativeInputBound(), reservation=self.budget.reserve, transport_admission=self.budget.admission, state_guard=self.budget.guard)
        try:
            return self.model.query(messages, **kwargs)
        except Exception as error:
            outage = dispatch_provider_outage(self.out, self.run, self.pair)
            if outage is None:
                raise
            self.modules["study"].save(self.out / "rollouts" / self.run / "provider-unavailable.json", outage)
            raise ProviderUnavailable(outage["reason"]) from error


class FixedModel:
    """Fixed/control arm: paid solver factory only. No router, no classifier."""

    def __init__(self, out, run, row, deadline, cfg, budget, pricing, modules):
        self.out, self.run, self.row, self.deadline, self.cfg = Path(out), run, row, deadline, cfg
        self.budget, self.modules = budget, modules
        self.pricing = {(item["model"], item["effort"]): item for item in pricing["models"]}
        self.unavailable = {(item["model"], item["effort"]) for item in pricing.get("unavailable_pairs", [])}
        self.pair = (row["model"], row["variant"])
        self.model = None
        self.formatter = modules["study"].paid_model(out, run, {"model": row["model"]}, deadline, cfg=cfg, ledger_out=out)

    def __getattr__(self, name):
        return getattr(self.formatter, name)

    def query(self, messages, **kwargs):
        if self.deadline - time.monotonic() <= 0:
            raise TimeoutError("WallTimeLimited before fixed solver dispatch")
        if self.budget.stopped(self.cfg["router_phase"]):
            raise self.budget.limited(self.out, self.run, "Global stop before fixed solver dispatch", {"caps": ["recorded_stop"]})
        if self.model is None:
            candidate = self.pricing.get(self.pair)
            if candidate is None:
                if self.pair in self.unavailable:
                    reason = f"Quoted provider unavailable for model={self.pair[0]}, variant={self.pair[1]}; no solver request dispatched for this selection"
                    self.modules["study"].save(self.out / "rollouts" / self.run / "provider-unavailable.json", {"model": self.pair[0], "effort": self.pair[1], "reason": reason})
                    raise ProviderUnavailable(reason)
                raise RuntimeError(f"Frozen fixed/control pair is outside the quoted model variants: {self.pair}")
            self.model = self.modules["study"].paid_model(self.out, self.run, candidate, self.deadline, cfg=self.cfg, ledger_out=self.out, input_bounder=self.modules["census"].NativeInputBound(), reservation=self.budget.reserve, transport_admission=self.budget.admission, state_guard=self.budget.guard)
        try:
            return self.model.query(messages, **kwargs)
        except Exception as error:
            outage = dispatch_provider_outage(self.out, self.run, self.pair)
            if outage is None:
                raise
            self.modules["study"].save(self.out / "rollouts" / self.run / "provider-unavailable.json", outage)
            raise ProviderUnavailable(outage["reason"]) from error


def final_selection(out, manifest):
    path = Path(out) / "final-selection.json"
    if not path.is_file():
        raise ValueError("A successful protocol pilot is required before any final attempt")
    selection = load(path)
    expected_configs = {item["router"]: item["id"] for item in manifest["spec"]["configurations"]}
    if selection.get("manifest_sha256") != digest(manifest) or selection.get("prospective_grant_id") != manifest["spec"]["prospective_grant_id"] or selection.get("configurations") != expected_configs:
        raise ValueError("Final selection belongs to another frozen experiment or mode scope")
    evidence_path = Path(out) / "pilot-evidence.json"
    if selection.get("pilot_evidence_file_sha256") != file_hash(evidence_path) or selection.get("pilot_evidence_sha256") != digest(load(evidence_path)):
        raise ValueError("Successful pilot evidence changed")
    validate_pilot_evidence(out, manifest, load(Path(out) / "execution-plan.json"), evidence_path)
    return selection


def selected_rows(out, manifest, plan, phase):
    rows = [row for row in plan["runs"] if row["phase"] == phase]
    if phase == "final":
        # Pilot success gates final work, but no mandatory arm is filtered out.
        final_selection(out, manifest)
    return rows


def run_approval(out, manifest, plan, phase, batch, runs, pricing, concurrency=1, auto_account_unknown=False, financing=None, authorization=None):
    if phase not in {"pilot", "final"} or type(concurrency) is not int or not 1 <= concurrency <= (1 if phase == "pilot" else 2):
        raise ValueError("Pilot must be sequential; final concurrency must be at most2")
    eligible = [row["run"] for row in selected_rows(out, manifest, plan, phase)]
    if not isinstance(runs, list) or not runs or runs[0] not in eligible or runs != eligible[eligible.index(runs[0]):eligible.index(runs[0]) + len(runs)]:
        raise ValueError("Run approval must list a nonempty contiguous slice of the frozen phase order")
    execution = helper("router-proof").execution_identity(manifest["spec"]["execution_manifest"])
    if execution != manifest["approval"]["execution_identity"]:
        raise ValueError("Frozen execution identity changed before run approval")
    if financing is None:
        raise ValueError("Run approval must bind the registered whole-plan cost forecast")
    if financing.get("manifest_sha256") != digest(manifest) or financing.get("pricing_sha256") != digest(pricing) or financing.get("classifier_allowance_usd") != manifest["spec"]["classifier_allowance_usd"]:
        raise ValueError("Cost forecast must bind this exact manifest, quote batch and classifier allowance")
    authorization = authorization if authorization is not None else manifest["approval"]["effective_authorization"]
    if financing.get("authorization") != authorization:
        raise ValueError("Cost forecast and run approval must bind the same effective authorization")
    # This template grants nothing by itself: execute() re-reads the ledger,
    # the registered cost forecast and the effective authorization before dispatch.
    required = {"authorized": True, "action": "run-router-study-v6", "prospective_grant_id": manifest["spec"]["prospective_grant_id"], "prospective_grant_approval_sha256": manifest["approval"]["prospective_grant_approval_sha256"], "effective_authorization": authorization, "cost_forecast_sha256": digest(financing), "manifest_sha256": digest(manifest), "execution_plan_sha256": digest(plan), "source_sha256": manifest["approval"]["source_sha256"], "execution_identity": execution, "phase": phase, "batch": batch, "runs": runs, "pricing_sha256": digest(pricing), "kilo_organization_id": manifest["spec"]["kilo_organization_id"], "classifier_allowance_usd": manifest["spec"]["classifier_allowance_usd"], "gateway_routing_table_version": manifest["spec"]["gateway_routing_table_version"], "gateway_models": GATEWAY_MODELS, "pilot_cap_usd": manifest["spec"]["pilot_cap_usd"], "unknown_charge_policy": "stop-all-dispatch-hold-full-bound"}
    required["concurrency"] = concurrency
    required["unavailable_pairs_sha256"] = digest(pricing["unavailable_pairs"])
    if auto_account_unknown is not False:
        raise ValueError("Prospective pilot/final requires strict unknown-charge stop policy")
    if phase == "final":
        required["final_selection_sha256"] = digest(final_selection(out, manifest))
    return required


def run_state(ledger, run):
    with sqlite3.connect(ledger) as db:
        row = db.execute("SELECT state FROM router_runs WHERE run=?", (run,)).fetchone()
    return row[0] if row else None


def classify_router_result(ledger_out, run, result, timed_out, modules):
    status = modules["census"].classify(ledger_out, run, result, timed_out)
    if result.get("exit_status") == "ProviderUnavailable":
        if status == "infra_invalid":
            return "provider_unavailable"
        ledger = Path(ledger_out) / "budget.sqlite" if ledger_out is not None else None
        if status == "transport_unknown" and ledger is not None and ledger.is_file():
            with sqlite3.connect(ledger) as db:
                rows = [row for row in modules["study"].request_rows(db) if row["run"] == run]
                if rows and all(row["state"] in {"settled", "unknown"} or accounted_row_valid(db, row) for row in rows):
                    return "provider_unavailable"
    return status


def row_process(connection, out, directory, manifest, row, task, approval, cfg, batch, pricing):
    try:
        modules = driver(directory)
        budget = Budget(Path(out) / "budget.sqlite", modules, pilot_cap_usd=manifest["spec"]["pilot_cap_usd"], financing=load(financing_path(out, batch)))

        def rollout_with(factory):
            try:
                summary = modules["modern_eval"].rollout(Path(out), Path(out), task, task, {"label": row["candidate"]}, row, approval, cfg, manifest, batch, model_factory=factory, classifier=lambda ledger, run, result, timed_out: classify_router_result(ledger, run, result, timed_out, modules))
                return summary, "finished"
            except modules["modern_eval"].RunStopped as error:
                summary, state = {"run": row["run"], "status": error.status}, "stopped"
                with closing(budget.connect()) as db:
                    own = [item for item in modules["study"].request_rows(db) if item["run"] == row["run"]]
                    unresolved = any(item["state"] == "unknown" and not accounted_row_valid(db, item) for item in own)
                if error.status == "provider_unavailable" and not unresolved:
                    state = "finished"
                return summary, state

        with driver_adapters(modules):
            if row.get("arm_kind", "router") == "router":
                pool = manifest["approval"]["mode_pools"][row["router"]]

                def factory(unused_out, run, candidate, deadline, **unused):
                    return RoutedModel(Path(out), run, row, deadline, cfg, budget, pricing, modules, pool)
            else:
                def factory(unused_out, run, candidate, deadline, **unused):
                    return FixedModel(Path(out), run, row, deadline, cfg, budget, pricing, modules)

            summary, state = rollout_with(factory)
        connection.send({"kind": "result", "summary": summary, "state": state})
    except BaseException as error:
        connection.send({"kind": "result", "summary": {"run": row["run"], "status": "infra_invalid", "error_type": type(error).__name__, "error": str(error)}, "state": "stopped"})
    finally:
        connection.close()


def concurrent_row(out, directory, manifest, row, task, approval, cfg, batch, pricing, budget):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    process = context.Process(target=row_process, args=(child, out, directory, manifest, row, task, approval, cfg, batch, pricing))
    result = None
    try:
        process.start()
        child.close()
        while True:
            try:
                message = parent.recv()
            except EOFError:
                break
            if message.get("kind") == "result":
                result = message
                break
        process.join()
        if result is None or process.exitcode != 0:
            result = {"summary": {"run": row["run"], "status": "infra_invalid", "error": f"Child exited with code{process.exitcode}"}, "state": "interrupted"}
        with closing(budget.connect()) as db:
            pending = db.execute("SELECT COUNT(*) FROM requests WHERE run=? AND state='reserved'", (row["run"],)).fetchone()[0]
        if pending:
            budget.stop("outstanding_requests_after_child:" + row["run"])
        if process.exitcode != 0 or result["state"] == "interrupted":
            with closing(budget.connect()) as db:
                budget.recover_reservations(db, row["run"])
        with closing(budget.connect()) as db:
            db.execute("UPDATE router_runs SET state=? WHERE run=?", (result["state"], row["run"]))
            unknown = any(item["state"] not in {"settled", "reserved"} and not accounted_row_valid(db, item) and not CAMPAIGN.historical_commitment(db, item) for item in budget.modules["study"].request_rows(db))
        if unknown:
            budget.stop("unknown_charge_after:" + row["run"])
        return result
    finally:
        parent.close()
        child.close()


def execute(out, panel_out, directory, modules, batch, phase, approval, lease_deadline, concurrency=1, auto_account_unknown=False):
    manifest, plan, private = validate(out, panel_out, directory, modules)
    pricing = read_quote(out, batch, manifest, modules)
    financing = load_financing(out, batch, manifest)
    with CAMPAIGN.readonly(campaign_path(out)) as db:
        authorization = CAMPAIGN.authorization_summary(CAMPAIGN.effective_authorization(db, manifest["spec"]["prospective_grant_id"]))
    if approval != run_approval(out, manifest, plan, phase, batch, approval.get("runs"), pricing, concurrency, auto_account_unknown, financing=financing, authorization=authorization):
        raise ValueError("Exact parent approval for frozen phase, runs, quotes, cost forecast, authorization, gateway billing, source, concurrency and caps is required")
    try:
        modules["study"].require_gateway_credentials(solver_cfg(manifest, modules))
    except (RuntimeError, ValueError) as error:
        raise ValueError("Host-only Kilo gateway credentials are required before dispatch") from error
    if isinstance(lease_deadline, bool) or not math.isfinite(lease_deadline):
        raise ValueError("A verified finite VM deletion deadline is required")
    modules["modern_eval"].verify_pins()
    panel_module = modules["modern_panel" if manifest["panel_kind"] == "modern" else "census_panel"]
    required_seconds = manifest["spec"]["resources"]["wall_seconds"] + panel_module.config()["evaluator_timeout_seconds"] + LEASE_MARGIN_SECONDS
    ledger = campaign_path(out)
    completed, pending = [], {}
    stopped, next_run = None, None
    with (ledger.parent / ".writer.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        budget = Budget(ledger, modules, pilot_cap_usd=manifest["spec"]["pilot_cap_usd"], financing=financing)
        recovery = budget.orphan_stop()
        rows = iter(selected_rows(out, manifest, plan, phase))
        slots = list(range(concurrency))
        cfg = {**solver_cfg(manifest, modules), "experiment_id": manifest["spec"]["experiment_id"], "experiment_cost_limit_usd": str(budget.allowance(phase)), "router_phase": phase, "unknown_charge_policy": approval["unknown_charge_policy"]}
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            while True:
                while stopped is None and slots:
                    row = next(rows, None)
                    if row is None:
                        stopped = "phase_complete"
                        break
                    if run_state(ledger, row["run"]) is not None or (out / "rollouts" / row["run"]).exists():
                        continue
                    next_run = row["run"]
                    if row["run"] not in approval["runs"]:
                        stopped = "batch_complete"
                        break
                    if budget.stopped(phase):
                        stopped = "recorded_stop"
                        break
                    if time.time() + required_seconds > lease_deadline:
                        stopped = "lease_checkpoint"
                        break
                    try:
                        read_quote(out, batch, manifest, modules)
                    except ValueError:
                        stopped = "pricing_expired"
                        break
                    reason = budget.claim(row, manifest, cfg)
                    if reason is not None:
                        stopped = reason
                        break
                    slot = slots.pop(0)
                    future = executor.submit(concurrent_row, out, directory, manifest, row, private[row["instance_id"]], approval, cfg, batch, pricing, budget)
                    pending[future] = (row, slot)
                    next_run = None
                if not pending:
                    break
                finished, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in finished:
                    row, slot = pending.pop(future)
                    slots.append(slot)
                    slots.sort()
                    try:
                        result = future.result()
                    except BaseException as error:
                        budget.stop("row_supervisor_failed:" + row["run"])
                        result = {"summary": {"run": row["run"], "status": "infra_invalid", "error_type": type(error).__name__}, "state": "interrupted"}
                    completed.append(result["summary"])
                    if result["state"] != "finished" or result["summary"].get("status") != "completed" or result["summary"].get("grade_valid") is not True:
                        stopped = result["summary"].get("status", "invalid_completion")
                        budget.stop("bounded_run_failure:" + row["run"], phase)
        order = {row["run"]: index for index, row in enumerate(plan["runs"])}
        completed.sort(key=lambda summary: order[summary["run"]])
    return {"stopped": stopped, "completed": completed, "next_run": next_run, "recovery": recovery, "concurrency": concurrency}


def provider_outage_record(out, run, result):
    record_path = Path(out) / "rollouts" / run / "provider-unavailable.json"
    if not record_path.is_file():
        return None
    record = load(record_path)
    if not isinstance(record, dict) or not isinstance(record.get("model"), str) or not isinstance(record.get("effort"), str) or not isinstance(record.get("reason"), str):
        return None
    return record


def outcome(out, row, bills, kinds, accounted_ids=(), task=None):
    accounted = [bill for bill in bills if bill["state"] == "accounted_unknown" and bill["id"] in accounted_ids]
    if any(bill["id"] not in kinds or bill["state"] != "settled" and bill not in accounted or bill["state"] == "settled" and bill["actual"] is None for bill in bills):
        return None, "unknown_or_unsettled_charge"
    directory = Path(out) / "rollouts" / row["run"]
    result_path, evaluation_path = directory / "result.json", directory / "evaluation.json"
    if not result_path.is_file():
        return None, "undispatched_or_missing_result"
    result = load(result_path)
    evaluation = load(evaluation_path) if evaluation_path.is_file() else {}
    status = result.get("status")
    global_caps = {"recorded_stop", "unknown_charge_stop", "dispatch_stop", "never_retry", "global_candidate_cap", "phase_money_reservation", "aggregate_money_reservation", "admitted_envelope_reservation", "whole_plan_financing_reservation", "financed_envelope_reservation", "cost_forecast_reservation", "pilot_cap_reservation"}
    caps = list((result.get("resources") or {}).get("caps_fired", []))
    caps += [cap for path in (Path(out) / "resource-limits" / row["run"]).glob("*.json") for cap in load(path).get("caps", [])]
    if status == "budget_limited" and global_caps.intersection(caps):
        return None, "global_stop_truncated"
    report = evaluation.get("result")
    case = report[1].get(row["instance_id"], {}) if isinstance(report, list) and len(report) > 1 and isinstance(report[1], dict) else {}
    if status == "infra_invalid" or evaluation.get("reason") == "grader_infra_invalid" or evaluation.get("error"):
        return None, "infrastructure_or_grader_failure"
    if status == "completed" and not bills:
        return None, "completed_without_request_evidence"
    quality_lower = quality_upper = None
    if status == "provider_unavailable":
        if provider_outage_record(out, row["run"], result) is None:
            return None, "invalid_provider_unavailable_pair"
        quality_lower = quality_upper = 0
    elif status in {"completed", "budget_limited"} and evaluation.get("grade_valid") is True and type(case.get("resolved")) is bool:
        if helper("router-replay").grade_error(case, task) is not None:
            return None, "invalid_grade_completeness"
        quality_lower = quality_upper = int(case["resolved"])
    elif status == "budget_limited" and evaluation.get("reason") == "budget_limited" and bills:
        own_caps = {"agent_step_limit", "wall_timeout", "action_timeout", "run_token_reservation", "run_money_reservation", "input_token_bound", "input_byte_bound"}
        if not caps or not set(caps) <= own_caps:
            return None, "missing_or_invalid_run_limit_evidence"
        quality_lower = quality_upper = 0
    elif accounted and status in {"transport_unknown", "aborted", "stopped"}:
        quality_lower, quality_upper = 0, 1
    else:
        return None, "missing_or_invalid_grade"
    lower = sum((money(bill["actual"]) for bill in bills if kinds[bill["id"]] == "solver" and bill["state"] == "settled"), Decimal(0))
    upper = lower + sum((CAMPAIGN.held(bill) for bill in accounted if kinds[bill["id"]] == "solver"), Decimal(0))
    return {"resolved": bool(quality_lower) if quality_lower == quality_upper else None, "quality_lower": quality_lower, "quality_upper": quality_upper, "status": status, "solver": upper, "total": upper, "cost_lower": lower, "cost_upper": upper, "requests": len(bills)}, None


def _arm_stats(rows, outcomes, configuration, task_count, charges):
    expected_rows = [row for row in rows if row["configuration"] == configuration]
    arm_rows = [row for row in expected_rows if row["run"] in outcomes]
    values = [outcomes[row["run"]] for row in arm_rows]
    keys = [(row["instance_id"], row["repetition"]) for row in expected_rows]
    lower = sum(value["quality_lower"] for value in values)
    upper = sum(value["quality_upper"] for value in values)
    financial = [charges[row["run"]] for row in expected_rows] if charges is not None else values
    return {"configuration": configuration, "expected": task_count, "planned": len(expected_rows), "valid": len(values), "unique_task_repetitions": len(set(keys)), "coverage": set(keys), "resolved_lower": lower, "resolved_upper": upper, "pass_rate_lower": lower / task_count if task_count else None, "pass_rate_upper": upper / task_count if task_count else None, "cost_lower": str(sum((value["cost_lower"] for value in financial), Decimal(0))), "cost_upper": str(sum((value["cost_upper"] for value in financial), Decimal(0))), "solver_usd": str(sum((value["solver"] for value in financial), Decimal(0))), "uncertain_runs": [row["run"] for row in arm_rows if outcomes[row["run"]]["quality_lower"] != outcomes[row["run"]]["quality_upper"]]}


def arm_stats(rows, outcomes, configuration, task_count, charges=None):
    stats = _arm_stats(rows, outcomes, configuration, task_count, charges)
    return {key: value for key, value in stats.items() if key != "coverage"}


def compare(rows, outcomes, router_configuration, comparator_configuration, task_count, charges=None, mode="efficient", objective=None, expected_keys=None):
    needed = {router_configuration, comparator_configuration}
    stats = {name: _arm_stats(rows, outcomes, name, task_count, charges) for name in needed}
    coverage_ok = len({frozenset(item["coverage"]) for item in stats.values()}) == 1
    if expected_keys is not None:
        coverage_ok = coverage_ok and all(item["coverage"] == set(expected_keys) for item in stats.values())
    complete = task_count > 0 and coverage_ok and all(item["valid"] == item["planned"] == item["unique_task_repetitions"] == task_count and not item["uncertain_runs"] and money(item["cost_lower"]) == money(item["cost_upper"]) for item in stats.values())
    router, comparator = stats[router_configuration], stats[comparator_configuration]
    higher_pass = complete and router["resolved_lower"] > comparator["resolved_upper"]
    lower_cost = complete and money(router["cost_upper"]) < money(comparator["cost_lower"])
    passes, checks = False, {}
    if objective is not None and mode == "efficient":
        floor = objective["success_floor"]
        if floor["type"] == "absolute":
            checks["success_floor_met"] = complete and Decimal(router["resolved_lower"]) / Decimal(task_count) >= Decimal(floor["min_pass_rate"])
        else:
            checks["success_floor_met"] = complete and router["resolved_lower"] >= comparator["resolved_upper"]
        checks["strictly_lower_cost_than_comparator"] = lower_cost
        passes = all(checks.values())
    elif objective is not None and mode == "frontier":
        budget = objective["cost_budget"]
        if budget["type"] == "absolute":
            checks["within_cost_budget"] = complete and money(router["cost_upper"]) <= money(budget["max_total_usd"])
        else:
            checks["within_cost_budget"] = complete and money(router["cost_upper"]) <= money(comparator["cost_lower"])
        checks["strictly_higher_success_than_comparator"] = higher_pass
        passes = all(checks.values())
    clean = lambda item: {key: value for key, value in item.items() if key != "coverage"}
    return {"complete": complete, "mode": mode, "objective_checks": checks, "passes": bool(passes), "diagnostic_strict_dominance": {"strictly_higher_pass_rate": higher_pass, "strictly_lower_total_cost": lower_cost, "passes": higher_pass and lower_cost}, "strictly_higher_pass_rate": higher_pass, "strictly_lower_total_cost": lower_cost, "comparator": clean(comparator), "router": clean(router)}


def analyze(out, manifest, plan, phase, modules):
    if manifest.get("version") != SPEC_VERSION:
        raise ValueError("Historical evidence is audit-only and cannot establish a pass")
    with CAMPAIGN.readonly(campaign_path(out)) as db:
        ledger = modules["study"].request_rows(db)
        kinds = dict(db.execute("SELECT id,kind FROM router_requests"))
        accounted_ids = {row["id"] for row in ledger if accounted_row_valid(db, row)}
        stops = [row["reason"] for row in active_stops(db, phase)]
        stops += ["unaccounted_request:" + row["id"] for row in ledger if row["state"] != "settled" and row["id"] not in accounted_ids and not CAMPAIGN.historical_commitment(db, row)]
        candidate_block = CAMPAIGN.admission_block(db)
        if candidate_block:
            stops.append(candidate_block)
        attempted = {row[0] for row in db.execute("SELECT run FROM router_runs")}
    rows = selected_rows(out, manifest, plan, phase)
    tasks = {task["instance_id"]: task for task in load(Path(manifest["panel_root"]) / "evaluator" / "tasks.json")}
    outcomes, invalid, charges, providers = {}, [], {}, []
    for row in rows:
        bills = [bill for bill in ledger if bill["run"] == row["run"]]
        lower = sum((money(bill["actual"]) for bill in bills if bill["state"] == "settled"), Decimal(0))
        charges[row["run"]] = {"cost_lower": lower, "cost_upper": sum((CAMPAIGN.held(bill) for bill in bills), Decimal(0)), "solver": sum((CAMPAIGN.held(bill) for bill in bills if kinds.get(bill["id"]) == "solver"), Decimal(0))}
        value, reason = outcome(out, row, bills, kinds, accounted_ids, tasks.get(row["instance_id"]))
        if row["run"] not in attempted:
            invalid.append({"run": row["run"], "reason": "undispatched", "scored_as_failure": False})
        elif value is None:
            invalid.append({"run": row["run"], "reason": reason})
        else:
            outcomes[row["run"]] = value
            if value["status"] == "provider_unavailable":
                providers.append(row["run"])
    spec = manifest["spec"]
    candidate_ids = {item["router"]: item["id"] for item in spec["configurations"]}
    comparisons, arms_report, superiority, cost_matching = {}, {}, {}, {}
    for router in MODES:
        mode_rows = [row for row in rows if row["router"] == router]
        count = 1 if phase == "pilot" else len(spec["tasks"][phase]) * spec["repetitions"]
        expected_keys = {(task, repetition) for task in spec["tasks"][phase] for repetition in range(1 if phase == "pilot" else spec["repetitions"])} if phase != "pilot" else {(spec["tasks"]["tuning"][0], 0)}
        configurations = sorted({row["configuration"] for row in mode_rows})
        arms_report[router] = {configuration: arm_stats(mode_rows, outcomes, configuration, count, charges) for configuration in configurations}
        objective = spec["objectives"][router]
        comparisons[router] = {comparator: compare(mode_rows, outcomes, candidate_ids[router], comparator, count, charges, mode=router, objective=objective, expected_keys=expected_keys) for comparator in configurations if comparator != candidate_ids[router]} if phase == "final" else {}
        fixed_ids = [row["configuration"] for row in mode_rows if row.get("arm_kind") == "fixed"]
        fixed_ids = sorted(set(fixed_ids))
        superiority[router] = {"per_fixed_model": {fixed: comparisons[router][fixed]["passes"] for fixed in fixed_ids}, "superior_to_every_fixed_model": bool(fixed_ids) and all(comparisons[router][fixed]["passes"] for fixed in fixed_ids), "not_established_for": [fixed for fixed in fixed_ids if not comparisons[router][fixed]["passes"]]}
        if phase == "final" and "control" in arms_report[router] and candidate_ids[router] in arms_report[router]:
            tolerance = Decimal(spec["control"]["cost_matching"]["tolerance_fraction"])
            control, reference = arms_report[router]["control"], arms_report[router][candidate_ids[router]]
            complete_arms = control["valid"] == control["planned"] == count and reference["valid"] == reference["planned"] == count and not control["uncertain_runs"] and not reference["uncertain_runs"] and money(control["cost_lower"]) == money(control["cost_upper"]) and money(reference["cost_lower"]) == money(reference["cost_upper"])
            matched = complete_arms and money(control["cost_upper"]) <= money(reference["cost_lower"]) * (1 + tolerance) and money(control["cost_lower"]) >= money(reference["cost_upper"]) * (1 - tolerance)
            # The reference arm is the live router. Its settled cost includes
            # the full classifier allowance, an upper bound, so cost matching
            # stays withheld until classifier charges are reconciled.
            cost_matching[router] = {"criterion": spec["control"]["cost_matching"], "control_cost_lower_usd": control["cost_lower"], "control_cost_upper_usd": control["cost_upper"], "reference_cost_lower_usd": reference["cost_lower"], "reference_cost_upper_usd": reference["cost_upper"], "cost_matched": False, "claim_allowed": False, "reason": "router settled cost includes the full classifier allowance, an upper bound; cost matching withheld until classifier charges are reconciled", "diagnostic_cost_matched": bool(matched)}
    plan_complete = not invalid and not stops and all(stats["valid"] == stats["planned"] for mode_arms in arms_report.values() for stats in mode_arms.values()) and all(value["complete"] for values in comparisons.values() for value in values.values())
    if not plan_complete:
        for values in comparisons.values():
            for value in values.values():
                value.update(complete=False, passes=False, strictly_higher_pass_rate=False, strictly_lower_total_cost=False)
                value["objective_checks"] = {key: False for key in value["objective_checks"]}
                value["diagnostic_strict_dominance"] = {key: False for key in value["diagnostic_strict_dominance"]}
        for value in superiority.values():
            value["superior_to_every_fixed_model"] = False
            value["per_fixed_model"] = {key: False for key in value["per_fixed_model"]}
            value["not_established_for"] = sorted(value["per_fixed_model"])
        for value in cost_matching.values():
            value.update(cost_matched=False, claim_allowed=False)
    claims_allowed = phase == "final" and plan_complete
    report = {"version": 4, "phase": phase, "manifest_sha256": digest(manifest), "missing_or_invalid": invalid, "recorded_stops": stops, "campaign_settled_plus_held_usd": str(sum((CAMPAIGN.held(row) for row in ledger), Decimal(0))), "phase_all_arm_cost_lower_usd": str(sum((value["cost_lower"] for value in charges.values()), Decimal(0))), "phase_all_arm_cost_upper_usd": str(sum((value["cost_upper"] for value in charges.values()), Decimal(0))), "arms": arms_report, "comparisons": comparisons, "fixed_model_superiority": superiority, "control_cost_matching": cost_matching, "provider_unavailable_runs": providers, "generalization_claim": False, "plan_complete": plan_complete, "conclusion": "complete" if plan_complete else "inconclusive", "inconclusive": not plan_complete, "can_establish_pass": claims_allowed, "can_establish_superiority": claims_allowed, "can_establish_cost_matching": False, "cost_matching_withheld_reason": "router settled cost includes the full classifier allowance, an upper bound; withheld until classifier charges are reconciled", "denominator_note": "Repetitions are repeated observations of the same frozen tasks, not independent tasks; no generalization or statistical-power claim is made.", "outcome_rule": "Full frozen task x arm x repetition denominator for every mandatory arm. Provider unavailability is an arm failure. Audited ambiguous transport has quality interval [0,1]. Infrastructure/grader failures and incomplete grades block completeness. Undispatched rows are missing, never failures. A budget stop or any partial plan is inconclusive and cannot establish a pass, superiority or cost matching from a favorable prefix.", "cost_rule": "Every arm charge is retained even for invalid outcomes, including failed attempts and full unknown holds. Objectives are the preregistered per-mode rules; strict-both-better is diagnostic only."}
    modules["study"].save(out / f"{phase}-analysis.json", report)
    return report


def validate_pilot_evidence(out, manifest, plan, evidence_path):
    evidence = load(evidence_path)
    expected = {"schema", "manifest_sha256", "execution_plan_sha256", "prospective_grant_id", "passed", "runs", "parser", "evidence_files", "failures", "observations", "total_cost_usd"}
    pilot = [row for row in plan["runs"] if row["phase"] == "pilot"]
    if not isinstance(evidence, dict) or set(evidence) != expected or evidence["schema"] != "router-protocol-pilot-v2" or evidence["manifest_sha256"] != digest(manifest) or evidence["execution_plan_sha256"] != digest(plan) or evidence["prospective_grant_id"] != manifest["spec"]["prospective_grant_id"]:
        raise ValueError("Exact pilot evidence for this grant, manifest and plan required")
    if len(pilot) != 2 or evidence["runs"] != [row["run"] for row in pilot] or evidence["passed"] is not True or evidence["failures"] != []:
        raise ValueError("Both router protocol pilots must succeed without unexplained failures")
    if not isinstance(evidence["parser"], dict) or set(evidence["parser"]) != {"revision", "files", "model_settings", "action_regex"} or not evidence["parser"]["files"] or not evidence["parser"]["action_regex"]:
        raise ValueError("Pinned text parser identity and configuration required")
    if evidence["parser"]["revision"] != helper("router-replay").MINI_REVISION:
        raise ValueError("Pilot parser revision differs from the pinned text transport")
    observations = evidence["observations"]
    if not isinstance(observations, list) or len(observations) != len(pilot) or not all(isinstance(item, dict) for item in observations) or [item.get("run") for item in observations] != evidence["runs"]:
        raise ValueError("Pilot observations must cover both router runs in frozen order")
    for observation, row in zip(observations, pilot):
        if any(observation.get(key) != row[key] for key in ("run", "router", "instance_id", "configuration", "repetition")) or observation.get("status") != "completed" or observation.get("exit_status") != "Submitted" or type(observation.get("resolved")) is not bool:
            raise ValueError("Pilot needs completed router observations, not infrastructure or format recovery")
        requests = observation.get("requests")
        if not isinstance(requests, list) or not requests:
            raise ValueError("Every observed solver output requires pinned text-parser evidence")
        for request in requests:
            if not isinstance(request, dict) or request.get("run") != row["run"] or not isinstance(request.get("text_parser"), dict) or request["text_parser"].get("accepted") is not True or any(request.get(key) is not False for key in ("native_calls_present", "native_markup_present", "request_declares_tools")):
                raise ValueError("Typed calls, DSML and text format mismatches block the final holdout")
            if request.get("category") not in {"text_action_accepted", "provider_reported_length"}:
                raise ValueError("Provider or unexplained format failure blocks the final holdout")
            if request["category"] == "provider_reported_length" and (type(request.get("reported_completion_tokens")) is not int or type(request.get("max_tokens")) is not int or request["reported_completion_tokens"] < request["max_tokens"]):
                raise ValueError("Unexplained premature length blocks the final holdout")
    files = evidence["evidence_files"]
    if not isinstance(files, dict) or not files or any(not Path(path).is_absolute() or file_hash(path) != sha for path, sha in files.items()):
        raise ValueError("Pilot source evidence bytes changed")
    required_files = {str(Path(out) / folder / row["run"] / name) for row in pilot for folder, name in (("rollouts", "result.json"), ("rollouts", "evaluation.json"), ("rollouts", "approval.json"))}
    if not required_files <= files.keys():
        raise ValueError("Pilot requires every saved result, grade and approval")
    with CAMPAIGN.readonly(campaign_path(out)) as db:
        ledger = CAMPAIGN.rows(db)
        kinds = dict(db.execute("SELECT id,kind FROM router_requests"))
        tasks = {task["instance_id"]: task for task in load(Path(manifest["panel_root"]) / "evaluator" / "tasks.json")}
        for row in pilot:
            bills = [bill for bill in ledger if bill["run"] == row["run"]]
            if db.execute("SELECT state FROM router_runs WHERE run=?", (row["run"],)).fetchone() != ("finished",) or not bills or any(bill["state"] != "settled" or str(Path(bill["receipt"])) not in files for bill in bills):
                raise ValueError("Pilot must finish with all gateway charges settled and receipts bound")
            value, reason = outcome(out, row, bills, kinds, task=tasks.get(row["instance_id"]))
            if value is None or value["status"] != "completed":
                raise ValueError("Pilot needs a complete valid deterministic grade: " + str(reason))
            observation = next(item for item in observations if item["run"] == row["run"])
            solver_ids = {bill["id"] for bill in bills if kinds.get(bill["id"]) == "solver"}
            if {item.get("request_id") for item in observation["requests"]} != solver_ids or len(observation["requests"]) != len(solver_ids):
                raise ValueError("Pilot parser evidence must cover all observed solver requests exactly once")
        cost = sum((money(bill["actual"]) for bill in ledger if bill["run"] in evidence["runs"]), Decimal(0))
    pilot_cap = money(manifest["spec"].get("pilot_cap_usd", str(PILOT_CAP_USD)))
    if not isinstance(evidence["total_cost_usd"], str) or money(evidence["total_cost_usd"]) != cost or cost > pilot_cap:
        raise ValueError("Pilot cumulative charges must match exactly and remain within the frozen pilot cap")
    return evidence


def select_final(out, manifest, plan, approval, modules, pilot_evidence):
    evidence = validate_pilot_evidence(out, manifest, plan, pilot_evidence)
    configurations = {item["router"]: item["id"] for item in manifest["spec"]["configurations"]}
    required = {"authorized": True, "action": "select-final-router-study-v6", "manifest_sha256": digest(manifest), "prospective_grant_id": manifest["spec"]["prospective_grant_id"], "pilot_evidence_sha256": digest(evidence), "pilot_evidence_file_sha256": file_hash(pilot_evidence), "configurations": configurations}
    if approval != required:
        raise ValueError("Exact parent final approval bound to the successful router protocol pilot required")
    with CAMPAIGN.readonly(campaign_path(out)) as db:
        if active_stops(db):
            raise ValueError("A recorded stop blocks final selection")
        if db.execute("SELECT 1 FROM campaign_admissions a JOIN router_runs r USING(run) WHERE a.manifest_sha256=? AND r.phase='final'", (digest(manifest),)).fetchone():
            raise ValueError("Final selection must precede every final attempt in this manifest")
    destination = Path(out) / "pilot-evidence.json"
    if Path(pilot_evidence).resolve() != destination.resolve():
        frozen_copy(pilot_evidence, destination)
    frozen_write(out / "final-selection.json", approval)
    return approval


def historical_audit(out):
    manifest_path = out / MANIFEST
    manifest = load(manifest_path)
    with CAMPAIGN.readonly(out / "budget.sqlite") as db:
        ledger = CAMPAIGN.rows(db)
    synthetic = [row for row in ledger if CAMPAIGN.synthetic_prior(row)]
    ledger = [row for row in ledger if not CAMPAIGN.synthetic_prior(row)]
    plan = load(out / "execution-plan.json")
    results = []
    for row in plan["runs"]:
        folder = out / "rollouts" / row["run"]
        result = load(folder / "result.json") if (folder / "result.json").is_file() else {}
        evaluation = load(folder / "evaluation.json") if (folder / "evaluation.json").is_file() else {}
        bills = [bill for bill in ledger if bill["run"] == row["run"]]
        results.append({"run": row["run"], "status": result.get("status", "missing"), "grade_valid": evaluation.get("grade_valid") is True, "evaluation_reason": evaluation.get("reason"), "cost_upper_usd": str(sum((CAMPAIGN.held(bill) for bill in bills), Decimal(0)))})
    return {"audit_only": True, "manifest_version": manifest.get("version"), "manifest_file_sha256": file_hash(manifest_path), "passes": False, "verified_complete": False, "reason": "Historical manifests cannot supply executable, repeated split and global campaign provenance retroactively", "synthetic_prior_rows_excluded": len(synthetic), "settled_actual_usd": str(sum((money(row["actual"]) for row in ledger if row["state"] == "settled"), Decimal(0))), "settled_plus_held_usd": str(sum((CAMPAIGN.held(row) for row in ledger), Decimal(0))), "runs": results}


def main():
    parser = argparse.ArgumentParser(description="Frozen live-gateway router public-task study. No command grants paid authorization.")
    parser.add_argument("--driver-dir", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--panel-out", type=Path)
    subs = parser.add_subparsers(dest="command", required=True)
    for name in ("freeze-inputs", "freeze"):
        sub = subs.add_parser(name)
        sub.add_argument("--spec", type=Path, required=True)
        sub.add_argument("--panel-kind", choices=("census", "modern", "router"), required=True)
        if name == "freeze":
            sub.add_argument("--approval", type=Path, required=True)
    sub = subs.add_parser("quote")
    sub.add_argument("--batch", required=True)
    sub = subs.add_parser("finance")
    sub.add_argument("--batch", required=True)
    for name in ("run-inputs", "run"):
        sub = subs.add_parser(name)
        sub.add_argument("--batch", required=True)
        sub.add_argument("--phase", choices=("pilot", "final"), required=True)
        sub.add_argument("--concurrency", type=int, default=1)
        sub.add_argument("--auto-account-unknown", action="store_true")
        if name == "run-inputs":
            sub.add_argument("--runs", type=Path, required=True)
        if name == "run":
            sub.add_argument("--approval", type=Path, required=True)
            sub.add_argument("--lease-deadline", type=float, required=True)
    sub = subs.add_parser("select-final")
    sub.add_argument("--approval", type=Path, required=True)
    sub.add_argument("--pilot-evidence", type=Path, required=True)
    sub = subs.add_parser("analyze")
    sub.add_argument("--phase", choices=("pilot", "final"), required=True)
    sub = subs.add_parser("account-unknown")
    sub.add_argument("--request", required=True)
    sub.add_argument("--evidence", type=Path, required=True)
    sub = subs.add_parser("clear-stop")
    sub.add_argument("--reason", required=True)
    subs.add_parser("audit-historical")
    args = parser.parse_args()
    out = args.out.resolve()
    if args.command == "audit-historical":
        print(json.dumps(historical_audit(out), indent=2, sort_keys=True))
        return
    if args.driver_dir is None or args.panel_out is None:
        parser.error("--driver-dir and --panel-out are required except for read-only historical audit")
    directory = args.driver_dir.resolve(strict=True)
    out, panel_out = args.out.resolve(), args.panel_out.resolve(strict=True)
    if any(first == second or first.is_relative_to(second) or second.is_relative_to(first) for first, second in [(out, panel_out), (out, directory), (out, REPO)]):
        raise ValueError("Study artifacts must be separate from the panel, read-only driver and repository")
    modules = driver(directory)
    if args.command == "freeze-inputs":
        result = freeze_inputs(panel_out, args.panel_kind, directory, load(args.spec), modules)[0]
    elif args.command == "freeze":
        result = freeze(out, panel_out, args.panel_kind, directory, load(args.spec), load(args.approval), modules)
    elif args.command == "quote":
        result = quote(out, panel_out, directory, modules, args.batch)
    elif args.command == "finance":
        result = finance_plan(out, panel_out, directory, modules, args.batch)
    elif args.command == "run":
        result = execute(out, panel_out, directory, modules, args.batch, args.phase, load(args.approval), args.lease_deadline, args.concurrency, args.auto_account_unknown)
    elif args.command in {"account-unknown", "clear-stop"}:
        validate(out, panel_out, directory, modules)
        result = account_unknown(out, args.request, args.evidence, modules) if args.command == "account-unknown" else clear_stop(out, args.reason, modules)
    else:
        manifest, plan, _ = validate(out, panel_out, directory, modules)
        if args.command == "run-inputs":
            pricing = read_quote(out, args.batch, manifest, modules)
            financing = load_financing(out, args.batch, manifest)
            with CAMPAIGN.readonly(campaign_path(out)) as db:
                authorization = CAMPAIGN.authorization_summary(CAMPAIGN.effective_authorization(db, manifest["spec"]["prospective_grant_id"]))
            result = run_approval(out, manifest, plan, args.phase, args.batch, load(args.runs), pricing, args.concurrency, args.auto_account_unknown, financing=financing, authorization=authorization)
        elif args.command == "select-final":
            result = select_final(out, manifest, plan, load(args.approval), modules, args.pilot_evidence)
        else:
            result = analyze(out, manifest, plan, args.phase, modules)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

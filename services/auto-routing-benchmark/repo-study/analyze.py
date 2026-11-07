
import collections
import math
import random
import re
import sqlite3
from decimal import Decimal
from pathlib import Path

from study import active_candidates, config, digest, load, save, scope_digest


def phase_data(out, phase):
    cfg = config()
    panel = load(out / "panel.json")
    if panel["config_sha256"] != digest(cfg):
        raise ValueError("Study configuration changed after task freeze")
    tasks = [task for task in panel["tasks"] if task["split"] == phase]
    rows = {}
    missing = []
    with sqlite3.connect((out / "budget.sqlite").resolve().as_uri() + "?mode=ro", uri=True) as db:
        receipts = db.execute("SELECT run,bound,actual,state FROM requests").fetchall()
    for task in tasks:
        for candidate in active_candidates(out, cfg):
            attempts = []
            for rep in range(2 if phase == "discovery" else 1):
                run = f"{task['instance_id']}--{candidate['label']}--{rep}"
                directory = out / "rollouts" / run
                result_path = directory / "result.json"
                evaluation_path = directory / "evaluation.json"
                if not result_path.exists() or not evaluation_path.exists():
                    missing.append(run)
                    continue
                result = load(result_path)
                if result.get("status") == "infra_invalid":
                    missing.append(run)
                    continue
                evaluation_record = load(evaluation_path)
                evaluation = evaluation_record.get("result")
                grade = evaluation[1].get(task["instance_id"], {}) if isinstance(evaluation, list) and len(evaluation) > 1 and isinstance(evaluation[1], dict) else {}
                resolved = False if result.get("status") in {"budget_limited", "transport_unknown"} and evaluation_record.get("grade_valid") is False else grade.get("resolved")
                if type(resolved) is not bool:
                    missing.append(run)
                    continue
                billed = [row for row in receipts if row[0] == run]
                if not billed and result.get("status") != "budget_limited":
                    missing.append(run)
                    continue
                unknown = any(row[3] != "settled" or row[2] is None for row in billed)
                known = sum((Decimal(row[2]) for row in billed if row[3] == "settled" and row[2] is not None), Decimal(0))
                upper = sum((max(Decimal(row[1]), Decimal(row[2] or "0")) if row[3] != "settled" else Decimal(row[2]) for row in billed), Decimal(0))
                if not known.is_finite() or known < 0 or not upper.is_finite() or upper < 0:
                    raise ValueError("Invalid monetary receipt")
                attempts.append({"resolved": resolved, "known": float(known), "cost": None if unknown else float(known), "upper": float(upper), "elapsed": result.get("elapsed_seconds"), "status": result.get("status", result.get("result", {}).get("exit_status", "unknown"))})
                attempts[-1]["hiddenGradeValid"] = type(grade.get("resolved")) is bool
            if len(attempts) == (2 if phase == "discovery" else 1):
                rows[(task["instance_id"], candidate["label"])] = attempts
    return panel, tasks, rows, missing


def excluded_outcomes(out, phase, panel, cfg):
    active = {candidate["label"] for candidate in active_candidates(out, cfg)}
    excluded = {candidate["label"] for candidate in cfg["candidates"]} - active
    runs = {
        f"{task['instance_id']}--{label}--{rep}"
        for task in panel["tasks"] if task["split"] == phase
        for label in excluded for rep in range(2 if phase == "discovery" else 1)
    }
    statuses = collections.Counter()
    refused = set()
    known = Decimal(0)
    upper = Decimal(0)
    unknown = 0
    for run in runs:
        path = out / "rollouts" / run / "result.json"
        if path.exists():
            statuses[load(path)["status"]] += 1
    with sqlite3.connect((out / "budget.sqlite").resolve().as_uri() + "?mode=ro", uri=True) as db:
        receipts = db.execute("SELECT run,bound,actual,state FROM requests").fetchall()
    for run, bound, actual, state in receipts:
        if run not in runs:
            continue
        if state == "settled" and actual is not None:
            known += Decimal(actual)
            upper += Decimal(actual)
        else:
            upper += max(Decimal(bound), Decimal(actual or "0"))
            unknown += 1
    for path in (out / "receipts").glob("*.json"):
        receipt = load(path)
        if receipt.get("run") in runs:
            choices = (receipt.get("response") or {}).get("choices", [])
            if any(choice.get("native_finish_reason") == "refusal" or choice.get("message", {}).get("refusal") for choice in choices):
                refused.add(receipt["run"])
    return {"candidates": sorted(excluded), "attemptedRollouts": sum(statuses.values()), "statuses": dict(statuses), "providerRefusedRollouts": len(refused), "knownCostLowerUsd": float(known), "committedCostUpperUsd": float(upper), "unresolvedRequests": unknown, "qualityComparison": "Excluded, not a cognitive failure. Costs and retained unknown bounds still count against the study budget."}


def metrics(tasks, choices, rows, baseline):
    observations = []
    costs = []
    statuses = collections.Counter()
    elapsed = []
    known_cost = 0.0
    upper_cost = 0.0
    graded_attempts = 0
    ungraded_failures = 0
    for task in tasks:
        key = task["instance_id"]
        attempts = rows[(key, choices[key])]
        reference = rows[(key, baseline)]
        quality = sum(row["resolved"] for row in attempts) / len(attempts)
        base_quality = sum(row["resolved"] for row in reference) / len(reference)
        observations.append((task["repo"], quality, quality - base_quality))
        costs.extend(row["cost"] for row in attempts)
        known_cost += sum(row["known"] for row in attempts)
        upper_cost += sum(row["upper"] for row in attempts)
        graded_attempts += sum(row["hiddenGradeValid"] for row in attempts)
        ungraded_failures += sum(not row["hiddenGradeValid"] and not row["resolved"] for row in attempts)
        statuses.update(str(row["status"]) for row in attempts)
        elapsed.extend(row["elapsed"] for row in attempts if isinstance(row["elapsed"], (int, float)) and row["elapsed"] >= 0)
    successes = sum(row[1] for row in observations)
    repeats = len(rows[(tasks[0]["instance_id"], choices[tasks[0]["instance_id"]])]) if tasks else 0
    cost = None if not costs or any(value is None for value in costs) else sum(costs)
    groups = collections.defaultdict(list)
    for repo, quality, delta in observations:
        groups[repo].append((quality, delta))
    interval = None
    if len(groups) >= 2:
        rng = random.Random(73419)
        families = sorted(groups)
        estimates = []
        for _ in range(1000):
            sample = [row for _ in families for row in groups[rng.choice(families)]]
            estimates.append(sum(row[1] for row in sample) / len(sample))
        estimates.sort()
        interval = [estimates[24], estimates[974]]
    return {
        "tasks": len(tasks),
        "families": len(groups),
        "quality": successes / len(tasks) if tasks else None,
        "successfulAttemptEquivalent": successes * repeats,
        "hiddenGradedAttempts": graded_attempts,
        "ungradedCompletionFailures": ungraded_failures,
        "totalCostUsd": cost,
        "knownCostLowerUsd": known_cost,
        "committedCostUpperUsd": upper_cost,
        "costPerSuccessUsd": cost / (successes * repeats) if cost is not None and successes else None,
        "costPerSuccessLowerUsd": known_cost / (successes * repeats) if successes else None,
        "costPerSuccessUpperUsd": upper_cost / (successes * repeats) if successes else None,
        "meanElapsedSeconds": sum(elapsed) / len(elapsed) if elapsed else None,
        "netQualityChange": sum(row[2] for row in observations) / len(tasks) if tasks else None,
        "pairedFamilyBootstrap95": interval,
        "statuses": dict(statuses),
        "selected": dict(collections.Counter(choices.values())),
    }


def vector(text):
    counts = collections.Counter(re.findall(r"[a-z0-9_]+", text.lower()))
    values = {word: math.log1p(count) for word, count in counts.items()}
    norm = math.sqrt(sum(value * value for value in values.values()))
    return {word: value / norm for word, value in values.items()} if norm else {}


def predict(task, rule, surface):
    text = task["problem_statement"]
    query = vector(text[:800] if surface == "prefix" else text)
    scored = []
    for example in rule["training"]:
        features = vector(example["text"][:800] if surface == "prefix" else example["text"])
        similarity = sum(value * features.get(word, 0) for word, value in query.items())
        if similarity > 0:
            scored.append((similarity, example))
    neighbors = sorted(scored, key=lambda row: -row[0])[:3]
    weight = sum(row[0] for row in neighbors)
    estimates = {arm: (prior + sum(similarity * example["quality"][arm] for similarity, example in neighbors)) / (1 + weight) for arm, prior in rule["priors"].items()}
    alternative = min(estimates, key=lambda arm: (-estimates[arm], rule["trainingMeanCost"].get(arm) if rule["trainingMeanCost"].get(arm) is not None else float("inf"), arm))
    return alternative if estimates[alternative] - estimates[rule["baseline"]] >= rule["gainThreshold"] else rule["baseline"]


def write_frozen(path, value):
    if path.exists():
        if load(path) != value:
            raise ValueError(f"Refusing to change frozen artifact: {path.name}")
    else:
        save(path, value)


def analyze(out, phase):
    cfg = config()
    panel, tasks, rows, missing = phase_data(out, phase)
    candidates = active_candidates(out, cfg)
    scope = scope_digest(out, cfg)
    report = {"version": 1, "phase": phase, "panel_sha256": digest(panel), "missingOrInvalidRuns": missing, "pools": {}, "limitations": ["Small historical public repository panel; possible pretraining exposure.", "Policy predictions use issue text only, never hidden tests or task IDs.", "Paired intervals use repository families; few families do not establish broad superiority.", "Selection results replay independent fixed-model runs, not production classifier-inclusive routing.", "Costs exclude VM infrastructure and predictor CPU."]}
    report["outcomeDefinition"] = "Resolved within preregistered bounds. Budget/time exhaustion or an accounting-aborted rollout without a usable patch is completion failure, not an executed hidden-test semantic grade. Infrastructure-invalid or missing results are excluded from every arm; statuses remain separate."
    report["billingDefinition"] = "Unresolved bills are not zero. Monetary intervals use settled known charges as lower bounds and all retained request maxima as upper bounds. Cost-efficiency gates compare candidate upper bounds with baseline lower bounds."
    report["exclusion_manifest_sha256"] = scope
    report["excludedOutcomes"] = excluded_outcomes(out, phase, panel, cfg)
    if report["excludedOutcomes"]["candidates"]:
        report["limitations"].append("User-authorized candidate exclusion prevents a superiority claim over the original full pool.")
    frozen = {"version": 1, "panel_sha256": digest(panel), "source_sha256": digest(Path(__file__).read_text()), "exclusion_manifest_sha256": scope, "pools": {}}
    prior_rules = None if phase == "discovery" else load(out / ("discovery-rule.json" if phase == "validation" else "holdout-rule.json"))
    if prior_rules is not None and prior_rules["panel_sha256"] != digest(panel):
        raise ValueError("Rules belong to another frozen panel")
    if prior_rules is not None and prior_rules["source_sha256"] != digest(Path(__file__).read_text()):
        raise ValueError("Analysis changed after rule freeze")
    if prior_rules is not None and prior_rules.get("exclusion_manifest_sha256") != scope:
        raise ValueError("Candidate scope changed after rule freeze")
    for pool in sorted({candidate["label"].split("-", 1)[0] for candidate in candidates}):
        arms = [candidate["label"] for candidate in candidates if candidate["label"].startswith(pool + "-")]
        complete = [task for task in tasks if all((task["instance_id"], arm) in rows for arm in arms)]
        if len(complete) != len(tasks) or not complete:
            report["pools"][pool] = {"status": "incomplete", "completeTasks": len(complete), "expectedTasks": len(tasks)}
            continue
        if phase == "discovery":
            priors = {arm: sum(sum(row["resolved"] for row in rows[(task["instance_id"], arm)]) / len(rows[(task["instance_id"], arm)]) for task in complete) / len(complete) for arm in arms}
            mean_cost = {arm: None if any(row["cost"] is None for task in complete for row in rows[(task["instance_id"], arm)]) else sum(row["known"] for task in complete for row in rows[(task["instance_id"], arm)]) / sum(len(rows[(task["instance_id"], arm)]) for task in complete) for arm in arms}
            baseline = min(arms, key=lambda arm: (-priors[arm], mean_cost[arm] if mean_cost[arm] is not None else float("inf"), arm))
            rule = {"baseline": baseline, "active": "full", "gainThreshold": 0.1, "priors": priors, "trainingMeanCost": mean_cost, "training": [{"text": task["problem_statement"], "quality": {arm: sum(row["resolved"] for row in rows[(task["instance_id"], arm)]) / len(rows[(task["instance_id"], arm)]) for arm in arms}} for task in complete]}
            frozen["pools"][pool] = rule
        else:
            rule = prior_rules["pools"][pool]
            baseline = rule["baseline"]
            if baseline not in arms or set(rule["priors"]) != set(arms):
                raise ValueError("Frozen policy contains a candidate outside the authorized scope")
        references = {arm: metrics(complete, {task["instance_id"]: arm for task in complete}, rows, baseline) for arm in arms}
        selections = {surface: {task["instance_id"]: predict(task, rule, surface) for task in complete} for surface in ["prefix", "full"]}
        estimates = {surface: metrics(complete, choices, rows, baseline) for surface, choices in selections.items()}
        repeatable = [{"task": task["instance_id"], "alternative": arm} for task in complete for arm in arms if arm != baseline and all(not row["resolved"] for row in rows[(task["instance_id"], baseline)]) and all(row["resolved"] for row in rows[(task["instance_id"], arm)])]
        active = rule.get("active", "full")
        if phase == "validation":
            candidate = estimates["full"]
            base = references[baseline]
            accepted = candidate["quality"] > base["quality"] and candidate["costPerSuccessUpperUsd"] is not None and (base["quality"] == 0 or (base["costPerSuccessLowerUsd"] is not None and candidate["costPerSuccessUpperUsd"] <= base["costPerSuccessLowerUsd"]))
            active = "full" if accepted else "fixed"
            frozen["pools"][pool] = {**rule, "active": active, "validationPassed": accepted}
        active_metrics = references[baseline] if active == "fixed" else estimates["full"]
        report["pools"][pool] = {"status": "complete", "baseline": baseline, "fixedReferences": references, "issueTextAblations": estimates, "activePolicy": active, "activeMetrics": active_metrics}
        report["pools"][pool]["repeatableOperationalRescues"] = repeatable if phase == "discovery" else None
        report["pools"][pool]["repeatableRescues"] = [rescue for rescue in repeatable if all(row["hiddenGradeValid"] for arm in [baseline, rescue["alternative"]] for row in rows[(rescue["task"], arm)])] if phase == "discovery" else None
        graded_tasks = [task for task in complete if all(row["hiddenGradeValid"] for arm in arms for row in rows[(task["instance_id"], arm)])]
        report["pools"][pool]["commonHiddenGradedPanel"] = {"tasks": len(graded_tasks), "families": len({task["repo"] for task in graded_tasks}), "fixedReferences": {arm: metrics(graded_tasks, {task["instance_id"]: arm for task in graded_tasks}, rows, baseline) for arm in arms}}
    rule_name = "discovery-rule.json" if phase == "discovery" else "holdout-rule.json"
    if phase != "holdout" and len(frozen["pools"]) == len(report["pools"]):
        write_frozen(out / rule_name, frozen)
    save(out / f"{phase}-analysis.json", report)
    return report


def freeze_decisions(out, phase):
    if phase not in {"validation", "holdout"}:
        raise ValueError("Only unseen validation/holdout decisions can be frozen")
    panel = load(out / "panel.json")
    rule = load(out / ("discovery-rule.json" if phase == "validation" else "holdout-rule.json"))
    if panel["config_sha256"] != digest(config()) or rule["panel_sha256"] != digest(panel):
        raise ValueError("Decision panel does not match frozen configuration")
    if rule["source_sha256"] != digest(Path(__file__).read_text()):
        raise ValueError("Analysis changed after rule freeze")
    scope = scope_digest(out, config())
    if rule.get("exclusion_manifest_sha256") != scope:
        raise ValueError("Candidate scope changed after rule freeze")
    choices = {
        pool: {task["instance_id"]: training["baseline"] if training["active"] == "fixed" else predict(task, training, "full") for task in panel["tasks"] if task["split"] == phase}
        for pool, training in rule["pools"].items()
    }
    active = {candidate["label"] for candidate in active_candidates(out, config())}
    if any(candidate not in active for pool in choices.values() for candidate in pool.values()):
        raise ValueError("Frozen policy selects a candidate outside the authorized scope")
    artifact = {"phase": phase, "panel_sha256": digest(panel), "rule_sha256": digest(rule), "exclusion_manifest_sha256": scope, "choices": choices}
    write_frozen(out / f"{phase}-decisions.json", artifact)
    return artifact




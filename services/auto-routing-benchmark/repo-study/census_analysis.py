import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from decimal import Decimal


BOOTSTRAP_RESAMPLES = 10000
BOOTSTRAP_SEED = 73419
OPERATIONAL_STATUSES = {"provider_unavailable", "provider_refused"}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _labels(candidates):
    labels = [candidate["label"] for candidate in candidates]
    if not labels or len(labels) != len(set(labels)):
        raise ValueError("Candidate labels must be nonempty and unique")
    if any(not label.startswith(("efficient-", "frontier-")) for label in labels):
        raise ValueError("Candidates must belong to efficient or frontier")
    return labels


def _validate(tasks, candidates, results):
    labels = _labels(candidates)
    task_ids = [task["instance_id"] for task in tasks]
    if len(task_ids) != len(set(task_ids)) or any(not task.get("repo") for task in tasks):
        raise ValueError("Tasks need unique instance IDs and repository identities")
    expected = {(task_id, label) for task_id in task_ids for label in labels}
    if set(results) - expected:
        raise ValueError("Results include a task or candidate outside the panel")
    for row in results.values():
        if row is None:
            continue
        known, upper = _money(row["known"]), _money(row["upper"])
        cost = None if row.get("cost") is None else _money(row["cost"])
        if upper < known or cost is not None and (cost != known or cost != upper):
            raise ValueError("Invalid known, settled, or upper cost interval")
        elapsed = row.get("elapsed")
        if elapsed is not None and (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed < 0):
            raise ValueError("Elapsed time must be finite and nonnegative")
        caps = row.get("caps_fired", [])
        if not isinstance(caps, list) or any(not isinstance(cap, str) for cap in caps):
            raise ValueError("Cap evidence must be a list of names")
    return labels


def _money(value):
    if isinstance(value, bool):
        raise ValueError("Invalid monetary value")
    amount = Decimal(str(value))
    if not amount.is_finite() or amount < 0:
        raise ValueError("Invalid monetary value")
    return amount


def results_digest(tasks, candidates, results):
    labels = _validate(tasks, candidates, results)
    rows = [{"instance_id": task["instance_id"], "candidate": label, "result": results.get((task["instance_id"], label))} for task in tasks for label in labels]
    return _digest({"tasks": tasks, "candidates": candidates, "results": rows})


def _reason(row):
    if row is None:
        return "missing"
    status = row.get("status")
    if status in OPERATIONAL_STATUSES or status in {"infra_invalid", "missing"}:
        return status
    if status == "budget_limited":
        return None
    if type(row.get("resolved")) is not bool:
        return "missing_grade"
    if status not in {"completed", "transport_unknown", "candidate_test_timeout"}:
        return "invalid_status"
    return None


def _passed(row):
    return row.get("status") != "budget_limited" and row.get("resolved") is True


def _pools(labels):
    pools = {name: [label for label in labels if label.startswith(name + "-")] for name in ("efficient", "frontier")}
    return {**{name: arms for name, arms in pools.items() if arms}, "combined": labels}


def _comparison(tasks, arms, results):
    complete, exclusions = [], []
    for task in tasks:
        reasons = [{"candidate": label, "reason": reason} for label in arms if (reason := _reason(results.get((task["instance_id"], label)))) is not None]
        if reasons:
            exclusions.append({"instance_id": task["instance_id"], "reasons": reasons})
        else:
            complete.append(task)
    baseline = min(arms, key=lambda label: (-sum(_passed(results[(task["instance_id"], label)]) for task in complete), sum((_money(results[(task["instance_id"], label)]["known"]) for task in complete), Decimal(0)), label)) if complete else None
    rescues = []
    for task in complete:
        task_id = task["instance_id"]
        if _passed(results[(task_id, baseline)]):
            continue
        rescuers = [label for label in arms if _passed(results[(task_id, label)])]
        if rescuers:
            rescues.append({"instance_id": task_id, "baseline": baseline, "rescuers": rescuers})
    return complete, {"baseline": baseline, "complete_tasks": [task["instance_id"] for task in complete], "exclusions": exclusions, "rescues": rescues}


def confirmation_plan(tasks, candidates, results, experiment_id):
    labels = _validate(tasks, candidates, results)
    selected, comparisons = set(), {}
    for pool, arms in _pools(labels).items():
        _, comparisons[pool] = _comparison(tasks, arms, results)
        for rescue in comparisons[pool]["rescues"]:
            selected.update((rescue["instance_id"], label) for label in [rescue["baseline"], *rescue["rescuers"]])
    runs = [{"run": f"{experiment_id}--{task['instance_id']}--{label}--1", "instance_id": task["instance_id"], "repo": task["repo"], "candidate": label, "repetition": 1, "phase": "confirmation"} for task in tasks for label in labels if (task["instance_id"], label) in selected]
    plan = {"version": 1, "experiment_id": experiment_id, "first_pass_sha256": results_digest(tasks, candidates, results), "pools": comparisons, "runs": runs}
    return {**plan, "sha256": _digest(plan)}


def _metrics(rows):
    rows = [row for row in rows if row is not None]
    cognitive = [row for row in rows if _reason(row) is None]
    successes = sum(_passed(row) for row in cognitive)
    known = sum((_money(row["known"]) for row in rows), Decimal(0))
    upper = sum((_money(row["upper"]) for row in rows), Decimal(0))
    cost = known if rows and all(row.get("cost") is not None for row in rows) else None
    elapsed = [row["elapsed"] for row in rows if row.get("elapsed") is not None]
    limit_hits = sum(row.get("status") == "budget_limited" for row in cognitive)
    return {"attempts": len(rows), "completeTasks": len(cognitive), "successes": successes, "successRate": successes / len(cognitive) if cognitive else None, "limitHits": limit_hits, "limitHitRate": limit_hits / len(cognitive) if cognitive else None, "capsFired": dict(sorted(Counter(cap for row in rows for cap in set(row.get("caps_fired", []))).items())), "knownCostLowerUsd": float(known), "committedCostUpperUsd": float(upper), "totalCostUsd": float(cost) if cost is not None else None, "costPerSuccessUsd": float(cost / successes) if cost is not None and successes else None, "costPerSuccessLowerUsd": float(known / successes) if successes else None, "costPerSuccessUpperUsd": float(upper / successes) if successes else None, "meanElapsedSeconds": sum(elapsed) / len(elapsed) if elapsed else None, "statuses": dict(sorted(Counter(row.get("status", "missing") for row in rows).items()))}


def _bootstrap(observations):
    groups = defaultdict(lambda: [0, 0])
    for repo, delta in observations:
        groups[repo][0] += delta
        groups[repo][1] += 1
    if not groups:
        return None
    values = [groups[repo] for repo in sorted(groups)]
    rng = random.Random(BOOTSTRAP_SEED)
    estimates = []
    for _ in range(BOOTSTRAP_RESAMPLES):
        sample = [rng.choice(values) for _ in values]
        estimates.append(sum(value[0] for value in sample) / sum(value[1] for value in sample))
    estimates.sort()
    def percentile(fraction):
        position = (len(estimates) - 1) * fraction
        lower = math.floor(position)
        upper = math.ceil(position)
        return estimates[lower] + (estimates[upper] - estimates[lower]) * (position - lower)
    return [percentile(0.025), percentile(0.975)]


def analyze(tasks, candidates, results, confirmation_results):
    labels = _validate(tasks, candidates, results)
    _validate(tasks, candidates, confirmation_results)
    report = {"version": 1, "first_pass_sha256": results_digest(tasks, candidates, results), "bootstrap": {"resamples": BOOTSTRAP_RESAMPLES, "seed": BOOTSTRAP_SEED, "unit": "repository", "interval": "percentile", "confidence": 0.95}, "models": {label: {"firstPass": _metrics([results.get((task["instance_id"], label)) for task in tasks]), "confirmation": _metrics([confirmation_results.get((task["instance_id"], label)) for task in tasks])} for label in labels}, "pools": {}}
    for pool, arms in _pools(labels).items():
        first_pass_complete, comparison = _comparison(tasks, arms, results)
        baseline = comparison["baseline"]
        observations, confirmed, unconfirmed, confirmation_exclusions = [], [], [], []
        rescue_by_task = {row["instance_id"]: row for row in comparison["rescues"]}
        complete = []
        for task in first_pass_complete:
            task_id = task["instance_id"]
            rescue = rescue_by_task.get(task_id)
            expected = [baseline, *rescue["rescuers"]] if rescue else []
            reasons = [{"candidate": label, "reason": reason} for label in expected if (reason := _reason(confirmation_results.get((task_id, label)))) is not None]
            if reasons:
                confirmation_exclusions.append({"instance_id": task_id, "reasons": reasons})
            else:
                complete.append(task)
        comparison = {**comparison, "firstPassCompleteTasks": len(first_pass_complete), "firstPassCompleteTasksIds": comparison["complete_tasks"], "firstPassExclusions": comparison["exclusions"], "complete_tasks": [task["instance_id"] for task in complete], "exclusions": comparison["exclusions"] + confirmation_exclusions}
        baseline_successes = 0
        for task in complete:
            task_id = task["instance_id"]
            baseline_passed = _passed(results[(task_id, baseline)])
            baseline_successes += baseline_passed
            rescuers = []
            if task_id in rescue_by_task:
                rescue = rescue_by_task[task_id]
                baseline_repeat = confirmation_results[(task_id, baseline)]
                if not _passed(baseline_repeat):
                    rescuers = [label for label in rescue["rescuers"] if _passed(confirmation_results[(task_id, label)])]
                (confirmed if rescuers else unconfirmed).append({"instance_id": task_id, "baseline": baseline, "rescuers": rescuers if rescuers else rescue["rescuers"]})
            observations.append((task["repo"], int(bool(rescuers))))
        count = len(complete)
        gap = len(confirmed) / count if count else None
        interval = _bootstrap(observations)
        threshold_met = gap is not None and gap >= 0.10 and interval[0] > 0.05
        models = {label: _metrics([results[(task["instance_id"], label)] for task in complete]) for label in arms}
        biased = []
        for label in arms:
            others = [metrics["limitHitRate"] for other, metrics in models.items() if other != label and metrics["limitHitRate"] is not None]
            rate = models[label]["limitHitRate"]
            is_biased = rate is not None and rate > 0 and bool(others) and rate > 2 * sum(others) / len(others)
            models[label]["limitBiased"] = is_biased
            if is_biased:
                biased.append(label)
        report["pools"][pool] = {**comparison, "completeTasks": count, "expectedTasks": len(tasks), "repositories": len({task["repo"] for task in complete}), "status": "underpowered" if count < 45 else "complete", "underpowered": count < 45, "baselineSuccesses": baseline_successes, "baselineSuccessRate": baseline_successes / count if count else None, "confirmedOracleSuccesses": baseline_successes + len(confirmed), "confirmedOracleSuccessRate": (baseline_successes + len(confirmed)) / count if count else None, "gap": gap, "repositoryBootstrap95": interval, "gate": "GO" if threshold_met else "NO-GO", "informationOnly": pool == "combined", "confirmedRescues": confirmed, "unconfirmedRescues": unconfirmed, "confirmationExclusions": confirmation_exclusions, "confirmationComplete": not confirmation_exclusions, "limitBiased": biased, "models": models}
    return report

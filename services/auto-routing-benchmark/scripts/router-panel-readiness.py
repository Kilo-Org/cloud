"""Check frozen panel candidates in parallel, one repository per worker process.

Writes the same per-task readiness records as census_panel.readiness. The sequential
`router-panel.py readiness` command then selects the panel from these records in the frozen
seed order, so parallel checking never changes which tasks enter the panel.
"""
import argparse
import importlib.util
import json
import multiprocessing
from pathlib import Path


def load_router_panel():
    spec = importlib.util.spec_from_file_location("router_panel", Path(__file__).with_name("router-panel.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_family(arguments):
    driver_dir, out, cache, instance_ids = arguments
    panel = load_router_panel()
    driver = panel.load_driver(driver_dir)
    spec_path = panel.frozen_spec(out)
    cfg = panel.load_config(driver, out, spec_path)
    results = []
    with panel.adapter(driver, cfg), panel.github_cache(driver, cache, out):
        manifest, cfg, tasks = driver.census.check_candidates(Path(out))
        by_id = {task["instance_id"]: task for task in tasks}
        for task_id in instance_ids:
            record_path = Path(out) / "readiness-tasks" / f"{task_id}.json"
            if record_path.exists():
                record = driver.study.load(record_path)
            else:
                task = by_id[task_id]
                record = {**driver.census.readiness_task(Path(out), task, cfg), "instance_id": task_id, "family": task["family"],
                          "fixture_sha256": driver.study.digest(task), "implementation_hashes": driver.census.implementation_hashes(),
                          "candidates_sha256": driver.study.digest(manifest)}
                if not isinstance(record.get("ready"), bool) or (not record["ready"] and not record.get("rejections")):
                    raise RuntimeError("Readiness checker did not retain a terminal structural decision")
                driver.census.create_only(record_path, record)
                try:
                    removal = driver.census.remove_task_images(Path(out), task)
                except Exception as error:
                    removal = {"removed": [], "errors": [{"kind": type(error).__name__, "message": str(error)}]}
                driver.modern.private_save(Path(out) / "image-removals" / f"{task_id}.json", removal)
            results.append((task_id, record["ready"]))
            if record["ready"]:
                break
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--driver-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--github-cache", required=True)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    out = Path(args.out).resolve()
    manifest = json.loads((out / "candidates.json").read_text())
    target = json.loads((out / "router-panel-spec.json").read_text())["evaluation_panel"]["target_tasks"]
    families = manifest["families"]
    ready_index = {}
    context = multiprocessing.get_context("spawn")
    with context.Pool(args.workers, maxtasksperchild=1) as pool:
        pending, launched = {}, 0
        while True:
            ready_prefix = 0
            for index in range(launched):
                if index in pending:
                    break
                ready_prefix += ready_index.get(index, False)
            if ready_prefix >= target:
                break
            while launched < len(families) and len(pending) < args.workers:
                family = families[launched]
                pending[launched] = pool.apply_async(check_family, ((args.driver_dir, str(out), args.github_cache, family["instance_ids"]),))
                launched += 1
            if not pending:
                break
            done = next((index for index, result in pending.items() if result.ready()), None)
            if done is None:
                next(iter(pending.values())).wait(5)
                continue
            try:
                results = pending.pop(done).get()
            except Exception as error:
                ready_index[done] = False
                print(json.dumps({"family": families[done]["repo"], "index": done, "error": f"{type(error).__name__}: {error}"}), flush=True)
                continue
            ready_index[done] = any(ready for _, ready in results)
            print(json.dumps({"family": families[done]["repo"], "index": done, "results": results}), flush=True)
        for result in pending.values():
            result.wait()
    print(json.dumps({"launched": launched, "ready_families": sum(ready_index.values())}))


if __name__ == "__main__":
    main()

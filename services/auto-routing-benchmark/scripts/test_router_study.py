from decimal import Decimal
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.error
import urllib.request
from test_router_ledger import SYNTHETIC_ADDITIONAL, SYNTHETIC_BASELINE, empty_campaign, prospective_campaign

HERE = Path(__file__).resolve().parent
DRIVER = Path(os.environ.get("ROUTER_STUDY_DRIVER_DIR", str(HERE.parent / "repo-study")))
spec = importlib.util.spec_from_file_location("router_study", HERE / "router-study.py")
router_study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router_study)


def load_study():
    if not (DRIVER / "study.py").is_file():
        raise unittest.SkipTest("Set ROUTER_STUDY_DRIVER_DIR to the pinned repo-study driver")
    sys.path.insert(0, str(DRIVER))
    import study
    return study


def classifier_evidence(prompt="0.000000042", completion="0", context=262144):
    return {"requested_model": "~typesafe/jev-latest", "resolved_model": "typesafe/jev-1.13", "alias_resolution": {"source": "fixture"}, "endpoints": {"fetched_at": time.time(), "body": {"data": {"id": "typesafe/jev-1.13", "endpoints": [{"context_length": context, "pricing": {"prompt": prompt, "completion": completion}}]}}}}


def arms_spec(fixed=None):
    """Synthetic v5 arm/objective fixture pieces."""
    fixed = fixed or {mode: [{"model": "x/y", "variant": "variant=low"}] for mode in ("efficient", "frontier")}
    return {"fixed_models": fixed, "control": {"seed": "control-seed", "distribution": {mode: [{"model": fixed[mode][0]["model"], "variant": fixed[mode][0]["variant"], "weight": "1"}] for mode in fixed}, "cost_matching": {"criterion": "total-cost-ratio-vs-reference", "reference_arm": "candidate", "tolerance_fraction": "0.1"}}, "objectives": {"efficient": {"kind": "efficient-minimize-cost-preserve-success", "success_floor": {"type": "baseline-relative"}}, "frontier": {"kind": "frontier-maximize-success-within-cost", "cost_budget": {"type": "comparator-relative"}}}, "pilot_cap_usd": "60"}


def task_expectations(instance="task"):
    return {"instance_id": instance, "FAIL_TO_PASS": ["test_fix"], "PASS_TO_PASS": ["test_retained"]}


def complete_grade(resolved):
    return {"resolved": resolved, "patch_successfully_applied": True, "tests_status": {"FAIL_TO_PASS": {"success": ["test_fix"] if resolved else [], "failure": [] if resolved else ["test_fix"]}, "PASS_TO_PASS": {"success": ["test_retained"], "failure": []}}}


class FakeResponse:
    def __init__(self, body, status=200):
        self.status_code = status
        self.headers = {"Content-Type": "application/json"}
        self.body = json.dumps(body).encode()

    def iter_content(self, chunk_size):
        yield self.body

    def close(self):
        pass


class VariantResolution(unittest.TestCase):
    def test_variant_uses_frozen_catalog_and_legacy_effort_matches_gateway(self):
        catalog = {"anthropic/claude-haiku-5.5": {"max": {"reasoning": {"effort": "max"}, "verbosity": "max"}}}
        self.assertEqual(router_study.resolve_variant(catalog, "anthropic/claude-haiku-5.5", router_study.variant_label({"variant": "max"})), {"reasoning": {"effort": "max"}, "verbosity": "max"})
        self.assertEqual(router_study.resolve_variant(catalog, "x/y", router_study.variant_label({"variant": None, "reasoningEffort": "low"})), {"reasoning": {"enabled": True, "effort": "low"}})
        self.assertEqual(router_study.resolve_variant(catalog, "x/y", router_study.variant_label({"variant": None})), {})
        with self.assertRaises(ValueError):
            router_study.resolve_variant(catalog, "anthropic/claude-haiku-5.5", "variant=instant")

    def test_table_pairs_cover_every_ranked_fallback_variant_and_model(self):
        rows = [{"model": "x/y", "variant": "low"}, {"model": "x/y", "variant": "max"}, {"model": "x/y", "variant": "high"}, {"model": "z/w", "variant": "low"}, {"model": "fallback/model", "reasoningEffort": "low"}]
        table = {"routes": {"a": rows, "b": [{"model": "z/w", "reasoningEffort": "high"}]}, "effortByComplexity": {"a": {"x/y": {"low": "max", "high": "absent"}, "z/w": {"low": "low"}}}, "productionTokenProfile": {"model": "ignored"}}
        self.assertEqual(router_study.table_pairs(table), {("x/y", "variant=low"), ("x/y", "variant=max"), ("x/y", "variant=high"), ("z/w", "variant=low"), ("fallback/model", "effort=low"), ("z/w", "effort=high")})


class ClassifierQuote(unittest.TestCase):
    def test_finances_full_context_plus_fee_for_every_attempt(self):
        quote = router_study.classifier_quote(classifier_evidence(), "~typesafe/jev-latest", Decimal("0.06"))
        self.assertEqual(Decimal(quote["attempt_bound_usd"]), Decimal("0.000000042") * 262144 * Decimal("1.06"))
        self.assertEqual(quote["context_tokens"], 262144)

    def test_rejects_paid_output_and_requested_model_drift(self):
        with self.assertRaises(ValueError):
            router_study.classifier_quote(classifier_evidence(completion="0.000001"), "~typesafe/jev-latest", Decimal("0.06"))
        with self.assertRaises(ValueError):
            router_study.classifier_quote(classifier_evidence(), "typesafe/jev-1.13", Decimal("0.06"))


class SolverAvailability(unittest.TestCase):
    def test_coverage_allows_only_recorded_unavailable_reachable_pairs(self):
        expected = [["qwen/flash", "variant=thinking"], ["x/y", "variant=low"]]
        pricing = {"models": [{"model": "x/y", "effort": "variant=low"}]}
        unavailable = [{"model": "qwen/flash", "effort": "variant=thinking", "reason": router_study.ENDPOINT_UNAVAILABLE, "at": time.time()}]
        self.assertEqual(router_study.pricing_coverage(pricing, unavailable, expected), {("qwen/flash", "variant=thinking")})
        for invalid in ([], unavailable * 2, [{**unavailable[0], "model": "foreign/model"}], [{**unavailable[0], "reason": "authentication failed"}]):
            with self.subTest(unavailable=invalid), self.assertRaises(ValueError):
                router_study.pricing_coverage(pricing, invalid, expected)

    def test_quote_continues_only_for_exact_endpoint_availability_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)
            evidence = out / "evidence.json"
            evidence.write_text("{}")
            manifest = {"spec": {"classifier_fee_fraction": "0.06"}, "approval": {"model_variants": [["qwen/flash", "variant=thinking"], ["x/y", "variant=low"]], "classifier_model": "classifier"}}
            seen = []
            def catalog(folder, *, cfg):
                candidate, = cfg["candidates"]
                seen.append((candidate["model"], candidate["effort"]))
                body = {"data": {"id": candidate["model"], "endpoints": []}}
                router_study.frozen_write(folder / "pricing-endpoints" / f"{router_study.digest(body)}.json", {"body": body})
                if candidate["model"] == "qwen/flash":
                    raise RuntimeError(router_study.ENDPOINT_UNAVAILABLE)
                router_study.frozen_write(folder / "pricing.json", {"models": [candidate], "fetched_at": time.time()})
            modules = {"study": SimpleNamespace(catalog=catalog, FINANCIAL_QUOTE_POLICY="fixture"), "parity": SimpleNamespace(scheduled_tier_pricing=nullcontext)}
            classifier = {"attempt_bound_usd": "0.01"}
            def read_quote(out, batch, manifest, modules):
                return router_study.load(out / "quotes" / batch / "pricing.json"), classifier
            with mock.patch.object(router_study, "validate", return_value=(manifest, None, None)), mock.patch.object(router_study, "solver_cfg", return_value={}), mock.patch.object(router_study, "classifier_quote", return_value=classifier), mock.patch.object(router_study, "read_quote", side_effect=read_quote):
                result = router_study.quote(out, out, out, modules, "batch", evidence)
            unavailable = router_study.load(out / "quotes/batch/unavailable-pairs.json")
            self.assertEqual(seen, [("qwen/flash", "variant=thinking"), ("x/y", "variant=low")])
            self.assertEqual(result["unavailable_pairs_sha256"], router_study.digest(unavailable))
            self.assertEqual([item["model"] for item in router_study.load(out / "quotes/batch/pricing.json")["models"]], ["x/y"])
            modules["study"].catalog = mock.Mock(side_effect=RuntimeError("authentication failed"))
            with mock.patch.object(router_study, "validate", return_value=(manifest, None, None)), mock.patch.object(router_study, "solver_cfg", return_value={}), self.assertRaisesRegex(RuntimeError, "authentication failed"):
                router_study.quote(out, out, out, modules, "bad", evidence)

    def test_recorded_unavailable_selection_never_constructs_or_calls_paid_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            model = router_study.RoutedModel.__new__(router_study.RoutedModel)
            model.out, model.run = Path(temporary), "run"
            model.pricing, model.models = {}, {}
            model.unavailable = {("qwen/flash", "variant=thinking")}
            model.route = lambda messages: ("qwen/flash", "variant=thinking")
            paid = mock.Mock()
            model.modules = {"study": SimpleNamespace(save=router_study.frozen_write, paid_model=paid)}
            with self.assertRaisesRegex(router_study.ProviderUnavailable, "qwen/flash"):
                model.query([])
            paid.assert_not_called()
            self.assertEqual(router_study.load(model.out / "rollouts/run/provider-unavailable.json")["effort"], "variant=thinking")
            model.unavailable.clear()
            with self.assertRaisesRegex(RuntimeError, "outside the frozen"):
                model.query([])
            paid.assert_not_called()

    def test_provider_outage_does_not_override_unknown_charge_status(self):
        result = {"exit_status": "ProviderUnavailable"}
        census = SimpleNamespace(classify=mock.Mock(return_value="infra_invalid"))
        self.assertEqual(router_study.classify_router_result(None, "run", result, False, {"census": census}), "provider_unavailable")
        census.classify.return_value = "transport_unknown"
        self.assertEqual(router_study.classify_router_result(None, "run", result, False, {"census": census}), "transport_unknown")


class ArmExecution(unittest.TestCase):
    def fixed_model(self, temporary, pair=("x/y", "variant=low"), unavailable=()):
        model = router_study.FixedModel.__new__(router_study.FixedModel)
        model.out, model.run = Path(temporary), "run"
        model.row = {"model": pair[0], "variant": pair[1]}
        model.pair, model.model = pair, None
        model.deadline = time.monotonic() + 60
        model.cfg = {"router_phase": "final"}
        model.budget = SimpleNamespace(stopped=lambda phase: [], reserve=mock.Mock(), admission=mock.Mock(), guard=mock.Mock())
        model.pricing = {} if unavailable else {pair: {"model": pair[0], "effort": pair[1]}}
        model.unavailable = set(unavailable)
        return model

    def test_fixed_arm_uses_paid_solver_factory_with_budget_hooks(self):
        with tempfile.TemporaryDirectory() as temporary:
            model = self.fixed_model(temporary)
            solver = SimpleNamespace(query=mock.Mock(return_value={"ok": True}))
            paid = mock.Mock(return_value=solver)
            model.modules = {"study": SimpleNamespace(paid_model=paid, save=router_study.frozen_write), "census": SimpleNamespace(NativeInputBound=mock.Mock())}
            self.assertEqual(model.query([]), {"ok": True})
            _, kwargs = paid.call_args
            self.assertEqual((kwargs["reservation"], kwargs["transport_admission"], kwargs["state_guard"]), (model.budget.reserve, model.budget.admission, model.budget.guard))
            self.assertEqual(paid.call_args.args[2], {"model": "x/y", "effort": "variant=low"})

    def test_fixed_arm_unavailable_pair_never_constructs_solver(self):
        with tempfile.TemporaryDirectory() as temporary:
            model = self.fixed_model(temporary, unavailable={("x/y", "variant=low")})
            paid = mock.Mock()
            model.modules = {"study": SimpleNamespace(paid_model=paid, save=router_study.frozen_write), "census": SimpleNamespace(NativeInputBound=mock.Mock())}
            with self.assertRaises(router_study.ProviderUnavailable):
                model.query([])
            paid.assert_not_called()

    def test_selected_rows_never_drops_mandatory_final_arms(self):
        spec = {"experiment_id": "paired", "seed": "s", "repetitions": 2, "tasks": {"tuning": ["a"], "final": ["f"]}, "configurations": [{"id": "c1", "router": "efficient"}, {"id": "c2", "router": "frontier"}], **arms_spec()}
        plan = router_study.make_plan(spec, {task: {"repo": "r"} for task in ("a", "f")})
        with mock.patch.object(router_study, "final_selection", return_value={"configurations": {"efficient": "c1", "frontier": "c2"}}):
            rows = router_study.selected_rows(Path("unused"), {}, plan, "final")
        self.assertEqual(rows, [row for row in plan["runs"] if row["phase"] == "final"])
        self.assertEqual({row["arm_kind"] for row in rows}, {"router", "fixed", "control"})


class LedgerBoundaries(unittest.TestCase):
    def setUp(self):
        self.study = load_study()
        self.temporary = tempfile.TemporaryDirectory()
        self.out = Path(self.temporary.name)
        self.ledger = self.out / "budget.sqlite"
        self.ledger.symlink_to(empty_campaign(self.out))
        self.budget = router_study.Budget(self.ledger, {"study": self.study}, "100")
        self.cfg = {"router_phase": "tuning", "run_cost_limit_usd": "1000", "run_token_limit": 2 ** 63 - 1}

    def tearDown(self):
        self.temporary.cleanup()

    def activate(self, run, phase="tuning"):
        with sqlite3.connect(self.ledger) as db:
            db.execute("INSERT INTO router_runs VALUES (?,?,'active',?)", (run, phase, time.time()))

    def rows(self):
        with sqlite3.connect(self.ledger) as db:
            return self.study.request_rows(db), dict(db.execute("SELECT id,kind FROM router_requests")), db.execute("SELECT reason FROM router_stop").fetchall()

    def test_recovery_releases_only_reservations_that_never_entered_dispatch(self):
        cases = ("missing_receipt", "unused_receipt", "invalid_receipt", "admitted", "dispatched", "historical")
        requests = {}
        for run in cases:
            self.activate(run)
            if run == "historical":
                request, receipt = "historical-request", self.out / "historical-receipt.json"
                with sqlite3.connect(self.ledger) as db:
                    db.execute("INSERT INTO requests VALUES (?,?, '1',NULL,NULL,'reserved',?,1)", (request, run, str(receipt)))
            else:
                request, receipt = self.budget.reserve(self.out, run, Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
            requests[run] = request
            if run == "invalid_receipt":
                receipt.write_text("{")
            elif run != "missing_receipt":
                self.study.save(receipt, {"dispatch_entered": run == "dispatched"})
            with sqlite3.connect(self.ledger) as db:
                if run == "admitted":
                    db.execute("INSERT INTO router_dispatches VALUES (?,?,?,?)", (request, run, "a" * 64, time.time()))
        recovered = self.budget.orphan_stop()
        self.assertEqual(set(recovered["orphaned_requests"]), {requests[run] for run in ("admitted", "dispatched", "historical")})
        rows, _, _ = self.rows()
        for row in rows:
            if row["run"] in ("missing_receipt", "unused_receipt", "invalid_receipt"):
                self.assertEqual((row["state"], row["bound"], row["actual"], row["tokens"]), ("settled", "0", "0", 0))
            else:
                self.assertEqual((row["state"], row["bound"], row["actual"]), ("unknown", "1", None))
        self.assertTrue(self.budget.stopped("tuning"))
        self.assertEqual(self.budget.orphan_stop()["orphaned_requests"], [])

    def test_tuning_keeps_final_reserve_and_requires_active_run(self):
        with self.assertRaises(RuntimeError):
            self.budget.reserve(self.out, "run-a", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.activate("run-a")
        self.budget.reserve(self.out, "run-a", Decimal("149"), 1, cfg=self.cfg, ledger_out=self.out)
        with self.assertRaises(self.study.BudgetLimited) as raised:
            self.budget.reserve(self.out, "run-a", Decimal("2"), 1, cfg=self.cfg, ledger_out=self.out)
        self.assertIn("phase_money_reservation", raised.exception.diagnostics["caps"])
        self.activate("run-b", "final")
        self.budget.reserve(self.out, "run-b", Decimal("100"), 1, cfg={**self.cfg, "router_phase": "final"}, ledger_out=self.out)
        with self.assertRaises(self.study.BudgetLimited):
            self.budget.reserve(self.out, "run-b", Decimal("2"), 1, cfg={**self.cfg, "router_phase": "final"}, ledger_out=self.out)

    def unknown_request(self, run="failed"):
        self.activate(run)
        request, receipt_path = self.budget.reserve(self.out, run, Decimal("1"), 100, cfg=self.cfg, ledger_out=self.out)
        receipt = {"local_request_id": request, "run": run, "dispatch_entered": True, "generation_id": "gen-fixture", "reservation_usd": "1", "response": {"error": {"message": "Flex unavailable"}}}
        self.study.save(receipt_path, receipt)
        self.budget.settle(request, "unknown", Decimal("1"), None, None)
        with sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE router_runs SET state='stopped' WHERE run=?", (run,))
        return request

    def test_account_unknown_keeps_full_hold_audits_and_clears_only_existing_stops(self):
        request = self.unknown_request()
        with self.assertRaises(ValueError):
            router_study.clear_stop(self.out, "not yet accounted", {"study": self.study})
        evidence = self.out / "lookup.json"
        evidence.write_text(json.dumps({"url": "https://openrouter.ai/api/v1/generation?id=gen-fixture", "http_status": 404, "body": {"error": "not found"}}))
        router_study.account_unknown(self.out, request, evidence, {"study": self.study})
        rows, _, _ = self.rows()
        self.assertEqual((rows[0]["state"], rows[0]["actual"], rows[0]["bound"]), ("accounted_unknown", None, "1"))
        self.assertEqual(router_study.run_state(self.ledger, "failed"), "stopped")
        with sqlite3.connect(self.ledger) as db:
            self.assertTrue(router_study.accounted_row_valid(db, rows[0]))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM router_accounting")
        router_study.clear_stop(self.out, "retain full bound and resume other rows", {"study": self.study})
        self.assertFalse(self.budget.stopped("tuning"))
        self.activate("next")
        self.budget.reserve(self.out, "next", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.budget.stop("a later failure")
        self.assertEqual(self.budget.stopped("tuning"), ["a later failure"])

    def test_account_unknown_copies_the_exact_bytes_that_were_hashed(self):
        request = self.unknown_request()
        evidence_path = self.out / "lookup.json"
        original = json.dumps({"url": "https://openrouter.ai/api/v1/generation?id=gen-fixture", "http_status": 404, "body": {"error": "not found"}}).encode()
        evidence_path.write_bytes(original)
        writer = router_study.frozen_bytes

        def change_source_before_copy(content, destination):
            evidence_path.write_text('{"changed_after_hash": true}')
            writer(content, destination)

        with mock.patch.object(router_study, "frozen_bytes", side_effect=change_source_before_copy):
            result = router_study.account_unknown(self.out, request, evidence_path, {"study": self.study})
        stored = self.budget.ledger.parent / "accounting-evidence" / f"{result['evidence_sha256']}.json"
        self.assertEqual(stored.read_bytes(), original)
        self.assertEqual(router_study.file_hash(stored), result["evidence_sha256"])

    def test_sibling_unknown_stop_truncation_is_invalid_even_after_clearing_stop(self):
        self.activate("sibling")
        request, _ = self.budget.reserve(self.out, "sibling", Decimal("0.2"), 1, cfg=self.cfg, ledger_out=self.out)
        self.budget.settle(request, "settled", Decimal("0.2"), Decimal("0.2"), 1)
        cause = self.unknown_request("cause")
        model = router_study.RoutedModel.__new__(router_study.RoutedModel)
        model.out, model.run, model.cfg = self.out, "sibling", self.cfg
        model.deadline, model.budget = time.monotonic() + 60, self.budget
        with self.assertRaises(self.study.BudgetLimited):
            model.route([])
        with self.assertRaises(self.study.BudgetLimited):
            self.budget.reserve(self.out, "sibling", Decimal("0.2"), 1, cfg=self.cfg, ledger_out=self.out)
        with self.assertRaises(self.study.BudgetLimited):
            with self.budget.admission(self.out, "sibling", request, self.cfg):
                self.fail("A globally stopped run cannot be admitted")
        events = [router_study.load(path) for path in (self.out / "resource-limits/sibling").glob("*.json")]
        self.assertEqual(len(events), 3)
        self.assertTrue(all("recorded_stop" in event["caps"] for event in events))
        evidence = self.out / "lookup.json"
        evidence.write_text(json.dumps({"url": "https://openrouter.ai/api/v1/generation?id=gen-fixture", "http_status": 404, "body": {}}))
        router_study.account_unknown(self.out, cause, evidence, {"study": self.study})
        router_study.clear_stop(self.out, "Retain full unknown hold", {"study": self.study})
        self.assertFalse(self.budget.stopped("tuning"))
        router_study.frozen_write(self.out / "rollouts/sibling/result.json", {"status": "budget_limited", "resources": {"caps_fired": []}})
        router_study.frozen_write(self.out / "rollouts/sibling/evaluation.json", {"grade_valid": False, "reason": "budget_limited"})
        rows, kinds, _ = self.rows()
        own = [row for row in rows if row["run"] == "sibling"]
        self.assertEqual(router_study.outcome(self.out, {"run": "sibling", "instance_id": "task"}, own, kinds), (None, "global_stop_truncated"))

    def test_account_unknown_rejects_wrong_generation_evidence_and_breach(self):
        request = self.unknown_request()
        evidence = self.out / "lookup.json"
        evidence.write_text(json.dumps({"url": "https://openrouter.ai/api/v1/generation?id=other", "http_status": 404, "body": {}}))
        with self.assertRaises(ValueError):
            router_study.account_unknown(self.out, request, evidence, {"study": self.study})
        with sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE requests SET state='breach' WHERE id=?", (request,))
        with self.assertRaises(ValueError):
            router_study.account_unknown(self.out, request, evidence, {"study": self.study})
        with self.assertRaises(ValueError):
            router_study.clear_stop(self.out, "cannot clear breach", {"study": self.study})

    def test_auto_account_solver_response_aborts_only_its_own_run(self):
        self.activate("own")
        automatic = router_study.Budget(self.ledger, {"study": self.study}, "100", auto_run="own")
        request, receipt_path = automatic.reserve(self.out, "own", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.study.save(receipt_path, {"local_request_id": request, "run": "own", "dispatch_entered": True, "reservation_usd": "1", "generation_id": "gen-own", "response": {"error": {"code": 502}}})
        with automatic.guard(self.out), sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE requests SET state='unknown' WHERE id=?", (request,))
        rows, _, stops = self.rows()
        self.assertEqual((rows[0]["state"], rows[0]["actual"], rows[0]["bound"], stops), ("accounted_unknown", None, "1", []))
        with self.assertRaises(self.study.BudgetLimited):
            automatic.reserve(self.out, "own", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.activate("healthy")
        self.budget.reserve(self.out, "healthy", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)

    def test_dispatch_404_no_endpoint_writes_outage_and_classifies_provider_unavailable(self):
        self.activate("run")
        automatic = router_study.Budget(self.ledger, {"study": self.study}, "100", auto_run="run")
        pair = ("qwen/flash", "variant=thinking")
        request, receipt_path = automatic.reserve(self.out, "run", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        receipt = {"local_request_id": request, "run": "run", "dispatch_entered": True, "reservation_usd": "1", "http_status": 404, "request": {"model": pair[0]}, "router_variant": pair[1], "started_at": time.time(), "response": {"error": {"message": "No endpoints found that satisfy the max price"}}}
        self.study.save(receipt_path, receipt)
        with automatic.guard(self.out), sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE requests SET state='unknown' WHERE id=?", (request,))
        model = router_study.RoutedModel.__new__(router_study.RoutedModel)
        model.out, model.run = self.out, "run"
        model.route = lambda messages: pair
        model.models = {pair: SimpleNamespace(query=mock.Mock(side_effect=urllib.error.HTTPError("https://openrouter.ai/api/v1/chat/completions", 404, "No endpoints found", None, None)))}
        model.modules = {"study": self.study}
        with self.assertRaisesRegex(router_study.ProviderUnavailable, "HTTP404"):
            model.query([])
        outage = router_study.load(self.out / "rollouts/run/provider-unavailable.json")
        self.assertEqual((outage["model"], outage["effort"], outage["http_status"]), (*pair, 404))
        status = router_study.classify_router_result(self.out, "run", {"exit_status": "ProviderUnavailable"}, False, {"study": self.study, "census": SimpleNamespace(classify=mock.Mock(return_value="transport_unknown"))})
        self.assertEqual(status, "provider_unavailable")
        for code in (400, 401, 429, 500):
            self.study.save(receipt_path, {**receipt, "http_status": code})
            self.assertIsNone(router_study.dispatch_provider_outage(self.out, "run", pair))
        self.study.save(receipt_path, {**receipt, "response": {"error": {"message": "Not found"}, "choices": [{"message": {"content": "model content"}}]}})
        self.assertIsNone(router_study.dispatch_provider_outage(self.out, "run", pair))
        self.study.save(receipt_path, {**receipt, "response": None})
        self.assertEqual(router_study.dispatch_provider_outage(self.out, "run", pair)["http_status"], 404)
        self.activate("default-policy")
        held, _ = self.budget.reserve(self.out, "default-policy", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.budget.settle(held, "unknown", Decimal("1"), None, None)
        status = router_study.classify_router_result(self.out, "default-policy", {"exit_status": "ProviderUnavailable"}, False, {"study": self.study, "census": SimpleNamespace(classify=mock.Mock(return_value="transport_unknown"))})
        self.assertEqual(status, "provider_unavailable")
        rows, _, stops = self.rows()
        unknown = next(row for row in rows if row["id"] == held)
        self.assertEqual((unknown["state"], unknown["bound"], unknown["actual"]), ("unknown", "1", None))
        self.assertTrue(stops)

    def test_manual_accounting_accepts_documented_provider_generation_fallback(self):
        request = self.unknown_request()
        rows, _, _ = self.rows()
        receipt_path = Path(rows[0]["receipt"])
        receipt = router_study.load(receipt_path)
        generation = receipt.pop("generation_id")
        receipt.update(provider_generation_id=generation, http_status=200, response=None)
        self.study.save(receipt_path, receipt)
        evidence = self.out / "lookup.json"
        evidence.write_text(json.dumps({"url": "https://openrouter.ai/api/v1/generation?id=" + generation, "http_status": 404, "body": {"error": "not found"}}))
        router_study.account_unknown(self.out, request, evidence, {"study": self.study})
        rows, _, _ = self.rows()
        self.assertEqual((rows[0]["state"], rows[0]["actual"], rows[0]["bound"]), ("accounted_unknown", None, "1"))
        self.assertEqual(router_study.run_state(self.ledger, "failed"), "stopped")

    def test_auto_accounts_malformed_http200_for_either_documented_generation_field(self):
        for field in ("generation_id", "provider_generation_id"):
            with self.subTest(field=field):
                run = "malformed-" + field
                self.activate(run)
                automatic = router_study.Budget(self.ledger, {"study": self.study}, "100", auto_run=run)
                request, receipt_path = automatic.reserve(self.out, run, Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
                receipt = {"local_request_id": request, "run": run, "dispatch_entered": True, "reservation_usd": "1", field: "gen-malformed", "http_status": 200, "response": None}
                self.study.save(receipt_path, receipt)
                with automatic.guard(self.out), sqlite3.connect(self.ledger) as db:
                    db.execute("UPDATE requests SET state='unknown' WHERE id=?", (request,))
                rows, _, stops = self.rows()
                row = next(row for row in rows if row["id"] == request)
                self.assertEqual((row["state"], row["actual"], row["bound"], stops), ("accounted_unknown", None, "1", []))
                with sqlite3.connect(self.ledger) as db:
                    self.assertTrue(router_study.accounted_row_valid(db, row))
                    evidence_hash = db.execute("SELECT evidence_sha256 FROM router_accounting WHERE request_id=?", (request,)).fetchone()[0]
                evidence = router_study.load(self.budget.ledger.parent / "accounting-evidence" / f"{evidence_hash}.json")
                self.assertEqual((evidence["generation_id"], evidence["generation_id_field"], evidence["receipt_sha256"]), ("gen-malformed", field, router_study.digest(receipt)))
                with self.assertRaises(self.study.BudgetLimited):
                    automatic.reserve(self.out, run, Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.activate("healthy-after-malformed")
        self.budget.reserve(self.out, "healthy-after-malformed", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)

    def test_dispatched_solver_timeout_without_response_or_generation_is_accounted_only_for_its_run(self):
        self.activate("timeout")
        automatic = router_study.Budget(self.ledger, {"study": self.study}, "100", auto_run="timeout")
        request, receipt_path = automatic.reserve(self.out, "timeout", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        receipt = {"local_request_id": request, "run": "timeout", "dispatch_entered": False, "reservation_usd": "1", "request_sha256": "a" * 64, "response": None}
        self.study.save(receipt_path, receipt)
        read_timeout = type("ReadTimeout", (TimeoutError,), {})
        with automatic.admission(self.out, "timeout", request, self.cfg):
            receipt["dispatch_entered"] = True
            self.study.save(receipt_path, receipt)
            try:
                raise read_timeout("upstream read timed out")
            except read_timeout:
                with automatic.guard(self.out), sqlite3.connect(self.ledger) as db:
                    db.execute("UPDATE requests SET state='unknown' WHERE id=?", (request,))
        rows, _, stops = self.rows()
        self.assertEqual((rows[0]["state"], rows[0]["actual"], rows[0]["bound"], stops), ("accounted_unknown", None, "1", []))
        with sqlite3.connect(self.ledger) as db:
            self.assertTrue(router_study.accounted_row_valid(db, rows[0]))
            evidence_hash = db.execute("SELECT evidence_sha256 FROM router_accounting WHERE request_id=?", (request,)).fetchone()[0]
        evidence = router_study.load(self.budget.ledger.parent / "accounting-evidence" / f"{evidence_hash}.json")
        dispatched_receipt = {**receipt, "dispatch_entered": True}
        self.assertEqual((evidence["receipt_sha256"], evidence["receipt_snapshot"], evidence["generation_id"], evidence["error_type"]), (router_study.digest(dispatched_receipt), dispatched_receipt, None, "ReadTimeout"))
        with self.assertRaises(self.study.BudgetLimited):
            automatic.reserve(self.out, "timeout", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.activate("healthy")
        self.budget.reserve(self.out, "healthy", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)

    def test_automatic_accounting_preserves_observed_actual_and_full_reserved_bound(self):
        self.activate("observed")
        automatic = router_study.Budget(self.ledger, {"study": self.study}, "100", auto_run="observed")
        request, receipt_path = automatic.reserve(self.out, "observed", Decimal("1"), 1, cfg=self.cfg, ledger_out=self.out)
        self.study.save(receipt_path, {"dispatch_entered": True, "reservation_usd": "1", "response": None, "error_type": "ReadTimeout"})
        with automatic.guard(self.out), sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE requests SET state='unknown',actual='0.2' WHERE id=?", (request,))
        rows, _, stops = self.rows()
        self.assertEqual((rows[0]["state"], rows[0]["actual"], rows[0]["bound"], stops), ("accounted_unknown", "0.2", "1", []))
        self.assertEqual(self.study.held_cost(rows[0]), Decimal("1"))

    def test_auto_policy_never_accounts_breach_reserved_or_never_dispatched_unknown(self):
        with sqlite3.connect(self.ledger) as db:
            for index, (state, dispatched) in enumerate((("breach", True), ("reserved", True), ("unknown", False))):
                request = f"rejected-{index}"
                db.execute("INSERT INTO requests VALUES (?,?,?,NULL,NULL,?,?,?)", (request, "run", "1", state, "unused", 1))
                db.execute("INSERT INTO router_requests VALUES (?,'solver')", (request,))
                row = next(row for row in self.study.request_rows(db) if row["id"] == request)
                self.assertFalse(router_study.automatic_account(db, row, {"dispatch_entered": dispatched, "reservation_usd": "1"}, self.out))
            self.assertFalse(db.execute("SELECT 1 FROM router_accounting").fetchone())

    def test_generation_fallback_cannot_replace_invalid_primary_or_use_arbitrary_fields(self):
        self.assertEqual(router_study.receipt_generation({"provider_generation_id": "gen-provider"}), ("gen-provider", "provider_generation_id"))
        self.assertIsNone(router_study.receipt_generation({"generation_id": "invalid", "provider_generation_id": "gen-provider"})[0])
        self.assertIsNone(router_study.receipt_generation({"some_other_generation_id": "gen-other"})[0])

    def test_concurrent_process_reservations_never_exceed_aggregate_cap(self):
        worker = """
from decimal import Decimal
import importlib.util
from pathlib import Path
import sys
import time
spec = importlib.util.spec_from_file_location('router_study', sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
sys.path.insert(0, sys.argv[2])
import study
out, run = Path(sys.argv[3]), sys.argv[4]
budget = adapter.Budget(out / 'budget.sqlite', {'study': study}, '100')
cfg = {'router_phase': 'final', 'run_cost_limit_usd': '1000', 'run_token_limit': 2**63-1}
while time.monotonic() < float(sys.argv[5]):
    time.sleep(0.001)
admitted = 0
for _ in range(100):
    try:
        budget.reserve(out, run, Decimal('1'), 1, cfg=cfg, ledger_out=out)
        admitted += 1
    except study.BudgetLimited:
        break
print(admitted)
"""
        start = time.monotonic() + 2
        processes = []
        for index in range(8):
            run = f"parallel-{index}"
            self.activate(run, "final")
            processes.append(subprocess.Popen([sys.executable, "-c", worker, str(HERE / "router-study.py"), str(DRIVER), str(self.out), run, str(start)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        admitted = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=60)
            self.assertEqual(process.returncode, 0, stderr)
            admitted.append(int(stdout))
        rows, kinds, _ = self.rows()
        self.assertEqual(sum(admitted), 250)
        self.assertEqual(len(rows), 250)
        self.assertEqual(sum((self.study.held_cost(row) for row in rows), Decimal(0)), Decimal("250"))
        self.assertEqual(len(kinds), 250)

    def broker_post(self, broker, run):
        request = urllib.request.Request(broker.url + "/api/v1/systemone", data=json.dumps({"model": "~typesafe/jev-latest", "state": {}, "questions": []}).encode(), headers={"Content-Type": "application/json", "X-Benchmark-Run": run})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_broker_reserves_before_dispatch_and_settles_byok_fee_plus_upstream(self):
        quote = router_study.classifier_quote(classifier_evidence(), "~typesafe/jev-latest", Decimal("0.06"))
        body = {"model": "typesafe/jev-1.13", "answers": [1], "usage": {"cost": 0.00005, "is_byok": True, "cost_details": {"upstream_inference_cost": 0.001}, "input_tokens": 900, "output_tokens": 3}}
        seen = []

        def transport(url, **options):
            rows, _, _ = self.rows()
            seen.append(([row["state"] for row in rows], url, options["headers"]["Authorization"]))
            return FakeResponse(body)

        self.activate("run-a")
        self.budget.active["run-a"] = (self.cfg, time.monotonic() + 60)
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "host-only-test-key"}), router_study.ClassifierBroker(self.budget, quote, self.out, transport=transport) as broker:
            status, returned = self.broker_post(broker, "run-a")
        self.assertEqual((status, json.loads(returned)), (200, body))
        self.assertEqual(seen, [(["reserved"], "https://openrouter.ai/api/v1/systemone", "Bearer host-only-test-key")])
        rows, kinds, stops = self.rows()
        self.assertEqual((rows[0]["state"], Decimal(rows[0]["actual"]), rows[0]["tokens"], kinds[rows[0]["id"]], stops), ("settled", Decimal("0.00105"), 903, "classifier", []))
        self.assertNotIn("host-only-test-key", Path(rows[0]["receipt"]).read_text())

    def test_unknown_classifier_charge_holds_bound_and_stops_all_dispatch(self):
        quote = router_study.classifier_quote(classifier_evidence(), "~typesafe/jev-latest", Decimal("0.06"))
        self.activate("run-a")
        self.budget.active["run-a"] = (self.cfg, time.monotonic() + 60)
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "host-only-test-key"}), router_study.ClassifierBroker(self.budget, quote, self.out, transport=lambda url, **options: FakeResponse({"error": {"message": "overloaded"}}, 503)) as broker:
            status, _ = self.broker_post(broker, "run-a")
            unknown_run_status, _ = self.broker_post(broker, "run-unknown")
        rows, _, stops = self.rows()
        self.assertEqual((status, unknown_run_status, len(rows), rows[0]["state"], Decimal(rows[0]["bound"])), (503, 503, 1, "unknown", Decimal(quote["attempt_bound_usd"])))
        self.assertTrue(stops)
        with self.assertRaises(self.study.BudgetLimited):
            self.budget.reserve(self.out, "run-a", Decimal("0.01"), 1, cfg=self.cfg, ledger_out=self.out)

    def test_classifier_ambiguous_billing_retains_full_holds_and_known_charge_floors(self):
        quote = router_study.classifier_quote(classifier_evidence(), "~typesafe/jev-latest", Decimal("0.06"))
        cases = [({}, "unknown", None, Decimal(0)), ({"is_byok": None}, "unknown", None, Decimal(0)), ({"is_byok": "false"}, "unknown", None, Decimal(0)), ({"is_byok": 0}, "unknown", None, Decimal(0)), ({"is_byok": True}, "unknown", None, Decimal(0)), ({"is_byok": True, "cost": "2"}, "breach", None, Decimal("2")), ({"is_byok": False, "cost": 0}, "settled", Decimal(0), Decimal(0))]
        for update, state, actual, floor in cases:
            with self.subTest(update=update), tempfile.TemporaryDirectory() as temporary:
                out = Path(temporary)
                ledger = out / "budget.sqlite"
                ledger.symlink_to(empty_campaign(out))
                budget = router_study.Budget(ledger, {"study": self.study}, "100")
                with sqlite3.connect(ledger) as db:
                    db.execute("INSERT INTO router_runs VALUES ('run','tuning','active',0)")
                budget.active["run"] = (self.cfg, time.monotonic() + 60)
                body = {"model": "typesafe/jev-1.13", "usage": {"cost": 0.00005, "input_tokens": 1, "output_tokens": 0, **update}}
                with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "fixture-only"}), router_study.ClassifierBroker(budget, quote, out, transport=lambda url, **options: FakeResponse(body)) as broker:
                    status, _ = self.broker_post(broker, "run")
                with sqlite3.connect(ledger) as db:
                    row, = self.study.request_rows(db)
                self.assertEqual((status, row["state"], None if row["actual"] is None else Decimal(row["actual"])), (200 if state == "settled" else 503, state, actual))
                self.assertEqual(Decimal(row["bound"]), max(Decimal(quote["attempt_bound_usd"]), floor))
                self.assertEqual(bool(budget.stopped("tuning")), state != "settled")

    def test_auto_policy_still_stops_classifier_transport_without_response(self):
        quote = router_study.classifier_quote(classifier_evidence(), "~typesafe/jev-latest", Decimal("0.06"))
        self.activate("run-a")
        self.budget.active["run-a"] = ({**self.cfg, "unknown_charge_policy": "account-full-bound-abort-run"}, time.monotonic() + 60)
        def failed_transport(url, **options):
            raise ConnectionError("No response")
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "host-only-test-key"}), router_study.ClassifierBroker(self.budget, quote, self.out, transport=failed_transport) as broker:
            status, _ = self.broker_post(broker, "run-a")
        rows, _, stops = self.rows()
        self.assertEqual((status, rows[0]["state"], rows[0]["actual"]), (503, "unknown", None))
        self.assertTrue(stops)



class RuntimeEnvironment(unittest.TestCase):
    def test_child_spawn_allows_only_explicit_safe_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot = root / "snapshot.json"
            snapshot.write_text("{}")
            command = ["/pinned/node", "bootstrap", "--prepared-execution", "{prepared_execution}", "--snapshot", "{snapshot}", "--broker-url", "{broker_url}", "--port", "{port}"]
            identity = {"serving_argv": command, "host": {"workerRoot": str(root)}}
            health = {"snapshotSha256": router_study.file_hash(snapshot)}
            proof = SimpleNamespace(execution_identity=mock.Mock(return_value=identity), verify_runtime_health=mock.Mock())
            process = mock.Mock(pid=42)
            process.poll.return_value = None
            process.wait.return_value = 0
            safe = {"PATH": "/fixture/bin", "HOME": "/fixture/home", "TMPDIR": str(root), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
            ambient = {key: "must-not-reach-child" for key in ("OPENROUTER_API_KEY", "KILO_API_KEY", "DATABASE_URL", "POSTGRES_URL", "PRODUCTION_BINDING", "CLOUDFLARE_ACCOUNT_ID", "SHELL", "NODE_OPTIONS", "NODE_PATH", "TSX_TSCONFIG_PATH", "TSX_DISABLE_CACHE", "MINIFLARE_WORKERD_AUTOGATES", "MINIFLARE_WORKERD_CONFIG_DEBUG", "HTTP_PROXY", "ALL_PROXY", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD")}
            with mock.patch.dict(os.environ, {**safe, **ambient}, clear=True), mock.patch.object(router_study, "helper", return_value=proof), mock.patch.object(router_study.subprocess, "Popen", return_value=process) as spawn, mock.patch.object(router_study, "runtime_json", return_value=health), mock.patch.object(router_study.os, "killpg"):
                with router_study.runtime_process(command, snapshot, "http://127.0.0.1:1234", 18792, root / "prepared", identity, root / "health.json", health["snapshotSha256"]) as origin:
                    self.assertEqual(origin, "http://127.0.0.1:18792")
            spawn.assert_called_once()
            self.assertEqual(spawn.call_args.kwargs["env"], safe)
            self.assertEqual(spawn.call_args.kwargs["cwd"], str(root))
            self.assertNotIn("shell", spawn.call_args.kwargs)
            self.assertEqual(spawn.call_args.args[0], ["/pinned/node", "bootstrap", "--prepared-execution", str(root / "prepared"), "--snapshot", str(snapshot), "--broker-url", "http://127.0.0.1:1234", "--port", "18792"])
            proof.verify_runtime_health.assert_called_once_with(health, identity)
            self.assertEqual(router_study.load(root / "health.json"), health)


class PinnedDriverAdapters(unittest.TestCase):
    def setUp(self):
        self.study = load_study()
        self.evaluation = importlib.import_module("modern_eval")
        self.assertEqual(Path(self.evaluation.__file__).resolve().parent, DRIVER.resolve())
        self.modules = {"study": self.study, "modern_panel": self.evaluation.modern_panel}

    def test_real_pinned_grade_accepts_tuple_receipt_after_one_canonical_evaluation(self):
        task = task_expectations()
        for resolved in (True, False):
            with self.subTest(resolved=resolved):
                receipt = {"result": ({"metadata": "unchanged"}, {"task": complete_grade(resolved)}), "receipt_id": "same-evaluation"}
                original_summary = self.study.resource_summary
                with mock.patch.object(self.modules["modern_panel"], "evaluate", return_value=receipt) as evaluate:
                    with router_study.driver_adapters(self.modules):
                        grade = self.evaluation.grade(Path("unused"), task, "run", "existing patch")
                    evaluate.assert_called_once_with(Path("unused"), task, "run", "existing patch")
                self.assertTrue(grade["grade_valid"])
                self.assertEqual(grade["result"][1]["task"]["resolved"], resolved)
                self.assertEqual(grade["receipt_id"], "same-evaluation")
                self.assertIsInstance(grade["result"], list)
                self.assertIsInstance(receipt["result"], tuple)
                self.assertIs(self.study.resource_summary, original_summary)

    def test_real_pinned_grade_preserves_grader_errors_without_retry(self):
        with mock.patch.object(self.modules["modern_panel"], "evaluate", side_effect=TimeoutError("Test timed out after contention")) as evaluate:
            with router_study.driver_adapters(self.modules):
                grade = self.evaluation.grade(Path("unused"), {"instance_id": "task"}, "run", "existing patch")
            evaluate.assert_called_once()
        self.assertFalse(grade["grade_valid"])
        self.assertEqual(grade["reason"], "grader_infra_invalid")
        self.assertEqual(grade["error"]["kind"], "TimeoutError")
        self.assertIn("Test timed out", grade["error"]["message"])

    def test_summary_matches_pinned_known_usage_and_retains_unknown_breach_caps(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)
            ledger = empty_campaign(out)
            (out / "budget.sqlite").symlink_to(ledger)
            cfg = {**self.study.config(), "http_request_timeout_seconds": 600}
            paths = []
            for request_id in ("a", "b"):
                path = out / "receipts" / f"{request_id}.json"
                self.study.save(path, {"input_token_bound": 7, "reservation_usd": "1", "response": {"usage": {"prompt_tokens": 2, "completion_tokens": 3, "cost": 0.2}}, "token_estimate_overrun": request_id == "b"})
                paths.append(path)
                with sqlite3.connect(ledger) as db:
                    db.execute("INSERT INTO requests VALUES (?, 'run','1','0.2',5,'settled',?,7)", (request_id, str(path)))
            result = {"exit_status": "LimitsExceeded", "message": "ActionTimeLimited WallTimeLimited"}
            self.study.save(out / "resource-limits/run/event.json", {"caps": ["run_money_reservation"]})
            expected = self.study.resource_summary(out, out, "run", cfg, result, wall_exhausted=True)
            with router_study.driver_adapters(self.modules):
                self.assertEqual(self.study.resource_summary(out, out, "run", cfg, result, wall_exhausted=True), expected)
                for index, path in enumerate(paths):
                    receipt = router_study.load(path)
                    receipt["response"] = None if index == 0 else {"usage": None}
                    self.study.save(path, receipt)
                with sqlite3.connect(ledger) as db:
                    db.execute("UPDATE requests SET state='unknown',actual=NULL,tokens=NULL WHERE id='a'")
                    db.execute("UPDATE requests SET state='breach',actual='3',tokens=NULL WHERE id='b'")
                    rows_before = self.study.request_rows(db)
                bytes_before = [path.read_bytes() for path in paths]
                summary = self.study.resource_summary(out, out, "run", cfg, result, wall_exhausted=True)
                self.assertEqual(summary["native_prompt_tokens"], [None, None])
                self.assertEqual(summary["native_completion_tokens"], [None, None])
                self.assertEqual(summary["native_cost_usd"], [None, None])
                self.assertEqual(summary["missing_native_usage_requests"], 2)
                self.assertEqual(summary["settled_plus_held_usd"], "4")
                self.assertEqual(summary["settled_plus_held_tokens"], 14)
                self.assertEqual(summary["token_estimate_overruns"], 1)
                self.assertEqual(summary["request_ids"], ["a", "b"])
                self.assertEqual(summary["caps_fired"], sorted(["run_money_reservation", "agent_step_limit", "wall_timeout", "action_timeout", "provider_money_or_token_bound_breach"]))
                self.assertEqual(bytes_before, [path.read_bytes() for path in paths])
                with sqlite3.connect(ledger) as db:
                    self.assertEqual(self.study.request_rows(db), rows_before)


class ProspectiveBudget(unittest.TestCase):
    FINANCE_CFG = {"run_cost_limit_usd": "3", "step_limit": 2, "max_input_tokens": 100, "max_output_tokens": 10, "wall_seconds": 1800, "action_timeout_seconds": 180}

    def fixture(self, root, additional=SYNTHETIC_ADDITIONAL):
        ledger, _ = prospective_campaign(root, additional=additional)
        out = root / "study"
        configs = [{"id": mode, "router": mode} for mode in ("efficient", "frontier")]
        spec = {"prospective_grant_id": "bounded-two", "campaign_ledger": str(ledger), "experiment_id": "bounded", "seed": "frozen", "repetitions": 2, "tasks": {"tuning": ["pilot-task"], "final": ["holdout"]}, "configurations": configs, "classifier_fee_fraction": "0.06", "resources": {}, **arms_spec()}
        manifest = {"version": router_study.SPEC_VERSION, "out_root": str(out), "spec": spec, "approval": {"execution_identity": {version: {"executableSha256": "bundle"} for version in ("baseline", "candidate")}, "mode_pools": {mode: [["x/y", "variant=low"]] for mode in ("efficient", "frontier")}}}
        candidates = []
        for item in configs:
            snapshot = {"baseline": {"real": True}, "candidate": {"mode": item["router"]}}
            router_study.frozen_write(out / "snapshots" / f"{item['id']}.json", snapshot)
            candidates.append({"router": item["router"], "executableSha256": "bundle", "config": snapshot["candidate"]})
        router_study.frozen_write(out / "variant-catalog.json", {"x/y": {"low": {"reasoning": {"effort": "low"}}}})
        account_policy = {"source": "fixture-account-export", "captured_at": time.time(), "raw_sha256": "0" * 64, "default_plugins": []}
        router_study.frozen_write(out / "account-policy.json", account_policy)
        plan = router_study.make_plan(spec, {task: {"repo": "repo"} for task in ("pilot-task", "holdout")})
        manifest["approval"].update(execution_plan_sha256=router_study.digest(plan), account_policy_sha256=router_study.file_hash(out / "account-policy.json"))
        spec["account_policy"] = str(out / "account-policy.json")
        router_study.frozen_write(out / "execution-plan.json", plan)
        router_study.frozen_write(out / router_study.MANIFEST, manifest)
        (out / "budget.sqlite").symlink_to(ledger)
        with sqlite3.connect(ledger) as db:
            db.execute("BEGIN IMMEDIATE")
            router_study.CAMPAIGN.register(db, manifest, candidates)
        return ledger, out, manifest, plan

    def quote(self, prompt, completion):
        endpoints = [{"tag": "fixture", "status": 0, "context_length": 1000, "max_prompt_tokens": 100, "max_completion_tokens": 10, "supported_parameters": ["reasoning", "max_tokens"], "pricing": {"prompt": str(prompt), "completion": str(completion)}}]
        return router_study.text_tariffs.endpoint_quote(endpoints, {**self.FINANCE_CFG, "byok_fee_ceiling_fraction": "0.06", "candidate": {"model": "x/y", "effort": "variant=low"}, "variant_catalog": {"x/y": {"low": {"reasoning": {"effort": "low"}}}}, "model_architecture": {"output_modalities": ["text"]}})

    def financing(self, manifest, plan, prompt="0.0004", completion="0.001", classifier="0.01"):
        quote = self.quote(prompt, completion)
        pricing = {"models": [{"model": "x/y", "effort": "variant=low", "model_architecture": {"output_modalities": ["text"]}, "financial_quote": quote}], "unavailable_pairs": []}
        with mock.patch.object(router_study, "verified_classifier_attempts", return_value=2):
            return router_study.build_financing(manifest, plan, pricing, {"attempt_bound_usd": classifier}, self.FINANCE_CFG)

    def register_financing(self, ledger, financing):
        with sqlite3.connect(ledger) as db:
            db.execute("BEGIN IMMEDIATE")
            return router_study.CAMPAIGN.register_financing(db, financing)

    def test_read_quote_rejects_path_traversal_batch(self):
        with self.assertRaisesRegex(ValueError, "Unsafe batch identity"):
            router_study.read_quote(Path("unused"), "../escape", {}, {})

    def test_no_paid_claim_before_whole_plan_cost_forecast_is_registered(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, out, manifest, plan = self.fixture(Path(temporary))
            budget = router_study.Budget(ledger, {"study": load_study()})
            self.assertEqual(budget.allowance("pilot"), Decimal(SYNTHETIC_BASELINE) + Decimal(SYNTHETIC_ADDITIONAL))
            self.assertEqual(budget.allowance("final"), budget.allowance("pilot"))
            self.assertEqual(budget.claim(plan["runs"][0], manifest, {"run_cost_limit_usd": "3"}), "cost_forecast_missing")
            self.assertIsNone(router_study.run_state(ledger, plan["runs"][0]["run"]))

    def test_admission_records_run_cap_without_reserving_it_and_never_resets_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, out, manifest, plan = self.fixture(Path(temporary))
            financing = self.financing(manifest, plan)
            self.register_financing(ledger, financing)
            budget = router_study.Budget(ledger, {"study": load_study()}, financing=financing)
            self.assertLess(Decimal(financing["pilot_envelope_usd"]), Decimal("60"))
            for row in plan["runs"][:2]:
                self.assertIsNone(budget.claim(row, manifest, {"run_cost_limit_usd": "3"}))
            with sqlite3.connect(ledger) as db:
                recorded = dict(db.execute("SELECT run,maximum_usd FROM campaign_admissions"))
                self.assertEqual(recorded, {row["run"]: "3" for row in plan["runs"][:2]})
                self.assertEqual(db.execute("SELECT COUNT(*) FROM requests WHERE id!='historical-held'").fetchone()[0], 0)
                db.execute("UPDATE router_runs SET state='finished'")
                self.assertEqual(db.execute("SELECT state,bound FROM requests WHERE id='historical-held'").fetchone(), ("unknown", SYNTHETIC_BASELINE))
            fixed = next(row for row in plan["runs"] if row["arm_kind"] == "fixed")
            control = next(row for row in plan["runs"] if row["arm_kind"] == "control")
            with mock.patch.object(router_study, "final_selection", return_value={"configurations": {"efficient": "efficient", "frontier": "frontier"}}):
                self.assertIsNone(budget.claim(fixed, manifest, {"run_cost_limit_usd": "3"}))
                self.assertIsNone(budget.claim(control, manifest, {"run_cost_limit_usd": "3"}))
                self.assertEqual(budget.claim(fixed, manifest, {"run_cost_limit_usd": "3"}), "never_retry_content_attempt")

    def test_forecast_above_allowance_registers_and_still_requires_registration(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, out, manifest, plan = self.fixture(Path(temporary))
            oversubscribed = self.financing(manifest, plan, prompt="0.005", completion="0.01", classifier="0")
            self.assertGreater(Decimal(oversubscribed["total_envelope_usd"]), Decimal(SYNTHETIC_ADDITIONAL))
            budget = router_study.Budget(ledger, {"study": load_study()})
            self.assertEqual(budget.claim(plan["runs"][0], manifest, {"run_cost_limit_usd": "3"}), "cost_forecast_missing")
            result = self.register_financing(ledger, oversubscribed)
            self.assertTrue(result["fits"])
            self.assertTrue(result["forecast_exceeds_allowance"])
            with sqlite3.connect(ledger) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM campaign_financing_plans").fetchone()[0], 1)
            funded = router_study.Budget(ledger, {"study": load_study()}, financing=oversubscribed)
            self.assertIsNone(funded.claim(plan["runs"][0], manifest, {"run_cost_limit_usd": "3"}))
            small_pilot = json.loads(json.dumps(manifest))
            small_pilot["spec"]["pilot_cap_usd"] = "1"
            pilot_forecast = self.financing(small_pilot, plan, prompt="0.005", completion="0.01", classifier="0")
            self.assertGreater(Decimal(pilot_forecast["pilot_envelope_usd"]), Decimal("1"))

    def test_reserve_releases_unused_hold_after_settlement_and_holds_unknowns(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, out, manifest, plan = self.fixture(Path(temporary))
            study = load_study()
            financing = self.financing(manifest, plan)
            self.register_financing(ledger, financing)
            budget = router_study.Budget(ledger, {"study": study}, financing=financing)
            row = next(item for item in plan["runs"] if item["phase"] == "final" and item["arm_kind"] == "fixed")
            with mock.patch.object(router_study, "final_selection", return_value={"configurations": {"efficient": "efficient", "frontier": "frontier"}}):
                self.assertIsNone(budget.claim(row, manifest, {"run_cost_limit_usd": "3"}))
            cfg = {"router_phase": "final", "run_cost_limit_usd": "3", "run_token_limit": 100}
            first, _ = budget.reserve(out, row["run"], Decimal("3"), 1, cfg=cfg, ledger_out=out)
            with self.assertRaises(study.BudgetLimited) as caught:
                budget.reserve(out, row["run"], Decimal("0.01"), 1, cfg=cfg, ledger_out=out)
            self.assertIn("run_money_reservation", caught.exception.diagnostics["caps"])
            budget.settle(first, "settled", Decimal("3"), Decimal("0.5"), 1)
            second, _ = budget.reserve(out, row["run"], Decimal("2.5"), 1, cfg=cfg, ledger_out=out)
            with sqlite3.connect(ledger) as db:
                db.execute("UPDATE requests SET state='unknown' WHERE id=?", (second,))
            with self.assertRaises(study.BudgetLimited):
                budget.reserve(out, row["run"], Decimal("0"), 1, cfg=cfg, ledger_out=out)
            with router_study.CAMPAIGN.readonly(ledger) as db:
                liability = router_study.CAMPAIGN.plan_liability(db)
                self.assertEqual(liability["settled_plus_held_usd"], Decimal(SYNTHETIC_BASELINE) + Decimal("3"))
                self.assertEqual(db.execute("SELECT state,bound FROM requests WHERE id='historical-held'").fetchone(), ("unknown", SYNTHETIC_BASELINE))

    def test_global_pilot_and_run_ceilings_block_independently_and_atomically(self):
        study = load_study()
        for ceiling in ("global", "pilot", "run"):
            with self.subTest(ceiling=ceiling), tempfile.TemporaryDirectory() as temporary:
                ledger, out, manifest, plan = self.fixture(Path(temporary), additional="100")
                financing = self.financing(manifest, plan)
                self.register_financing(ledger, financing)
                budget = router_study.Budget(ledger, {"study": study}, financing=financing)
                claim_cfg = {"run_cost_limit_usd": "60"}
                if ceiling == "run":
                    row = next(item for item in plan["runs"] if item["phase"] == "final" and item["arm_kind"] == "fixed")
                    with mock.patch.object(router_study, "final_selection", return_value={"configurations": {"efficient": "efficient", "frontier": "frontier"}}):
                        self.assertIsNone(budget.claim(row, manifest, {"run_cost_limit_usd": "1000"}))
                    cfg = {"router_phase": "final", "run_cost_limit_usd": "1000", "run_token_limit": 100}
                    with sqlite3.connect(ledger) as db:
                        before = db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
                    with self.assertRaises(study.BudgetLimited) as caught:
                        budget.reserve(out, row["run"], Decimal("61"), 1, cfg=cfg, ledger_out=out)
                    self.assertIn("run_money_reservation", caught.exception.diagnostics["caps"])
                    self.assertNotIn("phase_money_reservation", caught.exception.diagnostics["caps"])
                elif ceiling == "pilot":
                    rows = plan["runs"][:2]
                    for row in rows:
                        self.assertIsNone(budget.claim(row, manifest, claim_cfg))
                    cfg = {"router_phase": "pilot", "run_cost_limit_usd": "60", "run_token_limit": 100}
                    budget.reserve(out, rows[0]["run"], Decimal("60"), 1, cfg=cfg, ledger_out=out)
                    with sqlite3.connect(ledger) as db:
                        before = db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
                    with self.assertRaises(study.BudgetLimited) as caught:
                        budget.reserve(out, rows[1]["run"], Decimal("1"), 1, cfg=cfg, ledger_out=out)
                    self.assertIn("pilot_cap_reservation", caught.exception.diagnostics["caps"])
                    self.assertNotIn("phase_money_reservation", caught.exception.diagnostics["caps"])
                else:
                    rows = [item for item in plan["runs"] if item["phase"] == "final" and item["arm_kind"] == "fixed"][:2]
                    with mock.patch.object(router_study, "final_selection", return_value={"configurations": {"efficient": "efficient", "frontier": "frontier"}}):
                        for row in rows:
                            self.assertIsNone(budget.claim(row, manifest, claim_cfg))
                    cfg = {"router_phase": "final", "run_cost_limit_usd": "60", "run_token_limit": 100}
                    budget.reserve(out, rows[0]["run"], Decimal("60"), 1, cfg=cfg, ledger_out=out)
                    with sqlite3.connect(ledger) as db:
                        before = db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
                    with self.assertRaises(study.BudgetLimited) as caught:
                        budget.reserve(out, rows[1]["run"], Decimal("41"), 1, cfg=cfg, ledger_out=out)
                    self.assertIn("phase_money_reservation", caught.exception.diagnostics["caps"])
                    self.assertNotIn("run_money_reservation", caught.exception.diagnostics["caps"])
                with sqlite3.connect(ledger) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM requests").fetchone()[0], before)

    def pilot_fixture(self, root):
        ledger, out, registered, plan = self.fixture(root)
        panel = root / "panel"
        router_study.frozen_write(panel / "evaluator/tasks.json", [task_expectations("pilot-task")])
        manifest = {**registered, "panel_root": str(panel)}
        (out / router_study.MANIFEST).write_text(json.dumps(manifest))
        observations, files = [], {}
        for row in plan["runs"][:2]:
            request_id = row["run"] + "-solver"
            folder = out / "rollouts" / row["run"]
            for name, value in (("result.json", {"status": "completed", "exit_status": "Submitted"}), ("evaluation.json", {"grade_valid": True, "result": [None, {"pilot-task": complete_grade(False)}]}), ("approval.json", {"authorized": True})):
                path = folder / name
                router_study.frozen_write(path, value)
                files[str(path)] = router_study.file_hash(path)
            receipt = out / "receipts" / f"{request_id}.json"
            router_study.frozen_write(receipt, {"local_request_id": request_id, "run": row["run"]})
            health = out / "runtime-health" / f"{row['run']}.json"
            router_study.frozen_write(health, {"snapshotSha256": "frozen"})
            files.update({str(path): router_study.file_hash(path) for path in (receipt, health)})
            request = {"request_id": request_id, "run": row["run"], "text_parser": {"accepted": True}, "native_calls_present": False, "native_markup_present": False, "request_declares_tools": False, "category": "text_action_accepted"}
            observations.append({**{key: row[key] for key in ("run", "router", "instance_id", "configuration", "repetition")}, "requests": [request], "status": "completed", "exit_status": "Submitted", "resolved": False, "cost_usd": "0.1"})
            with sqlite3.connect(ledger) as db:
                db.execute("INSERT INTO router_runs VALUES (?, 'pilot', 'finished',0)", (row["run"],))
                db.execute("INSERT INTO requests VALUES (?,?, '0.2','0.1',1,'settled',?,1)", (request_id, row["run"], str(receipt)))
                db.execute("INSERT INTO router_requests VALUES (?, 'solver')", (request_id,))
        parser = {"revision": router_study.helper("router-replay").MINI_REVISION, "files": {"parser.py": "hash"}, "model_settings": {}, "action_regex": "bash"}
        evidence = {"schema": "router-baseline-protocol-pilot-v1", "manifest_sha256": router_study.digest(manifest), "execution_plan_sha256": router_study.digest(plan), "prospective_grant_id": "bounded-two", "passed": True, "runs": [row["run"] for row in plan["runs"][:2]], "parser": parser, "evidence_files": files, "failures": [], "observations": observations, "total_cost_usd": "0.2"}
        evidence_path = root / "pilot.json"
        evidence_path.write_text(json.dumps(evidence))
        return ledger, out, manifest, plan, evidence_path, evidence

    def test_completed_protocol_pilot_cannot_establish_quality_or_cost_claims(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, out, manifest, plan, path, evidence = self.pilot_fixture(Path(temporary))
            manifest["approval"]["snapshot_file_sha256"] = {mode: "frozen" for mode in ("efficient", "frontier")}
            proof = SimpleNamespace(verify_runtime_health=mock.Mock())
            original_helper = router_study.helper
            with mock.patch.object(router_study, "helper", side_effect=lambda name: proof if name == "router-proof" else original_helper(name)):
                report = router_study.analyze(out, manifest, plan, "pilot", {"study": load_study()})
            self.assertTrue(report["plan_complete"])
            self.assertFalse(report["can_establish_pass"])
            self.assertFalse(report["can_establish_superiority"])
            self.assertFalse(report["can_establish_cost_matching"])

    def test_semantic_pilot_failure_with_valid_grade_allows_hash_bound_final_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, out, manifest, plan, path, evidence = self.pilot_fixture(Path(temporary))
            self.assertEqual(router_study.validate_pilot_evidence(out, manifest, plan, path), evidence)
            approval = {"authorized": True, "action": "select-final-router-study-v5", "manifest_sha256": router_study.digest(manifest), "prospective_grant_id": "bounded-two", "pilot_evidence_sha256": router_study.digest(evidence), "pilot_evidence_file_sha256": router_study.file_hash(path), "configurations": {"efficient": "efficient", "frontier": "frontier"}}
            router_study.select_final(out, manifest, plan, approval, {}, path)
            self.assertEqual(router_study.final_selection(out, manifest), approval)
            path_in_out = out / "pilot-evidence.json"
            path_in_out.write_text(path_in_out.read_text() + " ")
            with self.assertRaisesRegex(ValueError, "changed"):
                router_study.final_selection(out, manifest)

    def test_final_budget_stop_still_produces_a_read_only_inconclusive_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, out, manifest, plan, path, evidence = self.pilot_fixture(Path(temporary))
            approval = {"authorized": True, "action": "select-final-router-study-v5", "manifest_sha256": router_study.digest(manifest), "prospective_grant_id": "bounded-two", "pilot_evidence_sha256": router_study.digest(evidence), "pilot_evidence_file_sha256": router_study.file_hash(path), "configurations": {"efficient": "efficient", "frontier": "frontier"}}
            router_study.select_final(out, manifest, plan, approval, {}, path)
            budget = router_study.Budget(ledger, {"study": load_study()})
            budget.stop("budget_exhausted", "final")
            report = router_study.analyze(out, manifest, plan, "final", {"study": load_study()})
            self.assertEqual(report["conclusion"], "inconclusive")
            self.assertIn("budget_exhausted", report["recorded_stops"])
            self.assertEqual(len(report["missing_or_invalid"]), len([row for row in plan["runs"] if row["phase"] == "final"]))
            self.assertFalse(report["both_modes_pass"])
            self.assertEqual(budget.stopped("final"), ["budget_exhausted"])

    def test_pilot_protocol_provider_coverage_cost_and_grade_failures_block_final(self):
        mutations = ("passed", "format", "typed", "dsml", "provider", "premature", "missing_solver", "cost", "evidence", "grade", "unknown", "extra_observation", "nondict_observation")
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                ledger, out, manifest, plan, path, evidence = self.pilot_fixture(Path(temporary))
                request = evidence["observations"][0]["requests"][0]
                if mutation == "passed":
                    evidence["passed"] = False
                elif mutation == "extra_observation":
                    evidence["observations"].append("invalid")
                elif mutation == "nondict_observation":
                    evidence["observations"][0] = None
                elif mutation == "format":
                    request["text_parser"]["accepted"] = False
                elif mutation == "typed":
                    request["native_calls_present"] = True
                elif mutation == "dsml":
                    request["native_markup_present"] = True
                elif mutation == "provider":
                    request["category"] = "provider_error"
                elif mutation == "premature":
                    request.update(category="provider_reported_length", reported_completion_tokens=1, max_tokens=2)
                elif mutation == "missing_solver":
                    request["request_id"] = "unrelated"
                elif mutation == "cost":
                    evidence["total_cost_usd"] = "0"
                elif mutation == "evidence":
                    evidence["evidence_files"][next(iter(evidence["evidence_files"]))] = "changed"
                elif mutation == "grade":
                    grade = out / "rollouts" / evidence["runs"][0] / "evaluation.json"
                    grade.write_text(json.dumps({"grade_valid": True, "result": [None, {"pilot-task": {"resolved": False}}]}))
                    evidence["evidence_files"][str(grade)] = router_study.file_hash(grade)
                elif mutation == "unknown":
                    with sqlite3.connect(ledger) as db:
                        db.execute("UPDATE requests SET state='unknown' WHERE id=?", (request["request_id"],))
                path.write_text(json.dumps(evidence))
                with self.assertRaises(ValueError):
                    router_study.validate_pilot_evidence(out, manifest, plan, path)

    def test_prospective_budget_cannot_raise_pilot_cap_or_auto_clear_unknowns(self):
        with tempfile.TemporaryDirectory() as temporary:
            ledger, _ = prospective_campaign(Path(temporary))
            for options in ({"pilot_cap_usd": "60.01"}, {"pilot_cap_usd": "0"}, {"auto_run": "old-run"}):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    router_study.Budget(ledger, {"study": load_study()}, **options)
            router_study.Budget(ledger, {"study": load_study()}, pilot_cap_usd="60")


class FrozenCoverage(unittest.TestCase):
    def test_spec_requires_exact_bounded_v5_execution_campaign_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            import census
            root = Path(temporary)
            ledger, _ = prospective_campaign(root)
            execution = root / "execution.json"
            execution.write_text("{}")
            resources = {**census.RESOURCES, "run_cost_limit_usd": "60", "max_input_tokens": 1, "http_request_timeout_seconds": 600, "token_overrun_policy": "settle-known-v1"}
            account = root / "account.json"
            account.write_text(json.dumps({"source": "fixture", "captured_at": time.time(), "raw_sha256": "0" * 64, "default_plugins": []}))
            spec = {"version": 5, "prospective_grant_id": "bounded-two", "experiment_id": "fixture", "configurations": [{"id": mode, "router": mode, "snapshot": "snapshot.json"} for mode in ("efficient", "frontier")], "tasks": {"tuning": [f"tuning-{index}" for index in range(18)], "final": [f"holdout-{index}" for index in range(32)]}, "resources": resources, "classifier_fee_fraction": "0.06", "variant_catalog": "variants.json", "execution_manifest": str(execution), "campaign_ledger": str(ledger), "account_policy": str(account), "repetitions": 2, "seed": "frozen", **arms_spec()}
            modules = {"census": SimpleNamespace(RESOURCES=census.RESOURCES)}
            self.assertEqual(router_study.validate_spec(spec, modules), spec)
            for cap in ("0", "60.01", 60, None):
                with self.subTest(run_cap=cap), self.assertRaises(ValueError):
                    router_study.validate_spec({**spec, "resources": {**resources, "run_cost_limit_usd": cap}}, modules)
            bad_control = {**spec["control"], "distribution": {mode: [{"model": "x/y", "variant": "variant=low", "weight": "0.5"}] for mode in ("efficient", "frontier")}}
            bad_objectives = {**spec["objectives"], "efficient": {"kind": "frontier-maximize-success-within-cost", "cost_budget": {"type": "absolute", "max_total_usd": "1"}}}
            for change in ({"version": 4}, {"version": 3}, {"repetitions": 1}, {"repetitions": 3}, {"repetitions": True}, {"seed": ""}, {"campaign_ledger": "relative.sqlite"}, {"pilot_cap_usd": "60.01"}, {"pilot_cap_usd": "0"}, {"prospective_grant_id": "wrong"}, {"configurations": [spec["configurations"][0]]}, {"configurations": [spec["configurations"][0], {**spec["configurations"][1], "router": "efficient"}]}, {"tasks": {"tuning": ["a"], "final": spec["tasks"]["final"]}}, {"tasks": {"tuning": spec["tasks"]["tuning"], "final": ["b"]}}, {"fixed_models": {"efficient": spec["fixed_models"]["efficient"]}}, {"control": bad_control}, {"objectives": bad_objectives}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    router_study.validate_spec({**spec, **change}, modules)

    def test_run_approval_rejects_arbitrary_runtime_command_or_root_overrides(self):
        command = ["node", "runtime", "--prepared-execution", "{prepared_execution}", "--snapshot", "{snapshot}", "--broker-url", "{broker_url}", "--port", "{port}"]
        identity = {"serving_argv": command}
        authorization = {"grant_id": "bounded-two", "cumulative_additional_cap_usd": "60", "effective_ceiling_usd": "67.25"}
        manifest = {"spec": {"prospective_grant_id": "bounded-two", "execution_manifest": "/prepared/execution.json", "pilot_cap_usd": "60"}, "approval": {"prospective_grant_approval_sha256": "grant-hash", "execution_identity": identity, "source_sha256": {}, "effective_authorization": authorization}}
        plan = {"runs": [{"run": "one", "phase": "pilot"}]}
        pricing, classifier = {"unavailable_pairs": []}, {}
        financing = {"manifest_sha256": router_study.digest(manifest), "pricing_sha256": router_study.digest(pricing), "classifier_quote_sha256": router_study.digest(classifier), "authorization": authorization}
        proof = SimpleNamespace(execution_identity=lambda path: identity)
        with mock.patch.object(router_study, "helper", return_value=proof):
            approval = router_study.run_approval(Path("unused"), manifest, plan, "pilot", "batch", ["one"], pricing, classifier, command, financing=financing)
            self.assertEqual(approval["execution_identity"], identity)
            self.assertEqual(approval["effective_authorization"], authorization)
            self.assertEqual(approval["cost_forecast_sha256"], router_study.digest(financing))
            self.assertEqual(approval["action"], "run-router-study-v5")
            self.assertNotIn("financing_sha256", approval)
            self.assertNotIn("additional_cap_usd", approval)
            with self.assertRaisesRegex(ValueError, "cost forecast"):
                router_study.run_approval(Path("unused"), manifest, plan, "pilot", "batch", ["one"], pricing, classifier, command)
            for argv in (["other-command"], [*command, "--baseline-root", "/mutable"]):
                with self.subTest(argv=argv), self.assertRaisesRegex(ValueError, "fixed approved"):
                    router_study.run_approval(Path("unused"), manifest, plan, "pilot", "batch", ["one"], pricing, classifier, argv, financing=financing)
            for options in ({"concurrency": 2}, {"auto_account_unknown": True}):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    router_study.run_approval(Path("unused"), manifest, plan, "pilot", "batch", ["one"], pricing, classifier, command, financing=financing, **options)

    def test_plan_covers_every_task_arm_and_repetition_in_a_frozen_seeded_order(self):
        fixed = {"efficient": [{"model": "x/y", "variant": "variant=low"}, {"model": "z/w", "variant": "effort=high"}], "frontier": [{"model": "x/y", "variant": "variant=low"}]}
        spec = {"experiment_id": "paired", "seed": "preregistered", "repetitions": 2, "tasks": {"tuning": ["a", "b"], "final": [f"holdout-{index}" for index in range(32)]}, "configurations": [{"id": "first", "router": "efficient"}, {"id": "second", "router": "frontier"}], **arms_spec(fixed)}
        tasks = {task: {"repo": task + "/repo"} for task in spec["tasks"]["tuning"] + spec["tasks"]["final"]}
        plan = router_study.make_plan(spec, tasks)
        self.assertEqual(plan, router_study.make_plan(spec, tasks))
        arms_per_mode = {mode: 3 + len(fixed[mode]) for mode in fixed}
        expected = 2 + 32 * 2 * sum(arms_per_mode.values())
        self.assertEqual((len(plan["runs"]), plan["expected_runs"]), (expected, expected))
        keys = {(row["instance_id"], row["router"], row["configuration"], row["repetition"]) for row in plan["runs"]}
        self.assertEqual(len(keys), expected)
        self.assertEqual(len({row["run"] for row in plan["runs"]}), expected)
        self.assertEqual([(row["instance_id"], row["configuration"], row["repetition"]) for row in plan["runs"][:2]], [("a", "baseline", 0)] * 2)
        final = plan["runs"][2:]
        for mode in ("efficient", "frontier"):
            mode_rows = [row for row in final if row["router"] == mode]
            self.assertEqual(len(mode_rows), 32 * 2 * arms_per_mode[mode])
            self.assertEqual({row["arm_kind"] for row in mode_rows}, {"router", "fixed", "control"})
        # The overlapping fixed model still gets distinct physical runs per mode.
        shared = [row for row in final if row["arm_kind"] == "fixed" and row["model"] == "x/y"]
        self.assertEqual(len(shared), 2 * 32 * 2)
        self.assertEqual(len({row["run"] for row in shared}), len(shared))
        controls = [row for row in final if row["arm_kind"] == "control"]
        self.assertTrue(all((row["model"], row["variant"]) in {(entry["model"], entry["variant"]) for entry in fixed[row["router"]]} for row in controls))
        self.assertTrue(all(row["configuration"] in {"baseline", "control", "fixed-x-y", "fixed-z-w", "first" if row["router"] == "efficient" else "second"} for row in final))

    def test_panel_binding_rejects_subset_reorder_and_post_hoc_split(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)
            prereg = out / "router-panel-spec.json"
            prereg.write_text("{}")
            for name in ("authorizations/preregistration.json", "authorizations/panel-amendment.json", "router-provenance/prior.json", "evaluator/tasks.json"):
                router_study.frozen_write(out / name, {})
            split = {"tuning": ["a", "b"], "final": ["c"]}
            panel = {"tasks": [{"instance_id": task} for task in ("a", "b", "c")]}
            private = [{"instance_id": task, "repo": task + "/repo"} for task in ("a", "b", "c")]
            record = {"schema": "router-quality-cost-split-v1", "panel_sha256": router_study.digest(panel), "spec_sha256": router_study.file_hash(prereg), "outcomes_used": False, **split}
            router_study.frozen_write(out / "split.json", record)
            module = SimpleNamespace(frozen_spec=lambda path: prereg, check_panel=lambda *args: (panel, private), task_evidence=lambda *args: {}, split_tasks=lambda *args: split, read_spec=lambda path: {}, HISTORICAL=("prior",))
            modules = {"study": SimpleNamespace(digest=router_study.digest)}
            with mock.patch.object(router_study, "router_panel", return_value=(module, None)):
                bindings, _ = router_study.panel_inputs(out, "router", modules, {"tasks": split})
                self.assertEqual(bindings["split_file_sha256"], router_study.file_hash(out / "split.json"))
                self.assertIn("router-provenance/prior.json", bindings["preregistration_and_exclusions_sha256"])
                for tasks in ({"tuning": ["a"], "final": ["c"]}, {"tuning": ["b", "a"], "final": ["c"]}, {"tuning": ["c"], "final": ["a", "b"]}):
                    with self.subTest(tasks=tasks), self.assertRaisesRegex(ValueError, "exactly"):
                        router_study.panel_inputs(out, "router", modules, {"tasks": tasks})
                (out / "split.json").write_text(json.dumps({**record, "outcomes_used": True}))
                with self.assertRaises(ValueError):
                    router_study.panel_inputs(out, "router", modules, {"tasks": split})

    def test_old_manifest_is_never_analyzable_as_a_new_pass(self):
        for version in (1, 4):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "audit-only"):
                router_study.analyze(Path("unused"), {"version": version}, {}, "final", {})


class PreAdmission(unittest.TestCase):
    def test_claim_records_its_cap_and_the_next_reservation_stops_at_incurred_money(self):
        study = load_study()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = empty_campaign(root)
            manifest = {"out_root": str(root / "one"), "spec": {"configurations": [{"id": "c1"}]}, "approval": {"execution_identity": {"candidate": {"executableSha256": "bundle"}}}}
            router_study.frozen_write(root / "one/snapshots/c1.json", {"candidate": {}})
            with sqlite3.connect(ledger) as db:
                router_study.CAMPAIGN.register(db, manifest, [{"executableSha256": "bundle", "config": {}}])
            budget = router_study.Budget(ledger, {"study": study}, "100")
            cfg = {"run_cost_limit_usd": "100"}
            row = {"run": "first", "phase": "tuning", "version": "candidate", "configuration": "c1", "instance_id": "task", "router": "efficient", "repetition": 0}
            self.assertIsNone(budget.claim(row, manifest, cfg))
            self.assertIsNone(budget.claim({**row, "run": "tail", "instance_id": "tail-task"}, manifest, cfg))
            with sqlite3.connect(ledger) as db:
                self.assertEqual(dict(db.execute("SELECT run,maximum_usd FROM campaign_admissions")), {"first": "100", "tail": "100"})
                self.assertEqual(db.execute("SELECT COUNT(*) FROM requests").fetchone()[0], 0)
            reserve_cfg = {"router_phase": "tuning", "run_cost_limit_usd": "100", "run_token_limit": 100}
            budget.reserve(root, "first", Decimal("100"), 1, cfg=reserve_cfg, ledger_out=root)
            with self.assertRaises(study.BudgetLimited) as caught:
                budget.reserve(root, "tail", Decimal("100"), 1, cfg=reserve_cfg, ledger_out=root)
            self.assertIn("phase_money_reservation", caught.exception.diagnostics["caps"])
            resumed = router_study.Budget(ledger, {"study": study}, "100")
            self.assertIsNone(resumed.claim({**row, "run": "restart-tail", "instance_id": "restart-task"}, manifest, cfg))
            with sqlite3.connect(ledger) as db:
                db.execute("UPDATE requests SET state='settled', actual='149', tokens=1 WHERE run='first'")
            self.assertIsNone(resumed.claim({**row, "run": "spent-tail", "instance_id": "spent-task"}, manifest, {"run_cost_limit_usd": "2"}))
            with self.assertRaises(study.BudgetLimited):
                resumed.reserve(root, "spent-tail", Decimal("2"), 1, cfg={"router_phase": "tuning", "run_cost_limit_usd": "2", "run_token_limit": 100}, ledger_out=root)

    def test_unverified_historical_candidates_stop_before_any_claim(self):
        study = load_study()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = empty_campaign(root)
            with sqlite3.connect(ledger) as db:
                db.execute("INSERT INTO campaign_candidate_observations VALUES ('historical-config',NULL)")
            budget = router_study.Budget(ledger, {"study": study}, "100")
            self.assertEqual(budget.claim({"run": "never", "phase": "final"}, {}, {"run_cost_limit_usd": "1"}), "historical_candidate_uncertainty")
            self.assertIsNone(router_study.run_state(ledger, "never"))

    def test_renaming_manifest_configuration_or_run_cannot_retry_a_content_attempt(self):
        study = load_study()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = empty_campaign(root)
            budget = router_study.Budget(ledger, {"study": study}, "100")
            row = {"run": "original", "phase": "tuning", "version": "candidate", "configuration": "c1", "instance_id": "task", "router": "efficient", "repetition": 0}
            for label in ("c1", "renamed"):
                manifest = {"out_root": str(root / label), "spec": {"configurations": [{"id": label}]}, "approval": {"execution_identity": {"candidate": {"executableSha256": "bundle"}}}}
                router_study.frozen_write(root / label / "snapshots" / f"{label}.json", {"candidate": {"table": "same"}})
                with sqlite3.connect(ledger) as db:
                    router_study.CAMPAIGN.register(db, manifest, [{"executableSha256": "bundle", "config": {"table": "same"}}])
                reason = budget.claim({**row, "configuration": label, "run": label}, manifest, {"run_cost_limit_usd": "1"})
                if label == "c1":
                    self.assertIsNone(reason)
                    with sqlite3.connect(ledger) as db:
                        db.execute("UPDATE router_runs SET state='stopped' WHERE run='c1'")
                else:
                    self.assertEqual(reason, "never_retry_content_attempt")
                    self.assertIsNone(router_study.run_state(ledger, label))
            with sqlite3.connect(ledger) as db:
                self.assertEqual(router_study.CAMPAIGN.candidate_state(db)["registered"], 1)


class Analysis(unittest.TestCase):
    def record(self, root, status="completed", evaluation=None):
        directory = Path(root) / "rollouts/run"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "result.json").write_text(json.dumps({"status": status}))
        if evaluation is not None:
            (directory / "evaluation.json").write_text(json.dumps(evaluation))
        return {"run": "run", "instance_id": "task", "configuration": "candidate"}

    def test_ambiguous_accounted_outcome_is_an_interval_not_a_fabricated_grade(self):
        with tempfile.TemporaryDirectory() as temporary:
            row = self.record(temporary, "transport_unknown", {"grade_valid": False, "reason": "transport_unknown"})
            bills = [{"id": "known", "state": "settled", "actual": "0.2"}, {"id": "held", "state": "accounted_unknown", "actual": None, "bound": "1"}]
            candidate, reason = router_study.outcome(temporary, row, bills, {"known": "solver", "held": "classifier"}, {"held"})
            self.assertIsNone(reason)
            self.assertEqual((candidate["resolved"], candidate["quality_lower"], candidate["quality_upper"]), (None, 0, 1))
            self.assertEqual((candidate["cost_lower"], candidate["cost_upper"]), (Decimal("0.2"), Decimal("1.2")))
            self.assertEqual(router_study.outcome(temporary, row, bills, {"known": "solver", "held": "classifier"})[1], "unknown_or_unsettled_charge")

    def test_provider_outage_is_a_failure_and_infra_timeout_blocks_even_accounted_unknown(self):
        with tempfile.TemporaryDirectory() as temporary:
            row = self.record(temporary, "provider_unavailable", {"grade_valid": False})
            router_study.frozen_write(Path(temporary) / "rollouts/run/provider-unavailable.json", {"model": "qwen/flash", "effort": "variant=thinking", "reason": "no endpoint"})
            value, reason = router_study.outcome(temporary, row, [], {})
            self.assertIsNone(reason)
            self.assertEqual((value["quality_lower"], value["quality_upper"]), (0, 0))
            self.record(temporary, "completed", {"grade_valid": False, "reason": "grader_infra_invalid", "error": {"kind": "EvaluationError", "message": "Test timed out after contention"}})
            bills = [{"id": "held", "state": "accounted_unknown", "bound": "1", "actual": None}]
            self.assertEqual(router_study.outcome(temporary, row, bills, {"held": "solver"}, {"held"})[1], "infrastructure_or_grader_failure")

    def test_missing_or_invalid_grade_never_implies_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            row = self.record(temporary)
            bills = [{"id": "known", "state": "settled", "actual": "0.2"}]
            self.assertEqual(router_study.outcome(temporary, row, bills, {"known": "solver"})[1], "missing_or_invalid_grade")
            self.record(temporary, evaluation={"grade_valid": False, "result": [None, {"task": {"resolved": True}}]})
            self.assertEqual(router_study.outcome(temporary, row, bills, {"known": "solver"})[1], "missing_or_invalid_grade")
            self.record(temporary, evaluation={"grade_valid": True, "result": [None, {"task": {"resolved": False}}]})
            self.assertEqual(router_study.outcome(temporary, row, bills, {"known": "solver"}, task=task_expectations())[1], "invalid_grade_completeness")
            self.record(temporary, evaluation={"grade_valid": True, "result": [None, {"task": complete_grade(False)}]})
            self.assertFalse(router_study.outcome(temporary, row, bills, {"known": "solver"}, task=task_expectations())[0]["resolved"])

    def test_global_budget_caps_block_quality_but_own_resource_caps_can_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            row = {"run": "run", "instance_id": "task"}
            bills = [{"id": "known", "state": "settled", "actual": "0.2"}]
            folder = Path(temporary) / "rollouts/run"
            folder.mkdir(parents=True)
            (folder / "evaluation.json").write_text(json.dumps({"grade_valid": False, "reason": "budget_limited"}))
            for cap in ("recorded_stop", "unknown_charge_stop", "dispatch_stop", "never_retry", "global_candidate_cap", "phase_money_reservation", "aggregate_money_reservation"):
                with self.subTest(cap=cap):
                    (folder / "result.json").write_text(json.dumps({"status": "budget_limited", "resources": {"caps_fired": [cap]}}))
                    self.assertEqual(router_study.outcome(temporary, row, bills, {"known": "solver"}), (None, "global_stop_truncated"))
            (folder / "result.json").write_text(json.dumps({"status": "budget_limited", "resources": {"caps_fired": ["run_money_reservation"]}}))
            value, reason = router_study.outcome(temporary, row, bills, {"known": "solver"})
            self.assertIsNone(reason)
            self.assertEqual((value["quality_lower"], value["quality_upper"]), (0, 0))

    def test_complete_repeated_quality_bounds_and_all_arm_costs_are_required(self):
        rows = [{"run": f"{arm}-{task}-{rep}", "instance_id": task, "repetition": rep, "configuration": arm} for arm in ("baseline", "c1", "fixed-x-y") for task in ("t1", "t2") for rep in range(2)]
        def value(lower, upper, cost):
            return {"quality_lower": lower, "quality_upper": upper, "cost_lower": Decimal(cost), "cost_upper": Decimal(cost), "solver": Decimal(cost), "classifier": Decimal(0)}
        efficient = {"kind": "efficient-minimize-cost-preserve-success", "success_floor": {"type": "baseline-relative"}}
        frontier = {"kind": "frontier-maximize-success-within-cost", "cost_budget": {"type": "comparator-relative"}}
        # Efficient: equal success at lower cost passes; strict dominance stays diagnostic-only.
        outcomes = {row["run"]: value(0, 0, "1") if row["configuration"] != "c1" else value(0, 0, "0.5") for row in rows}
        comparison = router_study.compare(rows, outcomes, "c1", "baseline", 4, mode="efficient", objective=efficient)
        self.assertTrue(comparison["passes"])
        self.assertFalse(comparison["diagnostic_strict_dominance"]["passes"])
        self.assertTrue(router_study.compare(rows, outcomes, "c1", "fixed-x-y", 4, mode="efficient", objective=efficient)["passes"])
        uncertain_fixed = {**outcomes, **{row["run"]: value(0, 0, "0.4") for row in rows if row["configuration"] == "fixed-x-y"}}
        self.assertFalse(router_study.compare(rows, uncertain_fixed, "c1", "fixed-x-y", 4, mode="efficient", objective=efficient)["passes"])
        # Frontier: higher success at equal cost passes its own objective only.
        outcomes = {row["run"]: value(1, 1, "1") if row["configuration"] == "c1" else value(0, 0, "1") for row in rows}
        comparison = router_study.compare(rows, outcomes, "c1", "baseline", 4, mode="frontier", objective=frontier)
        self.assertTrue(comparison["passes"])
        self.assertFalse(comparison["diagnostic_strict_dominance"]["strictly_lower_total_cost"])
        ambiguous = {**outcomes, **{row["run"]: value(0, 1, "1") for row in rows if row["configuration"] == "baseline"}}
        self.assertFalse(router_study.compare(rows, ambiguous, "c1", "baseline", 4, mode="frontier", objective=frontier)["passes"])
        missing = {run: result for run, result in outcomes.items() if run != "c1-t2-1"}
        charges = {**outcomes, "c1-t2-1": value(0, 0, "9")}
        comparison = router_study.compare(rows, missing, "c1", "baseline", 4, charges, mode="frontier", objective=frontier)
        self.assertFalse(comparison["complete"])
        self.assertFalse(comparison["passes"])
        prefix = {run: result for run, result in outcomes.items() if "-t1-" in run}
        self.assertFalse(router_study.compare(rows, prefix, "c1", "baseline", 4, mode="frontier", objective=frontier)["passes"])
        self.assertEqual(comparison["candidate"]["expected"], 4)
        self.assertEqual(Decimal(comparison["candidate"]["cost_upper"]), Decimal("12"))
        duplicate = [{**row, "repetition": 0} if row["run"] == "c1-t2-1" else row for row in rows]
        self.assertFalse(router_study.compare(duplicate, outcomes, "c1", "baseline", 4, mode="frontier", objective=frontier)["complete"])
        wrong_keys = {("t1", 0), ("t1", 1), ("t2", 0), ("other", 1)}
        self.assertFalse(router_study.compare(rows, outcomes, "c1", "baseline", 4, mode="frontier", objective=frontier, expected_keys=wrong_keys)["complete"])

    def test_selection_rejects_an_unsuccessful_protocol_pilot(self):
        with mock.patch.object(router_study, "validate_pilot_evidence", side_effect=ValueError("pilot failed")), self.assertRaisesRegex(ValueError, "pilot failed"):
            router_study.select_final(Path("unused"), {}, {}, {}, {}, Path("pilot.json"))

    def test_analysis_retains_full_repeated_denominator_and_invalid_arm_charges(self):
        study = load_study()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = empty_campaign(root)
            out = root / "run"
            out.mkdir()
            (out / "budget.sqlite").symlink_to(ledger)
            spec = {"campaign_ledger": str(ledger), "experiment_id": "analysis", "seed": "frozen", "repetitions": 2, "tasks": {"tuning": ["tuning"], "final": ["t1", "t2"]}, "configurations": [{"id": "c1", "router": "efficient"}, {"id": "c2", "router": "frontier"}], **arms_spec()}
            identity = {"fixture": "verified"}
            router_study.frozen_write(out / "snapshots/c1.json", {"baseline": {}, "candidate": {}})
            router_study.frozen_write(out / "snapshots/c2.json", {"baseline": {}, "candidate": {}})
            panel = root / "panel"
            router_study.frozen_write(panel / "evaluator/tasks.json", [task_expectations(task) for task in ("t1", "t2", "f")])
            manifest = {"version": router_study.SPEC_VERSION, "panel_root": str(panel), "spec": spec, "approval": {"execution_identity": identity, "snapshot_file_sha256": {key: router_study.file_hash(out / "snapshots" / f"{key}.json") for key in ("c1", "c2")}}}
            router_study.frozen_write(out / router_study.MANIFEST, manifest)
            plan = router_study.make_plan(spec, {task: {"repo": task} for task in ("tuning", "t1", "t2")})
            tuning = [row for row in plan["runs"] if row["phase"] == "final"]
            outage = next(row for row in tuning if row["router"] == "efficient" and row["configuration"] == "c1" and row["instance_id"] == "t1" and row["repetition"] == 0)
            for row in tuning:
                folder = out / "rollouts" / row["run"]
                unavailable = row == outage
                router_study.frozen_write(folder / "result.json", {"status": "provider_unavailable" if unavailable else "completed"})
                router_study.frozen_write(folder / "evaluation.json", {"grade_valid": not unavailable, "result": [None, {row["instance_id"]: complete_grade(row["configuration"] != "baseline" and row["arm_kind"] != "fixed")}]})
                if unavailable:
                    router_study.frozen_write(folder / "provider-unavailable.json", {"model": "model", "effort": "variant=low", "reason": "unavailable"})
                if row["arm_kind"] == "router":
                    router_study.frozen_write(out / "runtime-health" / f"{row['run']}.json", {"snapshotSha256": router_study.file_hash(out / "snapshots/c1.json"), "fixture": "verified"})
                with sqlite3.connect(ledger) as db:
                    db.execute("INSERT INTO router_runs VALUES (?,?,'finished',?)", (row["run"], "final", time.time()))
                    actual = "1" if row["configuration"] == "baseline" else "0.2"
                    db.execute("INSERT INTO requests VALUES (?,?,?, ?,1,'settled','',1)", (row["run"], row["run"], actual, actual))
                    db.execute("INSERT INTO router_requests VALUES (?,'solver')", (row["run"],))
            proof = SimpleNamespace(verify_runtime_health=mock.Mock())
            modules = {"study": study}
            original_helper = router_study.helper
            with mock.patch.object(router_study, "helper", side_effect=lambda name: proof if name == "router-proof" else original_helper(name)), mock.patch.object(router_study, "final_selection", return_value={"configurations": {"efficient": "c1", "frontier": "c2"}}):
                report = router_study.analyze(out, manifest, plan, "final", modules)
                self.assertFalse(report["missing_or_invalid"])
                comparison = report["comparisons"]["efficient"]["baseline"]
                self.assertEqual(comparison["candidate"]["expected"], 4)
                self.assertEqual(comparison["candidate"]["resolved_lower"], 3)
                self.assertTrue(comparison["passes"])
                self.assertTrue(report["both_modes_pass"])
                self.assertEqual((report["conclusion"], report["inconclusive"], report["plan_complete"]), ("complete", False, True))
                self.assertEqual(set(report["comparisons"]["efficient"]), {"baseline", "control", "fixed-x-y"})
                self.assertFalse(report["fixed_model_superiority"]["efficient"]["superior_to_every_fixed_model"])
                self.assertEqual(report["fixed_model_superiority"]["efficient"]["not_established_for"], ["fixed-x-y"])
                self.assertTrue(report["control_cost_matching"]["efficient"]["claim_allowed"])
                self.assertTrue(report["fixed_model_superiority"]["frontier"]["per_fixed_model"]["fixed-x-y"])
                self.assertFalse(report["generalization_claim"])
                self.assertEqual(report["provider_unavailable_runs"], [outage["run"]])
                self.assertEqual(Decimal(report["phase_all_arm_cost_upper_usd"]), Decimal("12.8"))
                (out / "rollouts" / outage["run"] / "result.json").write_text(json.dumps({"status": "infra_invalid"}))
                blocked = router_study.analyze(out, manifest, plan, "final", modules)
                self.assertFalse(blocked["comparisons"]["efficient"]["baseline"]["complete"])
                self.assertFalse(blocked["both_modes_pass"])
                self.assertEqual((blocked["conclusion"], blocked["inconclusive"], blocked["can_establish_pass"], blocked["can_establish_superiority"], blocked["can_establish_cost_matching"]), ("inconclusive", True, False, False, False))
                self.assertFalse(blocked["fixed_model_superiority"]["efficient"]["superior_to_every_fixed_model"])
                self.assertFalse(blocked["control_cost_matching"]["efficient"]["claim_allowed"])
                self.assertFalse(any(blocked["fixed_model_superiority"]["frontier"]["per_fixed_model"].values()))
                self.assertEqual(blocked["fixed_model_superiority"]["frontier"]["not_established_for"], ["fixed-x-y"])
                for comparisons in blocked["comparisons"].values():
                    for comparison in comparisons.values():
                        self.assertFalse(any(comparison["objective_checks"].values()))
                        self.assertFalse(any(comparison["diagnostic_strict_dominance"].values()))
                self.assertEqual(Decimal(blocked["phase_all_arm_cost_upper_usd"]), Decimal("12.8"))
                self.assertEqual(Decimal(blocked["comparisons"]["efficient"]["baseline"]["candidate"]["cost_upper"]), Decimal("0.8"))

    def test_historical_audit_is_read_only_and_never_upgrades_a_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)
            (out / "budget.sqlite").symlink_to(empty_campaign(out))
            router_study.frozen_write(out / router_study.MANIFEST, {"version": 1})
            router_study.frozen_write(out / "execution-plan.json", {"runs": [{"run": "run"}]})
            self.record(out, evaluation={"grade_valid": True, "result": [None, {"task": {"resolved": True}}]})
            before = {str(path): router_study.file_hash(path) for path in out.rglob("*") if path.is_file()}
            report = router_study.historical_audit(out)
            self.assertEqual((report["passes"], report["verified_complete"]), (False, False))
            self.assertEqual(before, {str(path): router_study.file_hash(path) for path in out.rglob("*") if path.is_file()})


if __name__ == "__main__":
    unittest.main()

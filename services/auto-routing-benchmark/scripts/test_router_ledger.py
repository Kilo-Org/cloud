from decimal import Decimal
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("router_ledger", HERE / "router-ledger.py")
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)


def legacy(path, requests=()):
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE requests (id TEXT PRIMARY KEY,run TEXT,bound TEXT,actual TEXT,tokens INTEGER,state TEXT,receipt TEXT,token_bound INTEGER)")
        db.executemany("INSERT INTO requests VALUES (?,?,?,?,?,?,?,?)", requests)


def inventory(root, sources, observations=(), complete=True):
    evidence = root / "source-evidence.json"
    evidence.write_text(json.dumps({"historical_source_provenance": "unverified"}))
    path = root / "inventory.json"
    path.write_text(json.dumps({"campaign_id": "unit-fixture", "ledger_paths": [str(source) for source in sources], "evidence_files": [str(evidence)], "candidate_observations": [{"evidence_file": str(evidence), "fingerprint": value} for value in observations], "historical_candidates_complete": complete}))
    return path


def empty_campaign(root):
    source = root / "empty-legacy.sqlite"
    legacy(source)
    campaign = root / "campaign"
    ledger.import_campaign(campaign, inventory(root, [source]))
    return campaign / "budget.sqlite"


# Synthetic fixture amounts only; never copied campaign metrics.
SYNTHETIC_BASELINE = "7.25"
SYNTHETIC_ADDITIONAL = "20"


def prospective_campaign(root, baseline=SYNTHETIC_BASELINE, additional=SYNTHETIC_ADDITIONAL):
    source = root / "historical.sqlite"
    legacy(source, [("historical-held", "historical-run", baseline, None, None, "unknown", "", 1)])
    path = root / "campaign/budget.sqlite"
    ledger.import_campaign(path.parent, inventory(root, [source], [None], complete=False))
    with ledger.readonly(path) as db:
        values = ledger.metadata(db)
    approval = {"schema": ledger.PROSPECTIVE_SCHEMA, "authorized": True, "action": "authorize-capped-exploration-router-study", "grant_id": "bounded-two", "campaign_id": values["campaign_id"], "inventory_sha256": values["inventory_sha256"], "committed_upper_baseline_usd": baseline, "additional_cap_usd": additional, "total_cap_usd": "250", "candidate_slots": {"efficient": 1, "frontier": 1}, "historical_unknown_policy": "immutable-funded-historical-commitments", "accepted_proposal": "Synthetic two-mode candidate fixture.", "user_response": "Accepted."}
    approval_path = root / "grant.json"
    approval_path.write_text(json.dumps(approval))
    ledger.authorize(path, approval_path)
    return path, approval_path


def frozen_plan_campaign(root, resource_cap="3", pilot_cap="5"):
    """A real registered manifest plus its frozen execution-plan file."""
    path, _ = prospective_campaign(root)
    out = root / "study"
    out.mkdir()
    runs = [
        {"run": "exp--pilot--t--efficient--baseline--r0", "phase": "pilot", "arm_id": "baseline", "router": "efficient"},
        {"run": "exp--pilot--t--frontier--baseline--r0", "phase": "pilot", "arm_id": "baseline", "router": "frontier"},
        {"run": "exp--final--f--efficient--cand--r0", "phase": "final", "arm_id": "cand", "router": "efficient"},
        {"run": "exp--final--f--efficient--fixed-x-y--r0", "phase": "final", "arm_id": "fixed-x-y", "router": "efficient"},
        {"run": "exp--final--f--frontier--cand--r0", "phase": "final", "arm_id": "cand", "router": "frontier"},
        {"run": "exp--final--f--frontier--control--r0", "phase": "final", "arm_id": "control", "router": "frontier"},
    ]
    plan = {"experiment_id": "exp", "expected_runs": len(runs), "runs": runs}
    (out / "execution-plan.json").write_text(json.dumps(plan, indent=2, sort_keys=True))
    spec = {"prospective_grant_id": "bounded-two", "resources": {"run_cost_limit_usd": resource_cap}, "pilot_cap_usd": pilot_cap}
    manifest = {"version": ledger.MANIFEST_VERSION, "spec": spec, "approval": {"execution_plan_sha256": ledger.digest(plan)}, "out_root": str(out)}
    candidates = [{"router": mode, "executableSha256": "synthetic-bundle", "config": {"table": mode}} for mode in ("efficient", "frontier")]
    with sqlite3.connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        ledger.register(db, manifest, candidates)
    return path, out, manifest, plan


def complete_financing(path, manifest, plan, envelope="0.4"):
    with ledger.readonly(path) as db:
        authorization = ledger.authorization_summary(ledger.effective_authorization(db, "bounded-two"))
    resource_cap = manifest["spec"]["resources"]["run_cost_limit_usd"]
    rows = [{"run": row["run"], "phase": row["phase"], "arm_id": row["arm_id"], "arm_kind": "router", "router": row["router"], "envelope_usd": envelope, "proved_envelope_usd": envelope, "resource_cap_usd": resource_cap, "basis": {"synthetic": True}} for row in plan["runs"]]
    pilot = sum((Decimal(envelope) for row in rows if row["phase"] == "pilot"), Decimal(0))
    return {"schema": ledger.FINANCING_SCHEMA, "forecast_only": True, "funding_guarantee": "none; capped exploration may stop inconclusive", "manifest_sha256": ledger.digest(manifest), "execution_plan_sha256": ledger.digest(plan), "authorization": authorization, "resources": {"run_cost_limit_usd": resource_cap}, "pilot_cap_usd": manifest["spec"]["pilot_cap_usd"], "pilot_envelope_usd": str(pilot), "total_envelope_usd": str(Decimal(envelope) * len(rows)), "rows": rows}


def register_financing(path, financing):
    with sqlite3.connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        return ledger.register_financing(db, financing)


def write_amendment(root, cumulative, prior_sha256, slots=None, name="amendment.json"):
    amendment = {"schema": ledger.AMENDMENT_SCHEMA, "authorized": True, "action": "amend-capped-exploration-router-study-authorization", "amendment_id": f"amend-{cumulative}", "grant_id": "bounded-two", "prior_approval_sha256": prior_sha256, "cumulative_additional_cap_usd": cumulative, "candidate_slots": slots or {"efficient": 1, "frontier": 1}, "accepted_proposal": "Raise the cumulative synthetic allowance.", "user_response": "Accepted."}
    path = root / name
    path.write_text(json.dumps(amendment))
    return path


class Import(unittest.TestCase):
    def test_invalid_kinds_fail_before_creating_campaign_or_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.sqlite"
            legacy(source, [("real", "run", "1", "0.25", 1, "settled", "", 1)])
            with sqlite3.connect(source) as db:
                db.execute("CREATE TABLE router_requests (id TEXT,kind TEXT)")
                db.execute("INSERT INTO router_requests VALUES ('real','invalid')")
            campaign = root / "not-created/campaign"
            with self.assertRaisesRegex(ValueError, "Invalid legacy request kind"):
                ledger.import_campaign(campaign, inventory(root, [source]))
            self.assertFalse(campaign.exists())
            self.assertFalse(campaign.parent.exists())

    def test_failed_database_build_removes_only_its_partial_and_can_be_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.sqlite"
            legacy(source)
            document = inventory(root, [source])
            campaign = root / "campaign"

            def fail_build(partial, *args):
                (partial / "budget.sqlite").write_bytes(b"incomplete")
                raise sqlite3.OperationalError("fixture build failure")

            with mock.patch.object(ledger, "build_campaign", side_effect=fail_build), self.assertRaisesRegex(sqlite3.OperationalError, "fixture build failure"):
                ledger.import_campaign(campaign, document)
            self.assertFalse(campaign.exists())
            self.assertEqual(list(root.glob(".*.partial")), [])
            ledger.import_campaign(campaign, document)
            self.assertTrue((campaign / "budget.sqlite").is_file())

    def test_wal_reads_and_import_leave_archived_sidecars_byte_identical(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "wal.sqlite"
            legacy(source, [("real", "run", "1", "0.25", 1, "settled", "", 1)])
            writer = sqlite3.connect(source)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("UPDATE requests SET actual='0.5' WHERE id='real'")
                writer.commit()
                before = {path.name: path.read_bytes() for path in root.glob("wal.sqlite*")}
                with ledger.readonly(source) as db:
                    self.assertEqual(ledger.rows(db)[0]["actual"], "0.5")
                report = ledger.import_campaign(root / "campaign", inventory(root, [source], [None]))
                self.assertEqual(Decimal(report["settled_actual_usd"]), Decimal("0.5"))
                self.assertEqual(before, {path.name: path.read_bytes() for path in root.glob("wal.sqlite*")})
            finally:
                writer.close()

    def test_only_exact_synthetic_ids_are_excluded(self):
        for request_id in ("prior-v1-committed", "prior-committed"):
            self.assertTrue(ledger.synthetic_prior({"id": request_id, "run": "any"}))
        for request_id in ("prior-real-request", "prior_uuid", "actual"):
            self.assertFalse(ledger.synthetic_prior({"id": request_id, "run": "prior"}))

    def test_receipt_relocation_is_evidence_not_a_rewrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "historical.sqlite"
            original_path = "/archived-study/run/receipts/real.json"
            legacy(source, [("real", "run", "1", "0.25", 1, "settled", original_path, 1)])
            receipt = root / "receipts/real.json"
            receipt.parent.mkdir()
            content = b'{"local_request_id":"real","run":"run","dispatch_entered":true}\\n'
            receipt.write_bytes(content)
            before = source.read_bytes()
            result = ledger.import_campaign(root / "campaign", inventory(root, [source], [None]))
            self.assertEqual(result["receipt_locations_count"], 1)
            self.assertEqual(receipt.read_bytes(), content)
            self.assertEqual(source.read_bytes(), before)
            with ledger.readonly(root / "campaign/budget.sqlite") as db:
                self.assertEqual(db.execute("SELECT receipt FROM requests WHERE id='real'").fetchone()[0], original_path)
                self.assertEqual(db.execute("SELECT original_path,evidence_path,sha256 FROM campaign_receipt_locations").fetchone(), (original_path, str(receipt), hashlib.sha256(content).hexdigest()))

    def test_decimal_dedup_unknown_bounds_and_immutable_original_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "first.sqlite"
            copy = root / "second.sqlite"
            requests = [("real", "run", "0.1", "0.01234567890123456789", 1, "settled", "", 1), ("held", "run", "1.234567890123456789", None, None, "accounted_unknown", "", 1), ("prior-committed", "prior", "99", "99", 0, "settled", "", 0)]
            legacy(source, requests)
            legacy(copy, requests)
            original = source.read_bytes()
            result = ledger.import_campaign(root / "campaign", inventory(root, [source, copy], [None] * 10))
            self.assertEqual(result["requests"], 2)
            self.assertEqual(Decimal(result["settled_actual_usd"]), Decimal("0.01234567890123456789"))
            self.assertEqual(Decimal(result["settled_plus_held_usd"]), Decimal("1.24691356902469135689"))
            self.assertEqual(result["admission_block"], "historical_candidate_uncertainty")
            self.assertEqual(result["candidates"]["unverified_candidate_observations"], 10)
            self.assertIsNone(result["candidates"]["historical_distinct_candidates"])
            self.assertFalse(result["candidates"]["candidate_history_complete"])
            self.assertNotIn("global_candidates_used_lower_bound", result["candidates"])
            self.assertFalse(result["historical_evidence_can_establish_pass"])
            self.assertEqual(source.read_bytes(), original)
            with sqlite3.connect(root / "campaign/budget.sqlite") as db:
                self.assertEqual(db.execute("SELECT bytes FROM campaign_sources WHERE path=?", (str(source),)).fetchone()[0], original)
                self.assertEqual(db.execute("SELECT state,actual,bound FROM requests WHERE id='held'").fetchone(), ("accounted_unknown", None, "1.234567890123456789"))
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("DELETE FROM campaign_sources")
            with self.assertRaisesRegex(ValueError, "never replace"):
                ledger.import_campaign(root / "campaign", root / "inventory.json")

    def test_conflicting_state_keeps_full_hold_and_conflicting_actual_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            a, b = root / "a.sqlite", root / "b.sqlite"
            legacy(a, [("id", "run", "3", "0.25", 1, "settled", "", 1)])
            legacy(b, [("id", "run", "3", None, None, "unknown", "", 1)])
            ledger.import_campaign(root / "campaign", inventory(root, [a, b]))
            with ledger.readonly(root / "campaign/budget.sqlite") as db:
                row, = ledger.rows(db)
                self.assertEqual((row["state"], row["actual"], ledger.held(row)), ("unknown", None, Decimal("3")))
            c = root / "c.sqlite"
            legacy(c, [("id", "run", "3", "0.5", 1, "settled", "", 1)])
            with self.assertRaisesRegex(ValueError, "Conflicting settled"):
                ledger.import_campaign(root / "conflict", inventory(root, [a, c]))

    def test_historical_provenance_cannot_be_asserted_into_verified_candidates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.sqlite"
            legacy(source)
            with self.assertRaisesRegex(ValueError, "never promote"):
                ledger.import_campaign(root / "campaign", inventory(root, [source], ["a" * 64]))
            ledger.import_campaign(root / "campaign", inventory(root, [source], [None], complete=True))
            with sqlite3.connect(root / "campaign/budget.sqlite") as db, self.assertRaisesRegex(ValueError, "uncertainty"):
                ledger.register(db, {"out_root": "new"}, [{"executableSha256": "x", "config": {}}])


class Registry(unittest.TestCase):
    def test_global_content_registry_survives_new_manifests_and_caps_new_executables(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = empty_campaign(root)
            same = {"executableSha256": "bundle", "config": {"table": "one"}}
            with sqlite3.connect(path) as db:
                ledger.register(db, {"out_root": "run-one", "id": "old-label"}, [same])
                ledger.register(db, {"out_root": "run-two", "id": "renamed-label"}, [same])
                self.assertEqual(ledger.candidate_state(db)["registered"], 1)
                ledger.register(db, {"out_root": "run-three"}, [{"executableSha256": f"new-{index}", "config": same["config"]} for index in range(9)])
                self.assertEqual(ledger.candidate_state(db)["registered"], 10)
                with self.assertRaisesRegex(ValueError, "exhausted"):
                    ledger.register(db, {"out_root": "run-eleven"}, [{"executableSha256": "eleventh", "config": {}}])
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("DELETE FROM campaign_candidates")
            with ledger.readonly(path) as db:
                self.assertEqual(ledger.candidate_state(db)["registered"], 10)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM campaign_manifests").fetchone()[0], 3)

    def test_audit_is_read_only_and_retains_inventory_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = empty_campaign(Path(temporary))
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            result = ledger.audit(path)
            self.assertEqual(result["inventory_sha256"], hashlib.sha256((Path(temporary) / "inventory.json").read_bytes()).hexdigest())
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
            with ledger.readonly(path) as db, self.assertRaises(sqlite3.OperationalError):
                db.execute("INSERT INTO metadata VALUES ('forbidden','write')")


class ProspectiveGrant(unittest.TestCase):
    def test_grant_retains_unknown_history_bytes_and_cannot_replay_or_mutate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, approval_path = prospective_campaign(root)
            report = ledger.audit(path)
            self.assertFalse(report["candidates"]["candidate_history_complete"])
            self.assertEqual(report["settled_plus_held_usd"], SYNTHETIC_BASELINE)
            accounting = report["authorization_accounting"]
            self.assertEqual((accounting["historical_origin_commitments_usd"], accounting["new_settled_plus_held_usd"], accounting["unused_authorization_usd"], accounting["effective_campaign_ceiling_usd"]), (SYNTHETIC_BASELINE, "0.00", "20.00", "27.25"))
            self.assertIsNone(report["admission_block"])
            with self.assertRaisesRegex(ValueError, "create-only"):
                ledger.authorize(path, approval_path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("SELECT approval_bytes FROM campaign_prospective_grant").fetchone()[0], approval_path.read_bytes())
                self.assertEqual(db.execute("SELECT state FROM requests").fetchone()[0], "unknown")
                for statement in ("UPDATE requests SET state='settled'", "DELETE FROM requests", "DELETE FROM campaign_prospective_grant", "UPDATE campaign_prospective_grant SET id='other'"):
                    with self.subTest(statement=statement), self.assertRaises(sqlite3.IntegrityError):
                        db.execute(statement)

    def test_only_two_mode_scoped_immutable_fingerprints_are_registered(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, _ = prospective_campaign(Path(temporary))
            candidates = [{"router": mode, "executableSha256": "actual-bundle", "config": {"table": mode}} for mode in ("efficient", "frontier")]
            manifest = {"version": ledger.MANIFEST_VERSION, "spec": {"prospective_grant_id": "bounded-two"}, "out_root": "one"}
            with sqlite3.connect(path) as db:
                db.execute("BEGIN IMMEDIATE")
                ledger.register(db, manifest, candidates)
                ledger.register(db, {**manifest, "out_root": "two"}, candidates)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM campaign_prospective_candidates").fetchone()[0], 2)
                for altered in ([candidates[0]], [candidates[0], candidates[0]], [{**candidates[0], "executableSha256": "changed"}, candidates[1]], [{**candidates[0], "config": {"table": "altered"}}, candidates[1]]):
                    with self.subTest(altered=altered), self.assertRaises(ValueError):
                        ledger.register(db, {**manifest, "out_root": "forbidden"}, altered)
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("DELETE FROM campaign_prospective_candidates")

    def test_authorization_cannot_extend_caps_slots_campaign_or_baseline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, approval_path = prospective_campaign(root)
            original_bytes = approval_path.read_bytes()
            approval = json.loads(original_bytes)
            for change in ({"additional_cap_usd": "100.000000000001"}, {"additional_cap_usd": "0"}, {"total_cap_usd": "251"}, {"committed_upper_baseline_usd": "0"}, {"candidate_slots": {"efficient": 2, "frontier": 1}}, {"candidate_slots": {"efficient": True, "frontier": 1}}, {"campaign_id": "other"}, {"inventory_sha256": "changed"}, {"accepted_proposal": ""}, {"grant_id": "replayed"}):
                attempted = root / "attempted-grant.json"
                attempted.write_text(json.dumps({**approval, **change}))
                with self.subTest(change=change), self.assertRaises(ValueError):
                    ledger.authorize(path, attempted)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("SELECT COUNT(*),approval_bytes FROM campaign_prospective_grant").fetchone(), (1, original_bytes))

    def test_baseline_derives_from_imported_rows_not_a_constant(self):
        # A grant whose stated baseline differs from the imported held sum fails.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "historical.sqlite"
            legacy(source, [("historical-held", "historical-run", "3.5", None, None, "unknown", "", 1), ("historical-settled", "historical-run", "9", "1.25", 1, "settled", "", 1)])
            path = root / "campaign/budget.sqlite"
            ledger.import_campaign(path.parent, inventory(root, [source], [None], complete=False))
            with ledger.readonly(path) as db:
                values = ledger.metadata(db)
            approval = {"schema": ledger.PROSPECTIVE_SCHEMA, "authorized": True, "action": "authorize-capped-exploration-router-study", "grant_id": "bounded-two", "campaign_id": values["campaign_id"], "inventory_sha256": values["inventory_sha256"], "committed_upper_baseline_usd": "12.5", "additional_cap_usd": "20", "total_cap_usd": "250", "candidate_slots": {"efficient": 1, "frontier": 1}, "historical_unknown_policy": "immutable-funded-historical-commitments", "accepted_proposal": "Synthetic.", "user_response": "Accepted."}
            bad = root / "bad-grant.json"
            bad.write_text(json.dumps(approval))
            with self.assertRaisesRegex(ValueError, "origin rows exactly"):
                ledger.authorize(path, bad)
            approval["committed_upper_baseline_usd"] = "4.75"
            good = root / "grant.json"
            good.write_text(json.dumps(approval))
            result = ledger.authorize(path, good)
            self.assertEqual((result["origin_commitments_usd"], result["effective_ceiling_usd"]), ("4.75", "24.75"))

    def test_amendment_is_cumulative_and_never_rebaselines_origin_or_slots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, approval_path = prospective_campaign(root)
            grant_sha = hashlib.sha256(approval_path.read_bytes()).hexdigest()
            with ledger.readonly(path) as db:
                origin_sha = ledger.effective_authorization(db)["origin_snapshot_sha256"]
            for bad in (write_amendment(root, "20", grant_sha, name="same.json"), write_amendment(root, "10", grant_sha, name="lower.json"), write_amendment(root, "100.1", grant_sha, name="over.json"), write_amendment(root, "60", "wrong-hash", name="hash.json"), write_amendment(root, "60", grant_sha, slots={"efficient": 2, "frontier": 1}, name="slots.json")):
                with self.subTest(bad=bad.name), self.assertRaises(ValueError):
                    ledger.amend_authorization(path, bad)
            with sqlite3.connect(path) as db:
                db.execute("INSERT INTO requests VALUES ('new-spend','new-run','5','5',1,'settled','',1)")
            result = ledger.amend_authorization(path, write_amendment(root, "60", grant_sha))
            self.assertEqual((result["cumulative_additional_cap_usd"], result["origin_commitments_usd"], result["effective_ceiling_usd"], result["origin_snapshot_sha256"]), ("60", SYNTHETIC_BASELINE, "67.25", origin_sha))
            report = ledger.audit(path)
            self.assertEqual((report["authorization_accounting"]["new_settled_plus_held_usd"], report["authorization_accounting"]["unused_authorization_usd"]), ("5.00", "55.00"))
            with sqlite3.connect(path) as db:
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("DELETE FROM campaign_prospective_amendments")
                self.assertEqual(db.execute("SELECT state,bound FROM requests WHERE id='historical-held'").fetchone(), ("unknown", SYNTHETIC_BASELINE))


class FinancingRegistration(unittest.TestCase):
    def retotal(self, financing):
        financing["total_envelope_usd"] = str(sum((Decimal(row["envelope_usd"]) for row in financing["rows"]), Decimal(0)))
        financing["pilot_envelope_usd"] = str(sum((Decimal(row["envelope_usd"]) for row in financing["rows"] if row["phase"] == "pilot"), Decimal(0)))
        return financing

    def assert_rejected_without_registration(self, path, financing):
        with self.assertRaises(ValueError):
            register_financing(path, financing)
        with sqlite3.connect(path) as db:
            count = db.execute("SELECT COUNT(*) FROM campaign_financing_plans").fetchone()[0] if ledger._table(db, "campaign_financing_plans") else 0
            self.assertEqual(count, 0)

    def test_complete_frozen_plan_registers_and_loads(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, out, manifest, plan = frozen_plan_campaign(Path(temporary))
            financing = complete_financing(path, manifest, plan)
            result = register_financing(path, financing)
            self.assertTrue(result["fits"])
            with ledger.readonly(path) as db:
                self.assertEqual(ledger.financing_for(db, result["financing_sha256"]), financing)
                self.assertEqual(ledger.require_current_financing(db, result["financing_sha256"]), financing)
                self.assertIsNone(ledger.financing_for(db, "0" * 64))
                with self.assertRaises(ValueError):
                    ledger.require_current_financing(db, "0" * 64)

    def test_forecast_above_allowance_and_pilot_cap_registers_without_funding_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, out, manifest, plan = frozen_plan_campaign(Path(temporary), resource_cap="60", pilot_cap="60")
            financing = complete_financing(path, manifest, plan, envelope="60")
            self.assertEqual(Decimal(financing["total_envelope_usd"]), Decimal("360"))
            self.assertEqual(Decimal(financing["pilot_envelope_usd"]), Decimal("120"))
            result = register_financing(path, financing)
            self.assertTrue(result["fits"])
            self.assertTrue(result["forecast_exceeds_allowance"])
            self.assertEqual(Decimal(result["forecast_total_usd"]), Decimal("360"))
            self.assertEqual(Decimal(result["total_liability_usd"]), Decimal(SYNTHETIC_BASELINE))
            with ledger.readonly(path) as db:
                self.assertEqual(ledger.financing_for(db, result["financing_sha256"]), financing)
                liability = ledger.plan_liability(db, pending=(plan["runs"][0]["run"], "20"))
                self.assertEqual(liability["total_liability_usd"], Decimal(SYNTHETIC_BASELINE) + Decimal("20"))
                self.assertFalse(ledger.check_financing_fits(db, pending=(plan["runs"][0]["run"], "20.01"))["fits"])

    def test_each_registered_forecast_reports_its_own_total(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, out, manifest, plan = frozen_plan_campaign(Path(temporary), resource_cap="60", pilot_cap="60")
            larger = register_financing(path, complete_financing(path, manifest, plan, envelope="60"))
            smaller = register_financing(path, complete_financing(path, manifest, plan, envelope="1"))
            self.assertTrue(larger["forecast_exceeds_allowance"])
            self.assertFalse(smaller["forecast_exceeds_allowance"])
            self.assertEqual((Decimal(larger["forecast_total_usd"]), Decimal(smaller["forecast_total_usd"])), (Decimal("360"), Decimal("6")))
            self.assertNotEqual(larger["financing_sha256"], smaller["financing_sha256"])

    def test_liability_counts_only_incurred_and_releases_unused_hold_on_settlement(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, out, manifest, plan = frozen_plan_campaign(Path(temporary), resource_cap="60", pilot_cap="60")
            register_financing(path, complete_financing(path, manifest, plan, envelope="60"))
            run = plan["runs"][2]["run"]
            with sqlite3.connect(path) as db:
                db.execute("INSERT INTO campaign_admissions VALUES (?,?,?,?)", (run, ledger.digest(manifest), "60", "attempt-fixture"))
                db.execute("INSERT INTO router_runs VALUES (?, 'final', 'active', 0)", (run,))
                db.execute("INSERT INTO requests VALUES ('next-request', ?, '10', NULL, NULL, 'reserved', '', 1)", (run,))
            with ledger.readonly(path) as db:
                liability = ledger.plan_liability(db)
                self.assertEqual(liability["total_liability_usd"], Decimal(SYNTHETIC_BASELINE) + Decimal("10"))
            with sqlite3.connect(path) as db:
                db.execute("UPDATE requests SET state='settled', actual='1', tokens=1 WHERE id='next-request'")
            with ledger.readonly(path) as db:
                self.assertEqual(ledger.plan_liability(db)["total_liability_usd"], Decimal(SYNTHETIC_BASELINE) + Decimal("1"))
                self.assertEqual(db.execute("SELECT state,bound FROM requests WHERE id='historical-held'").fetchone(), ("unknown", SYNTHETIC_BASELINE))

    def test_legacy_financing_stays_auditable_but_never_authorizes_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, out, manifest, plan = frozen_plan_campaign(Path(temporary))
            legacy = complete_financing(path, manifest, plan)
            legacy["schema"] = ledger.LEGACY_FINANCING_SCHEMA
            del legacy["forecast_only"], legacy["funding_guarantee"]
            legacy_sha = ledger.digest(legacy)
            with ledger.readonly(path) as read_db:
                authorization_sha = ledger.effective_authorization(read_db)["effective_approval_sha256"]
            with sqlite3.connect(path) as db:
                db.execute("BEGIN IMMEDIATE")
                ledger.financing_tables(db)
                db.execute("INSERT INTO campaign_financing_plans VALUES (?,?,?,?,?)", (legacy_sha, ledger.digest(manifest), authorization_sha, json.dumps(legacy, sort_keys=True), 0))
                db.executemany("INSERT INTO campaign_financing_rows VALUES (?,?,?,?)", ((legacy_sha, row["run"], row["phase"], row["envelope_usd"]) for row in legacy["rows"]))
                db.execute("COMMIT")
                with self.assertRaisesRegex(ValueError, "audit-only"):
                    ledger.financing_for(db, legacy_sha)
            report = ledger.audit(path)
            self.assertEqual(report["cost_forecasts"], [{"sha256": legacy_sha, "schema": ledger.LEGACY_FINANCING_SCHEMA, "hash_matches": True, "total_envelope_usd": legacy["total_envelope_usd"], "executable_for_v5": False}])
            self.assertEqual(report["settled_plus_held_usd"], SYNTHETIC_BASELINE)

    def test_omitted_extra_duplicate_and_reordered_rows_reject(self):
        mutations = ("omitted", "pilot_prefix", "extra", "duplicate", "reordered")
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path, out, manifest, plan = frozen_plan_campaign(root)
                financing = complete_financing(path, manifest, plan)
                if mutation == "omitted":
                    financing["rows"] = financing["rows"][:-1]
                elif mutation == "pilot_prefix":
                    financing["rows"] = financing["rows"][:1]
                elif mutation == "extra":
                    financing["rows"] = [*financing["rows"], {**financing["rows"][-1], "run": "exp--final--extra--r0"}]
                elif mutation == "duplicate":
                    financing["rows"][-1] = dict(financing["rows"][0])
                else:
                    financing["rows"][2], financing["rows"][3] = financing["rows"][3], financing["rows"][2]
                self.assert_rejected_without_registration(path, self.retotal(financing))

    def test_wrong_phase_arm_or_mode_rejects_with_unchanged_total(self):
        for key, value in (("phase", "pilot"), ("arm_id", "control"), ("router", "frontier")):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path, out, manifest, plan = frozen_plan_campaign(root)
                financing = complete_financing(path, manifest, plan)
                financing["rows"][2][key] = value
                self.assert_rejected_without_registration(path, self.retotal(financing))

    def test_envelope_must_equal_min_proved_and_unchanged_cap(self):
        mutations = ("above_proved", "changed_cap", "missing_proved", "missing_forecast_only", "resource_cap_above_ceiling", "pilot_cap_above_ceiling")
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path, out, manifest, plan = frozen_plan_campaign(root)
                financing = complete_financing(path, manifest, plan)
                if mutation == "above_proved":
                    financing["rows"][0]["envelope_usd"] = "0.5"
                elif mutation == "changed_cap":
                    financing["rows"][0].update(envelope_usd="0.4", proved_envelope_usd="0.4", resource_cap_usd="2")
                elif mutation == "missing_proved":
                    del financing["rows"][0]["proved_envelope_usd"]
                elif mutation == "missing_forecast_only":
                    del financing["forecast_only"]
                elif mutation == "resource_cap_above_ceiling":
                    financing["resources"]["run_cost_limit_usd"] = "61"
                    for row in financing["rows"]:
                        row["resource_cap_usd"] = "61"
                else:
                    financing["pilot_cap_usd"] = "61"
                self.assert_rejected_without_registration(path, self.retotal(financing))

    def test_changed_plan_file_and_wrong_plan_hash_reject(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, out, manifest, plan = frozen_plan_campaign(root)
            financing = complete_financing(path, manifest, plan)
            changed = {**plan, "runs": plan["runs"][:-1]}
            (out / "execution-plan.json").write_text(json.dumps(changed, indent=2, sort_keys=True))
            self.assert_rejected_without_registration(path, financing)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, out, manifest, plan = frozen_plan_campaign(root)
            financing = complete_financing(path, manifest, plan)
            financing["execution_plan_sha256"] = ledger.digest({"runs": []})
            self.assert_rejected_without_registration(path, financing)

    def test_amendment_makes_registered_financing_stale_everywhere(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, out, manifest, plan = frozen_plan_campaign(root)
            financing = complete_financing(path, manifest, plan)
            result = register_financing(path, financing)
            grant_sha = financing["authorization"]["approval_sha256"]
            ledger.amend_authorization(path, write_amendment(root, "60", grant_sha))
            with sqlite3.connect(path) as db:
                db.execute("BEGIN IMMEDIATE")
                with self.assertRaisesRegex(ValueError, "stale"):
                    ledger.financing_for(db, result["financing_sha256"])
                with self.assertRaisesRegex(ValueError, "stale"):
                    ledger.require_current_financing(db, result["financing_sha256"])
                db.execute("COMMIT")
                self.assertEqual(db.execute("SELECT COUNT(*) FROM campaign_financing_plans").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT state,bound FROM requests WHERE id='historical-held'").fetchone(), ("unknown", SYNTHETIC_BASELINE))
            self.assertFalse(ledger.audit(path)["cost_forecasts"][0]["executable_for_v5"])
            refreshed = complete_financing(path, manifest, plan)
            refreshed_result = register_financing(path, refreshed)
            with ledger.readonly(path) as db:
                self.assertEqual(ledger.require_current_financing(db, refreshed_result["financing_sha256"]), refreshed)
            forecasts = {row["sha256"]: row for row in ledger.audit(path)["cost_forecasts"]}
            self.assertFalse(forecasts[result["financing_sha256"]]["executable_for_v5"])
            self.assertTrue(forecasts[refreshed_result["financing_sha256"]]["executable_for_v5"])


class WriterLock(unittest.TestCase):
    def test_amendment_cannot_race_the_campaign_writer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path, approval_path = prospective_campaign(root)
            grant_sha = hashlib.sha256(approval_path.read_bytes()).hexdigest()
            amendment = write_amendment(root, "60", grant_sha)
            lock_path = path.parent / ".writer.lock"
            with lock_path.open("a+") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(ValueError, "writer lock is held"):
                    ledger.amend_authorization(path, amendment)
                with ledger.readonly(path) as db:
                    self.assertEqual(ledger.effective_authorization(db)["cumulative_additional_cap_usd"], SYNTHETIC_ADDITIONAL)
            result = ledger.amend_authorization(path, amendment)
            self.assertEqual(result["cumulative_additional_cap_usd"], "60")
            with ledger.writer_lock(path) as acquired:
                self.assertEqual(acquired, lock_path.resolve())


if __name__ == "__main__":
    unittest.main()

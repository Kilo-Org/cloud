"""Offline behavioral tests for text_tariffs and the gateway dispatch guard.

All tariff and quantity evidence is synthetic and finite. No network, no
real credentials and no paid inference are used; HTTP is mocked at
requests.post.
"""

from contextlib import nullcontext
from decimal import Decimal
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import text_tariffs as tariffs
import study

ORG_ID = "123e4567-e89b-12d3-a456-426614174000"
CFG = {"max_input_tokens": 1000, "max_output_tokens": 16384, "kilo_organization_id": ORG_ID, "candidate": {"model": "x/y", "effort": "effort=low"}}


def endpoints(pricing=None):
    return [{"tag": "fixture", "status": 0, "context_length": 300000, "max_prompt_tokens": 200000, "max_completion_tokens": 16384, "supported_parameters": ["reasoning", "max_tokens"], "pricing": pricing or {"prompt": "0.000001", "completion": "0.000002"}}]


def entry(pricing=None, **overrides):
    value = {"id": "x/y", "context_length": 300000, "supported_parameters": ["reasoning", "max_tokens"], "architecture": {"output_modalities": ["text"], "input_modalities": ["text"]}, "pricing": pricing or {"prompt": "0.000001", "completion": "0.000002"}}
    value.update(overrides)
    return value


class CatalogQuote(unittest.TestCase):
    def test_additive_input_output_and_request_fee_with_zero_quantity_media(self):
        pricing = {"prompt": "0.000001", "input_cache_read": "0.0000002", "input_cache_write": "0.0000003", "input_cache_write_1h": "0.0000004", "completion": "0.000002", "internal_reasoning": "0.000003", "request": "0.01", "image": "5", "web_search": "0.014"}
        quote = tariffs.catalog_quote(entry(pricing=pricing), CFG, endpoints=endpoints())
        # (1000 + 2048) input at the summed input rates, 16384 output at the
        # summed output rates, plus the request fee.
        self.assertEqual(Decimal(quote["solver_bound_usd"]), Decimal("0.0977112"))
        self.assertEqual(Decimal(quote["attempt_bound_usd"]), Decimal("0.097712"))
        self.assertEqual(quote["pricing_raw"], pricing)
        self.assertEqual(quote["components"]["image"]["quantity_bound"], 0)
        self.assertEqual(Decimal(quote["components"]["input_cache_write_1h"]["max_charge_usd"]), Decimal("0.0012192"))
        self.assertEqual(quote["quantities"]["input_quantity"], 3048)
        self.assertEqual(quote["quantities"]["output_tokens"], 16384)

    def test_attempt_reservation_uses_actual_byte_bound_and_microdollar_ceiling(self):
        quote = tariffs.catalog_quote(entry(), CFG, endpoints=endpoints())
        amounts = tariffs.attempt_reservation(quote, estimated_input_tokens=1000)
        self.assertEqual(amounts["bound_usd"], Decimal(quote["attempt_bound_usd"]))
        amounts = tariffs.attempt_reservation(quote, estimated_input_tokens=1, request_bytes=5000)
        self.assertEqual(amounts["input_quantity"], 7048)
        self.assertEqual(amounts["bound_usd"], Decimal("0.039816"))
        with self.assertRaises(tariffs.TariffError):
            tariffs.attempt_reservation(quote, estimated_input_tokens=-1)

    def test_xhigh_variant_keeps_full_financial_and_payload_bounds(self):
        cfg = {**CFG, "candidate": {"model": "x/y", "effort": "variant=xhigh"}, "variant_catalog": {"x/y": {"xhigh": {"reasoning": {"enabled": True, "effort": "xhigh"}, "verbosity": "xhigh"}}}}
        quote = tariffs.catalog_quote(entry(), cfg, endpoints=endpoints())
        self.assertEqual(Decimal(quote["attempt_bound_usd"]), Decimal("0.035816"))
        candidate = {**cfg["candidate"], "context_length": 300000, "financial_quote": quote, "quote_fetched_at": time.time()}
        contract = tariffs.request_contract(candidate, cfg, quote_fetched_at=candidate["quote_fetched_at"])
        payload = study.build_payload(candidate, [{"role": "user", "content": "task"}], contract, cfg)
        tariffs.validate_final_payload(payload, contract)
        payload["verbosity"] = "high"
        with self.assertRaises(tariffs.RequestContractError):
            tariffs.validate_final_payload(payload, contract)

    def test_negative_discount_is_markup_positive_discount_is_undone(self):
        for discount, expected in ((-0.5, "0.053724"), (0.5, "0.071632")):
            with self.subTest(discount=discount):
                quote = tariffs.catalog_quote(entry(pricing={"prompt": "0.000001", "completion": "0.000002", "discount": discount}), CFG, endpoints=endpoints())
                self.assertEqual(Decimal(quote["solver_bound_usd"]), Decimal(expected))

    def test_dearest_endpoint_price_and_override_tier_bound_the_reservation(self):
        dear = endpoints(pricing={"prompt": "0.000012", "completion": "0.000002", "overrides": [{"min_prompt_tokens": 100000, "prompt": "0.00002", "completion": "0.000004"}]})
        quote = tariffs.catalog_quote(entry(), CFG, endpoints=dear)
        self.assertEqual(Decimal(quote["component_maxima"]["prompt"]), Decimal("0.00002"))
        self.assertEqual(Decimal(quote["component_maxima"]["completion"]), Decimal("0.000004"))
        self.assertEqual(Decimal(quote["solver_bound_usd"]), Decimal("0.00002") * 3048 + Decimal("0.000004") * 16384)
        self.assertEqual(quote["endpoint_evidence"][0]["tag"], "fixture")
        amounts = tariffs.attempt_reservation(quote, estimated_input_tokens=1000)
        self.assertEqual(amounts["bound_usd"], Decimal(quote["attempt_bound_usd"]))

    def test_endpoint_discount_is_undone(self):
        discounted = endpoints(pricing={"prompt": "0.000001", "completion": "0.000002", "discount": 0.5})
        quote = tariffs.catalog_quote(entry(), CFG, endpoints=discounted)
        self.assertEqual(Decimal(quote["component_maxima"]["prompt"]), Decimal("0.000002"))

    def test_missing_or_unparseable_endpoint_evidence_fails_the_quote(self):
        for bad in (None, [], [{"tag": "x"}], endpoints(pricing={"prompt": "not-a-price", "completion": "0.000002"})):
            with self.subTest(endpoints=bad), self.assertRaises(tariffs.TariffError):
                tariffs.catalog_quote(entry(), CFG, endpoints=bad)

    def test_unknown_nonzero_component_blocks_but_zero_is_recorded(self):
        with self.assertRaises(tariffs.TariffError):
            tariffs.catalog_quote(entry(pricing={"prompt": "0.000001", "completion": "0.000002", "cache_storage": "0.1"}), CFG, endpoints=endpoints())
        quote = tariffs.catalog_quote(entry(pricing={"prompt": "0.000001", "completion": "0.000002", "cache_storage": "0"}), CFG, endpoints=endpoints())
        self.assertEqual(quote["unknown_zero_components"], ["cache_storage"])
        self.assertEqual(quote["pricing_raw"]["cache_storage"], "0")

    def test_output_modality_rate_blocks_without_architecture_evidence(self):
        pricing = {"prompt": "0.000001", "completion": "0.000002", "image_output": "1"}
        with self.assertRaisesRegex(tariffs.TariffError, "image_output"):
            tariffs.catalog_quote(entry(pricing=pricing, architecture=None), CFG, endpoints=endpoints())
        quote = tariffs.catalog_quote(entry(pricing=pricing), CFG, endpoints=endpoints())
        self.assertEqual(quote["components"]["image_output"]["quantity_bound"], 0)
        self.assertEqual(quote["model_architecture"]["output_modalities"], ["text"])

    def test_unavailable_is_only_context_or_parameter_shortfall(self):
        with self.assertRaises(RuntimeError) as caught:
            tariffs.catalog_quote(entry(context_length=1000), CFG, endpoints=endpoints())
        self.assertEqual(str(caught.exception), tariffs.MODEL_UNAVAILABLE)
        with self.assertRaises(RuntimeError) as caught:
            tariffs.catalog_quote(entry(supported_parameters=["max_tokens"]), CFG, endpoints=endpoints())
        self.assertEqual(str(caught.exception), tariffs.MODEL_UNAVAILABLE)
        with self.assertRaises(tariffs.TariffError):
            tariffs.catalog_quote(entry(pricing={"prompt": "0.000001"}), CFG, endpoints=endpoints())
        with self.assertRaises(tariffs.TariffError):
            tariffs.catalog_quote(entry(id="z/w"), CFG, endpoints=endpoints())


class Schedules(unittest.TestCase):
    PRICING = {"prompt": "1", "completion": "10", "overrides": [{"min_prompt_tokens": 100, "prompt": "2"}, {"utc_days": ["monday"], "utc_start": 2300, "utc_end": 100, "prompt": "3", "completion": "30"}]}

    def test_strict_threshold_inheritance_and_later_wins(self):
        pricing, _ = tariffs.parse_pricing(self.PRICING)
        self.assertEqual(tariffs.resolved_rates(pricing, 100)["prompt"], Decimal("1"))
        resolved = tariffs.resolved_rates(pricing, 101)
        self.assertEqual((resolved["prompt"], resolved["completion"]), (Decimal("2"), Decimal("10")))
        resolved = tariffs.resolved_rates(pricing, 101, "monday", 2330)
        self.assertEqual((resolved["prompt"], resolved["completion"]), (Decimal("3"), Decimal("30")))

    def test_midnight_wrap_and_exclusive_end(self):
        pricing, _ = tariffs.parse_pricing(self.PRICING)
        override = pricing.overrides[1]
        self.assertTrue(tariffs.schedule_applies(override, 0, "monday", 30))
        self.assertFalse(tariffs.schedule_applies(override, 0, "monday", 100))
        self.assertTrue(tariffs.schedule_applies(override, 0, "monday", 2300))
        self.assertFalse(tariffs.schedule_applies(override, 0, "tuesday", 2330))

    def test_maxima_across_schedules_are_not_cumulative(self):
        pricing, _ = tariffs.parse_pricing(self.PRICING)
        maxima = tariffs.component_maxima(pricing)
        self.assertEqual((maxima["prompt"], maxima["completion"]), (Decimal("3"), Decimal("30")))

    def test_unknown_selector_blocks(self):
        with self.assertRaises(tariffs.TariffError):
            tariffs.parse_pricing({"prompt": "1", "completion": "1", "overrides": [{"region": "us", "prompt": "2"}]})


class WorstCaseQuote(unittest.TestCase):
    def test_pool_maximum_plus_classifier_allowance(self):
        cheap = tariffs.catalog_quote(entry(), CFG, endpoints=endpoints())
        pricey_cfg = {**CFG, "candidate": {"model": "z/w", "effort": "effort=low"}}
        pricey = tariffs.catalog_quote(entry(id="z/w", pricing={"prompt": "0.000003", "completion": "0.000002", "request": "0.002"}), pricey_cfg, endpoints=endpoints())
        quote = tariffs.worst_case_quote([cheap, pricey], "kilo-auto/efficient", "effort=", CFG, "0.001")
        self.assertEqual(quote["candidate"], {"model": "kilo-auto/efficient", "effort": "effort="})
        self.assertEqual(Decimal(quote["component_maxima"]["prompt"]), Decimal("0.000003"))
        self.assertEqual(Decimal(quote["classifier_allowance_usd"]), Decimal("0.001"))
        expected_solver = Decimal("0.000003") * 3048 + Decimal("0.000002") * 16384 + Decimal("0.002")
        self.assertEqual(Decimal(quote["solver_bound_usd"]), expected_solver)
        self.assertEqual(Decimal(quote["attempt_bound_usd"]), tariffs.ceil_microdollars(expected_solver + Decimal("0.001")))
        amounts = tariffs.attempt_reservation(quote, estimated_input_tokens=1000)
        self.assertEqual(amounts["bound_usd"], Decimal(quote["attempt_bound_usd"]))
        self.assertEqual(amounts["classifier_allowance_usd"], Decimal("0.001"))


def quoted_candidate(fetched_at=None):
    quote = tariffs.catalog_quote(entry(), CFG, endpoints=endpoints())
    return {"model": "x/y", "effort": "effort=low", "context_length": 300000, "financial_quote": quote, "quote_fetched_at": time.time() if fetched_at is None else fetched_at}


def valid_payload(contract, candidate=None):
    candidate = candidate or {"model": "x/y", "effort": "effort=low"}
    return study.build_payload(candidate, [{"role": "user", "content": "solve"}], contract, CFG)


class FinalPayloadGuard(unittest.TestCase):
    def setUp(self):
        self.candidate = quoted_candidate()
        self.contract = tariffs.request_contract(self.candidate, CFG, quote_fetched_at=self.candidate["quote_fetched_at"])

    def test_valid_payload_serializes_to_exact_hashed_bytes(self):
        raw = tariffs.validate_final_payload(valid_payload(self.contract), self.contract)
        self.assertEqual(json.loads(raw), valid_payload(self.contract))
        self.assertEqual(set(json.loads(raw)), {"model", "messages", "max_tokens", "stream", "reasoning"})
        self.assertEqual(tariffs.request_bytes_sha256(raw), __import__("hashlib").sha256(raw).hexdigest())

    def test_post_mutation_cases_are_rejected(self):
        mutations = []
        payload = valid_payload(self.contract); payload["messages"] = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["tools"] = [{"type": "function"}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["plugins"] = []; mutations.append(payload)
        payload = valid_payload(self.contract); payload["provider"] = {"only": ["x"]}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["usage"] = {"include": True}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["messages"][0]["cache_control"] = {"type": "ephemeral"}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["reasoning"] = {"enabled": True, "effort": "high"}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["max_tokens"] = 16385; mutations.append(payload)
        payload = valid_payload(self.contract); payload["model"] = "x/y:nitro"; mutations.append(payload)
        payload = valid_payload(self.contract); payload["service_tier"] = "flex"; mutations.append(payload)
        payload = valid_payload(self.contract); payload["messages"] = [{"role": "tool", "content": "x"}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["messages"] = [{"role": "assistant", "content": "prefill"}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["stream"] = True; mutations.append(payload)
        for mutated in mutations:
            with self.subTest(keys=sorted(mutated)), self.assertRaises((tariffs.RequestContractError, tariffs.TariffError)):
                tariffs.validate_final_payload(mutated, self.contract)

    def test_assistant_history_is_allowed_before_the_final_user_turn(self):
        payload = valid_payload(self.contract)
        payload["messages"] = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}, {"role": "user", "content": "solve"}]
        tariffs.validate_final_payload(payload, self.contract)

    def test_contract_binds_quoted_candidate_max_tokens_and_organization(self):
        other = {**self.candidate, "model": "z/w"}
        with self.assertRaisesRegex(tariffs.TariffError, "candidate identity"):
            tariffs.request_contract(other, CFG, quote_fetched_at=self.candidate["quote_fetched_at"])
        with self.assertRaisesRegex(tariffs.TariffError, "max_tokens"):
            tariffs.request_contract(self.candidate, {**CFG, "max_output_tokens": 8192}, quote_fetched_at=self.candidate["quote_fetched_at"])
        for bad in (None, "", "not-a-uuid", 42):
            with self.subTest(org=bad), self.assertRaisesRegex(tariffs.TariffError, "organization"):
                tariffs.request_contract(self.candidate, {**CFG, "kilo_organization_id": bad}, quote_fetched_at=self.candidate["quote_fetched_at"])
        mutated = tariffs.request_contract(self.candidate, CFG, quote_fetched_at=self.candidate["quote_fetched_at"])
        mutated["kilo_organization_id"] = "123e4567-e89b-12d3-a456-426614174999"
        with self.assertRaisesRegex(tariffs.RequestContractError, "mutated"):
            tariffs.validate_final_payload(valid_payload(self.contract), mutated)


class FakeResponse:
    status_code = 200
    headers = {"x-request-id": "req-fixture"}

    def iter_content(self, chunk_size):
        yield b'{"id":"gen-fixture","model":"x/y","usage":{"cost":0,"is_byok":false}}'

    def close(self):
        pass


class CompletionHttp(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"KILO_API_TOKEN": "fixture-only"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.candidate = quoted_candidate()
        self.contract = tariffs.request_contract(self.candidate, CFG, quote_fetched_at=self.candidate["quote_fetched_at"])
        self.payload = valid_payload(self.contract)
        self.raw = tariffs.validate_final_payload(self.payload, self.contract)

    def receipt(self):
        return {"request_sha256": tariffs.request_bytes_sha256(self.raw), "dispatch_entered": False, "reservation_usd": "0.035816"}

    def run_http(self, payload, contract, receipt, admission, env=None):
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch.dict(os.environ, {"KILO_API_TOKEN": "fixture-only"} if env is None else env, clear=env is not None), mock.patch("requests.post", return_value=FakeResponse()) as post:
                result = study.completion_http(payload, time.monotonic() + 60, receipt, receipt_path, admission=admission, contract=contract)
            return result, post, study.load(receipt_path)

    def test_exact_bytes_gateway_url_and_headers_are_posted(self):
        (response, body), post, saved = self.run_http(self.payload, self.contract, self.receipt(), lambda: nullcontext())
        self.assertEqual(post.call_args.args[0], study.GATEWAY_CHAT_COMPLETIONS_URL)
        self.assertEqual(post.call_args.kwargs["data"], self.raw)
        headers = post.call_args.kwargs["headers"]
        self.assertEqual(headers["Authorization"], "Bearer fixture-only")
        self.assertEqual(headers[study.ORGANIZATION_HEADER], ORG_ID)
        self.assertEqual(set(headers), {"Authorization", "Content-Type", study.ORGANIZATION_HEADER})
        self.assertTrue(saved["dispatch_entered"])
        self.assertEqual(saved["gateway_request_id"], "req-fixture")
        self.assertEqual(body["id"], "gen-fixture")
        self.assertNotIn("fixture-only", json.dumps(saved))

    def test_missing_token_fails_closed_before_dispatch_or_admission(self):
        receipt = self.receipt()
        entered = []

        def admission():
            entered.append(True)
            return nullcontext()

        env = {key: value for key, value in os.environ.items() if key != "KILO_API_TOKEN"}
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch.dict(os.environ, env, clear=True), mock.patch("requests.post") as post, self.assertRaisesRegex(RuntimeError, "KILO_API_TOKEN"):
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=admission, contract=self.contract)
            post.assert_not_called()
        self.assertEqual(entered, [])
        self.assertFalse(receipt["dispatch_entered"])

    def test_missing_reservation_fails_closed_before_dispatch(self):
        receipt = {key: value for key, value in self.receipt().items() if key != "reservation_usd"}
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch("requests.post") as post, self.assertRaisesRegex(RuntimeError, "local reservation"):
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=lambda: nullcontext(), contract=self.contract)
            post.assert_not_called()

    def test_mutated_payload_dispatches_nothing_and_never_enters_admission(self):
        mutated = {**self.payload, "provider": {"only": ["x"]}}
        receipt = self.receipt()
        entered = []

        def admission():
            entered.append(True)
            return nullcontext()

        with self.assertRaises((tariffs.RequestContractError, tariffs.TariffError)):
            with tempfile.TemporaryDirectory() as temporary:
                receipt_path = Path(temporary) / "receipt.json"
                study.save(receipt_path, receipt)
                with mock.patch("requests.post") as post:
                    study.completion_http(mutated, time.monotonic() + 60, receipt, receipt_path, admission=admission, contract=self.contract)
                post.assert_not_called()
        self.assertEqual(entered, [])
        self.assertFalse(receipt["dispatch_entered"])

    def test_expired_quote_blocks_before_dispatch(self):
        stale = quoted_candidate(fetched_at=time.time() - 100000)
        contract = tariffs.request_contract(stale, CFG, quote_fetched_at=stale["quote_fetched_at"])
        receipt = self.receipt()
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch("requests.post") as post, self.assertRaisesRegex(RuntimeError, "expired"):
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=lambda: nullcontext(), contract=contract)
            post.assert_not_called()

    def test_missing_contract_blocks(self):
        with self.assertRaisesRegex(RuntimeError, "contract"):
            study.completion_http(self.payload, time.monotonic() + 60, {}, Path("unused.json"))

    def test_missing_admission_never_dispatches(self):
        receipt = self.receipt()
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch("requests.post") as post, self.assertRaisesRegex(RuntimeError, "admission"):
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, contract=self.contract)
            post.assert_not_called()
        self.assertFalse(receipt["dispatch_entered"])

    def test_one_receipt_dispatches_exactly_once(self):
        receipt = self.receipt()
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch.dict(os.environ, {"KILO_API_TOKEN": "fixture-only"}), mock.patch("requests.post", return_value=FakeResponse()) as post:
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=lambda: nullcontext(), contract=self.contract)
                with self.assertRaisesRegex(RuntimeError, "already dispatched"):
                    study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=lambda: nullcontext(), contract=self.contract)
            self.assertEqual(post.call_count, 1)

    def test_freshness_is_rechecked_after_admission_yields(self):
        receipt = self.receipt()
        contract = self.contract

        class ExpiringAdmission:
            def __call__(self):
                return self

            def __enter__(self):
                contract["quote_fetched_at"] = time.time() - 100000

            def __exit__(self, *args):
                return False

        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch("requests.post") as post, self.assertRaisesRegex(RuntimeError, "expired"):
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=ExpiringAdmission(), contract=contract)
            post.assert_not_called()
        self.assertFalse(receipt["dispatch_entered"])


class Settlement(unittest.TestCase):
    def test_zero_and_plain_costs_settle_only_with_affirmative_non_byok(self):
        evidence = study.charge_evidence({"cost": 0, "is_byok": False})
        self.assertEqual((evidence.complete, evidence.actual, evidence.billing_mode), (True, Decimal("0"), "non-byok"))
        evidence = study.charge_evidence({"cost": "2.5", "is_byok": False, "cost_details": {"upstream_inference_cost": "9"}})
        self.assertEqual((evidence.complete, evidence.actual, evidence.known_floor), (True, Decimal("2.5"), Decimal("2.5")))

    def test_router_settlement_records_cost_plus_classifier_allowance(self):
        evidence = study.charge_evidence({"cost": "0.01", "is_byok": False}, Decimal("0.001"))
        self.assertEqual((evidence.complete, evidence.actual, evidence.known_floor), (True, Decimal("0.011"), Decimal("0.011")))
        held = study.charge_evidence({"is_byok": False}, Decimal("0.001"))
        self.assertEqual((held.complete, held.known_floor), (False, Decimal("0.001")))

    def test_classifier_bound_prices_every_question_attempt_and_requires_free_output(self):
        endpoints = [{"tag": "cheap", "status": 0, "context_length": 100000, "supported_parameters": ["reasoning", "max_tokens"], "pricing": {"prompt": "0.000000042", "completion": "0", "request": "0.0001"}}, {"tag": "dear", "status": 0, "context_length": 100000, "supported_parameters": ["reasoning", "max_tokens"], "pricing": {"prompt": "0.0000001", "completion": "0", "discount": 0.5}}]
        quote = tariffs.classifier_endpoint_quote("typesafe/jev-1.13", endpoints)
        # Dearest input rate (0.0000001 with its 50% discount undone) times
        # 32768 tokens, plus the dearest request fee, per question attempt;
        # six questions, two attempts, no output charge.
        per_question_attempt = Decimal("0.0000002") * tariffs.CLASSIFIER_INPUT_TOKENS_PER_QUESTION_ATTEMPT + Decimal("0.0001")
        expected = per_question_attempt * tariffs.CLASSIFIER_QUESTIONS_PER_CLASSIFICATION * tariffs.CLASSIFIER_MAX_ATTEMPTS_PER_CLASSIFICATION
        self.assertEqual(Decimal(quote["bound_usd"]), tariffs.ceil_microdollars(expected))
        self.assertEqual((tariffs.CLASSIFIER_INPUT_TOKENS_PER_QUESTION_ATTEMPT, tariffs.CLASSIFIER_QUESTIONS_PER_CLASSIFICATION, tariffs.CLASSIFIER_MAX_ATTEMPTS_PER_CLASSIFICATION), (32768, 6, 2))
        with self.assertRaises(tariffs.TariffError):
            tariffs.classifier_endpoint_quote("typesafe/jev-1.13", [])
        priced_output = [{"tag": "priced", "status": 0, "context_length": 100000, "supported_parameters": ["reasoning", "max_tokens"], "pricing": {"prompt": "0.0000001", "completion": "0.000001"}}]
        with self.assertRaisesRegex(tariffs.TariffError, "no max_tokens"):
            tariffs.classifier_endpoint_quote("typesafe/jev-1.13", priced_output)
        with self.assertRaisesRegex(tariffs.TariffError, "exactly zero"):
            tariffs.classifier_allowance_bound({"component_maxima": {"prompt": "0.000001", "completion": "0.000001"}})

    def test_byok_true_is_unknown_never_settled(self):
        evidence = study.charge_evidence({"cost": "0.006", "is_byok": True, "cost_details": {"upstream_inference_cost": "1"}})
        self.assertEqual((evidence.complete, evidence.actual, evidence.billing_mode), (False, None, "byok-not-allowed"))
        self.assertEqual(evidence.known_floor, Decimal("0.006"))

    def test_missing_null_and_nonboolean_is_byok_is_ambiguous(self):
        for usage in ({"cost": "1"}, {"cost": "1", "is_byok": None}, {"cost": "1", "is_byok": "yes"}, {"cost": "1", "is_byok": 0}, {"cost": "1", "is_byok": 1}):
            with self.subTest(usage=usage):
                evidence = study.charge_evidence(usage)
                self.assertEqual((evidence.complete, evidence.actual, evidence.billing_mode), (False, None, "ambiguous"))
                self.assertEqual(evidence.known_floor, Decimal("1"))
        self.assertEqual(study.charge_evidence({}).billing_mode, "ambiguous")
        self.assertEqual(study.charge_evidence(None).billing_mode, "missing-usage")
        self.assertEqual(study.charge_evidence({"is_byok": False}).billing_mode, "non-byok-incomplete")
        self.assertEqual(study.charge_evidence({"is_byok": False, "cost": "nan"}).complete, False)
        self.assertEqual(study.charge_evidence({"is_byok": False, "cost": -1}).complete, False)

    def test_paid_callbacks_are_mandatory(self):
        with self.assertRaises(RuntimeError):
            study.require_paid_callbacks(None, object(), object(), object())
        study.require_paid_callbacks(object(), object(), object(), object())

    def test_financial_prices_rejects_token_only_quotes(self):
        with self.assertRaises(RuntimeError):
            study.financial_prices({"financial_quote": {"policy": "old", "prompt_per_token": "1", "completion_per_token": "1"}})
        solver, attempt = study.financial_prices(quoted_candidate())
        self.assertEqual((solver, attempt), (Decimal("0.035816"), Decimal("0.035816")))


class PaidSettlement(unittest.TestCase):
    def harness(self, temporary, body, candidate=None, status_code=200):
        import sqlite3
        from types import SimpleNamespace

        out = Path(temporary)
        receipt_path = out / "receipt.json"
        with sqlite3.connect(out / "budget.sqlite") as db:
            db.execute("CREATE TABLE requests (id TEXT PRIMARY KEY, run TEXT, bound TEXT, actual TEXT, tokens INTEGER, state TEXT, receipt TEXT)")
            db.execute("INSERT INTO requests VALUES ('request','run','1',NULL,NULL,'reserved',?)", (str(receipt_path),))

        def complete(payload, deadline, receipt, path, **options):
            receipt["dispatch_entered"] = True
            return SimpleNamespace(status_code=status_code, raise_for_status=lambda: None), body

        return out, receipt_path, complete

    def build_model(self, out, receipt_path, complete, candidate=None):
        from types import SimpleNamespace

        class BaseModel:
            def __init__(self, **kwargs):
                pass

            def _prepare_messages_for_api(self, messages):
                return messages

            def _parse_actions(self, body):
                return []

        modules = {"minisweagent.exceptions": SimpleNamespace(FormatError=ValueError), "minisweagent.models.openrouter_textbased_model": SimpleNamespace(OpenRouterTextbasedModel=BaseModel)}
        cfg = {**CFG, "wall_seconds": 60, "http_request_timeout_seconds": 30}
        bounder = SimpleNamespace(bound=lambda messages: 1, observe=mock.Mock())
        patchers = [mock.patch.dict(sys.modules, modules), mock.patch.object(study, "agent_settings", return_value={"model": {}}), mock.patch.object(study, "completion_http", side_effect=complete)]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        return study.paid_model(out, "run", candidate or quoted_candidate(), cfg=cfg, input_bounder=bounder, reservation=lambda *args, **kwargs: ("request", receipt_path), transport_admission=lambda *args: nullcontext(), state_guard=lambda *args: nullcontext())

    def row(self, out):
        import sqlite3
        with sqlite3.connect(out / "budget.sqlite") as db:
            return db.execute("SELECT state,actual,tokens,bound FROM requests").fetchone()

    def test_settles_and_records_routed_model(self):
        body = {"model": "x/y", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "is_byok": False, "cost": "0.01"}, "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}
        with tempfile.TemporaryDirectory() as temporary:
            out, receipt_path, complete = self.harness(temporary, body)
            model = self.build_model(out, receipt_path, complete)
            self.assertEqual(model.query([{"role": "user", "content": "task"}])["content"], "done")
            self.assertEqual(self.row(out)[:3], ("settled", "0.01", 2))
            receipt = study.load(receipt_path)
            self.assertEqual((receipt["requested_model"], receipt["routed_model"]), ("x/y", "x/y"))

    def test_router_candidate_records_concrete_routed_model(self):
        base = quoted_candidate()
        quote = tariffs.worst_case_quote([base["financial_quote"]], "kilo-auto/efficient", "effort=", CFG, "0.001")
        candidate = {"model": "kilo-auto/efficient", "effort": "effort=", "context_length": 300000, "pool_models": ["x/y"], "financial_quote": quote, "quote_fetched_at": time.time()}
        body = {"model": "x/y", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "is_byok": False, "cost": "0.01"}, "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}
        with tempfile.TemporaryDirectory() as temporary:
            out, receipt_path, complete = self.harness(temporary, body)
            model = self.build_model(out, receipt_path, complete, candidate)
            model.query([{"role": "user", "content": "task"}])
            receipt = study.load(receipt_path)
            self.assertEqual((receipt["requested_model"], receipt["routed_model"]), ("kilo-auto/efficient", "x/y"))
            self.assertEqual(receipt["classifier_allowance_usd"], "0.001")
            # Solver cost 0.01 plus classifier allowance 0.001 settles.
            self.assertEqual(self.row(out)[:3], ("settled", "0.011", 2))
            self.assertEqual(receipt["charge_evidence"]["solver_cost_usd"], "0.01")

    def test_router_breach_is_computed_on_cost_plus_allowance(self):
        base = quoted_candidate()
        quote = tariffs.worst_case_quote([base["financial_quote"]], "kilo-auto/efficient", "effort=", CFG, "0.001")
        candidate = {"model": "kilo-auto/efficient", "effort": "effort=", "context_length": 300000, "pool_models": ["x/y"], "financial_quote": quote, "quote_fetched_at": time.time()}
        body = {"model": "x/y", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "is_byok": False, "cost": "0.0355"}, "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}
        with tempfile.TemporaryDirectory() as temporary:
            out, receipt_path, complete = self.harness(temporary, body)
            model = self.build_model(out, receipt_path, complete, candidate)
            with self.assertRaisesRegex(RuntimeError, "bound violation"):
                model.query([{"role": "user", "content": "task"}])
            self.assertIn(self.row(out)[0], {"unknown", "breach"})

    def test_out_of_pool_routed_model_holds_the_charge(self):
        base = quoted_candidate()
        quote = tariffs.worst_case_quote([base["financial_quote"]], "kilo-auto/efficient", "effort=", CFG, "0.001")
        candidate = {"model": "kilo-auto/efficient", "effort": "effort=", "context_length": 300000, "pool_models": ["x/y"], "financial_quote": quote, "quote_fetched_at": time.time()}
        body = {"model": "other/model", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "is_byok": False, "cost": "0.01"}, "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}
        with tempfile.TemporaryDirectory() as temporary:
            out, receipt_path, complete = self.harness(temporary, body)
            model = self.build_model(out, receipt_path, complete, candidate)
            with self.assertRaisesRegex(RuntimeError, "outside the frozen pool"):
                model.query([{"role": "user", "content": "task"}])
            state, _, _, bound = self.row(out)
            self.assertEqual(state, "unknown")
            self.assertEqual(Decimal(bound), Decimal(study.load(receipt_path)["reservation_usd"]))
            self.assertEqual(study.load(receipt_path)["routed_model"], "other/model")

    def test_router_candidate_without_routed_model_holds_the_charge(self):
        base = quoted_candidate()
        quote = tariffs.worst_case_quote([base["financial_quote"]], "kilo-auto/efficient", "effort=", CFG, "0.001")
        candidate = {"model": "kilo-auto/efficient", "effort": "effort=", "context_length": 300000, "financial_quote": quote, "quote_fetched_at": time.time()}
        body = {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "is_byok": False, "cost": "0.01"}, "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}
        with tempfile.TemporaryDirectory() as temporary:
            out, receipt_path, complete = self.harness(temporary, body)
            model = self.build_model(out, receipt_path, complete, candidate)
            with self.assertRaisesRegex(RuntimeError, "routed concrete model"):
                model.query([{"role": "user", "content": "task"}])
            self.assertEqual(self.row(out)[0], "unknown")

    def test_byok_and_ambiguous_billing_hold_and_do_not_settle(self):
        for usage in ({"prompt_tokens": 1, "completion_tokens": 1, "is_byok": True, "cost": "0.01"}, {"prompt_tokens": 1, "completion_tokens": 1, "cost": "0.01"}):
            body = {"model": "x/y", "usage": usage, "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}
            with self.subTest(usage=usage), tempfile.TemporaryDirectory() as temporary:
                out, receipt_path, complete = self.harness(temporary, body)
                model = self.build_model(out, receipt_path, complete)
                with self.assertRaises(RuntimeError):
                    model.query([{"role": "user", "content": "task"}])
                self.assertEqual(self.row(out)[0], "unknown")

    def test_rejected_response_after_dispatch_keeps_the_full_hold(self):
        body = {"error": "Insufficient balance"}
        with tempfile.TemporaryDirectory() as temporary:
            out, receipt_path, complete = self.harness(temporary, body, status_code=402)
            model = self.build_model(out, receipt_path, complete)
            with self.assertRaisesRegex(RuntimeError, "ambiguous gateway billing evidence"):
                model.query([{"role": "user", "content": "task"}])
            state, _, _, bound = self.row(out)
            self.assertEqual(state, "unknown")
            self.assertEqual(Decimal(bound), Decimal(study.load(receipt_path)["reservation_usd"]))


if __name__ == "__main__":
    unittest.main()

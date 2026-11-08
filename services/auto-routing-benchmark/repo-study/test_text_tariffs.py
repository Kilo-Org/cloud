"""Offline behavioral tests for text_tariffs and the study dispatch guard.

All tariff and quantity evidence is synthetic and finite. No network, no
credentials and no paid inference are used; HTTP is mocked at requests.post.
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

CFG = {"max_input_tokens": 1000, "max_output_tokens": 16384, "byok_fee_ceiling_fraction": "0.06", "candidate": {"model": "x/y", "effort": "effort=low"}}


def account_policy(plugins=None, captured_at=None):
    return {"source": "synthetic account settings export", "captured_at": time.time() if captured_at is None else captured_at, "raw_sha256": "a" * 64, "default_plugins": [{"id": "web", "enabled": True, "prevent_overrides": False}] if plugins is None else plugins}


def contract_cfg(**overrides):
    return {**CFG, "account_policy": account_policy(), **overrides}


def endpoint(tag="prov", pricing=None, **overrides):
    value = {"tag": tag, "status": 0, "context_length": 300000, "max_completion_tokens": 50000, "max_prompt_tokens": 1000, "supported_parameters": ["reasoning", "max_tokens"], "service_tier": None, "supports_implicit_caching": False, "pricing": pricing or {"prompt": "0.000001", "completion": "0.000002"}}
    value.update(overrides)
    return value


class ComponentBounds(unittest.TestCase):
    def test_additive_input_output_and_request_fee_with_zero_quantity_media(self):
        pricing = {"prompt": "0.000001", "input_cache_read": "0.0000002", "input_cache_write": "0.0000003", "input_cache_write_1h": "0.0000004", "completion": "0.000002", "internal_reasoning": "0.000003", "request": "0.01", "image": "5", "web_search": "0.014"}
        quote = tariffs.endpoint_quote([endpoint(pricing=pricing)], CFG)
        self.assertEqual(Decimal(quote["upstream_bound_usd"]), Decimal("0.2619"))
        self.assertEqual(Decimal(quote["attempt_bound_usd"]), Decimal("0.2619") * Decimal("1.06"))
        evidence = quote["endpoint_evidence"][0]
        self.assertEqual(evidence["pricing_raw"], pricing)
        self.assertEqual(evidence["components"]["image"]["quantity_bound"], 0)
        self.assertEqual(Decimal(evidence["components"]["input_cache_write_1h"]["max_charge_usd"]), Decimal("0.0004"))
        self.assertEqual(set(quote["routing_max_price"]), {"prompt", "completion"})
        self.assertEqual(quote["public_constraints"]["input_bound"], 1000)
        without_fee = dict(CFG)
        without_fee.pop("byok_fee_ceiling_fraction")
        with self.assertRaisesRegex(tariffs.TariffError, "explicit approved BYOK fee"):
            tariffs.endpoint_quote([endpoint()], without_fee)

    def test_configured_input_limit_does_not_replace_endpoint_financing_capacity(self):
        quote = tariffs.endpoint_quote([endpoint(max_prompt_tokens=5000)], CFG)
        self.assertEqual(quote["public_constraints"]["input_bound"], CFG["max_input_tokens"])
        self.assertEqual(quote["quantities"]["input_tokens"], 5000)
        self.assertEqual(Decimal(quote["upstream_bound_usd"]), Decimal("0.105"))

    def test_xhigh_variant_keeps_full_financial_and_payload_bounds(self):
        cfg = contract_cfg(candidate={"model": "x/y", "effort": "variant=xhigh"}, variant_catalog={"x/y": {"xhigh": {"reasoning": {"enabled": True, "effort": "xhigh"}, "verbosity": "xhigh"}}})
        quote = tariffs.endpoint_quote([endpoint()], cfg)
        self.assertEqual(Decimal(quote["attempt_bound_usd"]), Decimal("0.10706"))
        candidate = {**cfg["candidate"], "context_length": 300000, "financial_quote": quote, "quote_fetched_at": time.time()}
        contract = tariffs.request_contract(candidate, cfg, quote_fetched_at=candidate["quote_fetched_at"])
        payload = study.build_payload(candidate, [{"role": "user", "content": "task"}], contract, cfg)
        tariffs.validate_final_payload(payload, contract)
        payload["verbosity"] = "high"
        with self.assertRaises(tariffs.RequestContractError):
            tariffs.validate_final_payload(payload, contract)

    def test_negative_discount_is_markup_positive_discount_is_forgone(self):
        for discount, expected in ((-0.5, "0.1515"), (0.5, "0.101")):
            with self.subTest(discount=discount):
                quote = tariffs.endpoint_quote([endpoint(pricing={"prompt": "0.000001", "completion": "0.000002", "discount": discount})], CFG)
                self.assertEqual(Decimal(quote["upstream_bound_usd"]), Decimal(expected))

    def test_unknown_nonzero_component_blocks_but_zero_is_recorded(self):
        with self.assertRaises(tariffs.TariffError):
            tariffs.endpoint_quote([endpoint(pricing={"prompt": "0.000001", "completion": "0.000002", "cache_storage": "0.1"})], CFG)
        quote = tariffs.endpoint_quote([endpoint(pricing={"prompt": "0.000001", "completion": "0.000002", "cache_storage": "0"})], CFG)
        self.assertEqual(quote["endpoint_evidence"][0]["unknown_zero_components"], ["cache_storage"])
        self.assertEqual(quote["endpoint_evidence"][0]["pricing_raw"]["cache_storage"], "0")

    def test_output_modality_rate_blocks_without_architecture_evidence(self):
        pricing = {"prompt": "0.000001", "completion": "0.000002", "image_output": "1"}
        with self.assertRaisesRegex(tariffs.TariffError, "image_output"):
            tariffs.endpoint_quote([endpoint(pricing=pricing)], CFG)
        bare_assertion = {**CFG, "quantity_evidence": {"image_output": {"quantity": 0, "source": "synthetic assertion"}}}
        with self.assertRaisesRegex(tariffs.TariffError, "image_output"):
            tariffs.endpoint_quote([endpoint(pricing=pricing)], bare_assertion)
        architecture = {"output_modalities": ["text"], "input_modalities": ["text"], "tokenizer": "synthetic"}
        quote = tariffs.endpoint_quote([endpoint(pricing=pricing)], {**CFG, "model_architecture": architecture})
        record = quote["endpoint_evidence"][0]
        self.assertEqual(record["components"]["image_output"]["quantity_bound"], 0)
        self.assertEqual(record["model_architecture"], architecture)

    def test_reasoning_max_tokens_and_cfg_overrides_never_tighten_quantities(self):
        cfg = {**CFG, "candidate": {"model": "x/y", "effort": "variant=cap"}, "variant_catalog": {"x/y": {"cap": {"reasoning": {"effort": "low", "max_tokens": 100}}}}}
        pricing = {"prompt": "0.000001", "completion": "0.000002", "internal_reasoning": "0.000003"}
        quote = tariffs.endpoint_quote([endpoint(pricing=pricing)], cfg)
        self.assertEqual(quote["quantities"]["reasoning_tokens_financial"], 50000)
        self.assertEqual(Decimal(quote["upstream_bound_usd"]), Decimal("0.251"))
        with self.assertRaisesRegex(tariffs.TariffError, "financial_output_token_bound"):
            tariffs.endpoint_quote([endpoint(pricing=pricing)], {**CFG, "financial_output_token_bound": 10})

    def test_financial_input_comes_from_endpoint_capacity_not_estimates(self):
        quote = tariffs.endpoint_quote([endpoint(max_prompt_tokens=None, context_length=200000)], CFG)
        self.assertEqual(quote["quantities"]["input_tokens"], 200000)
        self.assertEqual(Decimal(quote["upstream_bound_usd"]), Decimal("0.3"))
        amounts = tariffs.attempt_reservation(quote, estimated_input_tokens=1)
        self.assertEqual(amounts["bound_usd"], Decimal(quote["attempt_bound_usd"]))
        self.assertEqual(amounts["financial_input_tokens"], 200000)

    def test_attempt_reservation_preserves_endpoint_correlations(self):
        endpoints = [
            endpoint("prov", {"prompt": "0.000001", "completion": "0.000002", "request": "0.01"}),
            endpoint("prov/b", {"prompt": "0.000001", "completion": "0.000002", "input_cache_write": "0.00001"}),
        ]
        quote = tariffs.endpoint_quote(endpoints, CFG)
        self.assertEqual(Decimal(quote["upstream_bound_usd"]), Decimal("0.111"))
        amounts = tariffs.attempt_reservation(quote, estimated_input_tokens=1000)
        self.assertEqual(amounts["upstream_usd"], Decimal("0.111"))
        self.assertEqual(amounts["bound_usd"], Decimal(quote["attempt_bound_usd"]))
        with self.assertRaises(tariffs.TariffError):
            tariffs.attempt_reservation(quote, estimated_input_tokens=-1)

    def test_missing_max_completion_is_unknown_not_unavailable(self):
        quote = tariffs.endpoint_quote([endpoint(max_completion_tokens=None)], CFG)
        self.assertEqual(quote["quantities"]["output_tokens_financial"], 300000)


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


class Closure(unittest.TestCase):
    def endpoints(self):
        return [
            endpoint("prov"),
            endpoint("prov/fast", {"prompt": "0.000009", "completion": "0.000009", "discount": 0.9}, service_tier="priority"),
            endpoint("prov/flex", {"prompt": "0.000008", "completion": "0.000008"}, service_tier="flex"),
            endpoint("prov/eu", {"prompt": "0.000005", "completion": "0.000002"}),
            endpoint("prov/dead", {"prompt": "0.000001", "completion": "0.000001"}, status=1),
            endpoint("other", {"prompt": "0.00002", "completion": "0.00002"}),
        ]

    def test_descendants_and_tiers_are_financed_without_base_price_exclusion(self):
        quote = tariffs.endpoint_quote(self.endpoints(), CFG)
        self.assertEqual(quote["eligible_endpoint_tags"], ["prov"])
        self.assertEqual(set(quote["financial_endpoint_tags"]), {"prov", "prov/fast", "prov/flex", "prov/eu"})
        self.assertTrue(quote["routing_uncertainty"])

    def test_workspace_default_tier_narrows_only_with_frozen_evidence(self):
        pinned = tariffs.endpoint_quote(self.endpoints(), {**CFG, "routing_context": {"workspace_default_service_tier": "default"}})
        self.assertEqual(set(pinned["financial_endpoint_tags"]), {"prov", "prov/eu"})
        unset = tariffs.endpoint_quote(self.endpoints(), {**CFG, "routing_context": {"workspace_default_service_tier": None}})
        self.assertEqual(set(unset["financial_endpoint_tags"]), {"prov", "prov/fast", "prov/eu"})

    def test_empty_eligible_set_is_the_only_unavailable_case(self):
        with self.assertRaises(RuntimeError) as caught:
            tariffs.endpoint_quote([endpoint(status=1)], CFG)
        self.assertEqual(str(caught.exception), tariffs.ENDPOINT_UNAVAILABLE)
        with self.assertRaises(tariffs.TariffError):
            tariffs.endpoint_quote([endpoint(pricing={"prompt": "0.000001"})], CFG)

    def test_descendant_without_completion_cap_uses_context_capacity(self):
        endpoints = [endpoint("prov"), endpoint("prov/region", {"prompt": "0.000001", "completion": "0.000001"}, max_completion_tokens=None, context_length=100000)]
        quote = tariffs.endpoint_quote(endpoints, CFG)
        record = next(item for item in quote["endpoint_evidence"] if item["tag"] == "prov/region")
        self.assertEqual(record["output_token_bound"], 100000)
        self.assertIn("context_length", record["output_token_bound_source"])


def quoted_candidate(fetched_at=None):
    quote = tariffs.endpoint_quote([endpoint()], CFG)
    return {"model": "x/y", "effort": "effort=low", "context_length": 300000, "financial_quote": quote, "quote_fetched_at": time.time() if fetched_at is None else fetched_at}


def valid_payload(contract, candidate=None):
    candidate = candidate or {"model": "x/y", "effort": "effort=low"}
    return study.build_payload(candidate, [{"role": "user", "content": "solve"}], contract, CFG)


class FinalPayloadGuard(unittest.TestCase):
    def setUp(self):
        self.candidate = quoted_candidate()
        self.contract = tariffs.request_contract(self.candidate, contract_cfg(), quote_fetched_at=self.candidate["quote_fetched_at"])

    def test_valid_payload_serializes_to_exact_hashed_bytes(self):
        raw = tariffs.validate_final_payload(valid_payload(self.contract), self.contract)
        self.assertEqual(json.loads(raw), valid_payload(self.contract))
        self.assertEqual(tariffs.request_bytes_sha256(raw), __import__("hashlib").sha256(raw).hexdigest())

    def test_post_mutation_cases_are_rejected(self):
        mutations = []
        payload = valid_payload(self.contract); payload["messages"] = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["tools"] = [{"type": "function"}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["plugins"] = ["web"]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["messages"][0]["cache_control"] = {"type": "ephemeral"}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["reasoning"] = {"mode": "pro", "effort": "low"}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["reasoning"] = {"enabled": True, "effort": "high"}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["max_tokens"] = 16385; mutations.append(payload)
        payload = valid_payload(self.contract); payload["model"] = "x/y:nitro"; mutations.append(payload)
        payload = valid_payload(self.contract); payload["provider"] = {**self.contract["provider"], "allow_fallbacks": True}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["provider"] = {**self.contract["provider"], "max_price": {"prompt": math.nan, "completion": 2.0}}; mutations.append(payload)
        payload = valid_payload(self.contract); payload["service_tier"] = "flex"; mutations.append(payload)
        payload = valid_payload(self.contract); payload["messages"] = [{"role": "tool", "content": "x"}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["messages"] = [{"role": "assistant", "content": "prefill"}]; mutations.append(payload)
        payload = valid_payload(self.contract); payload["plugins"] = []; mutations.append(payload)
        for mutated in mutations:
            with self.subTest(keys=sorted(mutated)), self.assertRaises((tariffs.RequestContractError, tariffs.TariffError)):
                tariffs.validate_final_payload(mutated, self.contract)

    def test_assistant_history_is_allowed_before_the_final_user_turn(self):
        payload = valid_payload(self.contract)
        payload["messages"] = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}, {"role": "user", "content": "solve"}]
        tariffs.validate_final_payload(payload, self.contract)

    def test_payload_mutation_cannot_move_approval_controls(self):
        payload = valid_payload(self.contract, self.candidate)
        payload["provider"]["data_collection"] = "allow"
        payload["reasoning"]["effort"] = "high"
        payload["plugins"][0]["enabled"] = True
        self.assertEqual(self.contract["provider"]["data_collection"], "deny")
        with self.assertRaises((tariffs.RequestContractError, tariffs.TariffError)):
            tariffs.validate_final_payload(payload, self.contract)
        mutated_contract = tariffs.request_contract(self.candidate, contract_cfg(), quote_fetched_at=self.candidate["quote_fetched_at"])
        mutated_contract["provider"]["data_collection"] = "allow"
        with self.assertRaisesRegex(tariffs.RequestContractError, "mutated"):
            tariffs.validate_final_payload(valid_payload(self.contract), mutated_contract)

    def test_contract_binds_quoted_candidate_and_requested_max_tokens(self):
        other = {**self.candidate, "model": "z/w"}
        with self.assertRaisesRegex(tariffs.TariffError, "candidate identity"):
            tariffs.request_contract(other, contract_cfg(variant_catalog={"z/w": {}}), quote_fetched_at=self.candidate["quote_fetched_at"])
        with self.assertRaisesRegex(tariffs.TariffError, "max_tokens"):
            tariffs.request_contract(self.candidate, contract_cfg(max_output_tokens=8192), quote_fetched_at=self.candidate["quote_fetched_at"])

    def test_account_policy_is_required_and_enforced_plugins_block(self):
        with self.assertRaisesRegex(tariffs.TariffError, "account policy"):
            tariffs.request_contract(self.candidate, CFG, quote_fetched_at=self.candidate["quote_fetched_at"])
        enforced = contract_cfg(account_policy=account_policy(plugins=[{"id": "web", "enabled": True, "prevent_overrides": True}]))
        with self.assertRaisesRegex(tariffs.TariffError, "enforced"):
            tariffs.request_contract(self.candidate, enforced, quote_fetched_at=self.candidate["quote_fetched_at"])
        extra = contract_cfg(account_policy=account_policy(plugins=[{"id": "acme-plugin", "enabled": True, "prevent_overrides": False}]))
        contract = tariffs.request_contract(self.candidate, extra, quote_fetched_at=self.candidate["quote_fetched_at"])
        disabled = {item["id"] for item in contract["plugins"]}
        self.assertIn("acme-plugin", disabled)
        self.assertTrue(set(tariffs.DOCUMENTED_PLUGIN_IDS) <= disabled)
        self.assertTrue(all(item["enabled"] is False for item in contract["plugins"]))


class FakeResponse:
    status_code = 200
    headers = {}

    def iter_content(self, chunk_size):
        yield b'{"id":"gen-fixture","usage":{"cost":0}}'

    def close(self):
        pass


class CompletionHttp(unittest.TestCase):
    def setUp(self):
        self.candidate = quoted_candidate()
        self.contract = tariffs.request_contract(self.candidate, contract_cfg(), quote_fetched_at=self.candidate["quote_fetched_at"])
        self.payload = valid_payload(self.contract)
        self.raw = tariffs.validate_final_payload(self.payload, self.contract)

    def run_http(self, payload, contract, receipt, admission):
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "fixture-only"}), mock.patch("requests.post", return_value=FakeResponse()) as post:
                result = study.completion_http(payload, time.monotonic() + 60, receipt, receipt_path, admission=admission, contract=contract)
            return result, post, study.load(receipt_path)

    def test_mutated_payload_dispatches_nothing_and_never_enters_admission(self):
        mutated = {**self.payload, "plugins": ["web"]}
        receipt = {"request_sha256": tariffs.request_bytes_sha256(self.raw), "dispatch_entered": False}
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

    def test_exact_bytes_are_posted_and_receipt_bound(self):
        receipt = {"request_sha256": tariffs.request_bytes_sha256(self.raw), "dispatch_entered": False}
        (response, body), post, saved = self.run_http(self.payload, self.contract, receipt, lambda: nullcontext())
        self.assertEqual(post.call_args.kwargs["data"], self.raw)
        self.assertEqual(post.call_args.kwargs["headers"]["Content-Type"], "application/json")
        self.assertTrue(saved["dispatch_entered"])
        self.assertEqual(body["id"], "gen-fixture")

    def test_expired_quote_blocks_before_dispatch(self):
        stale = quoted_candidate(fetched_at=time.time() - 100000)
        contract = tariffs.request_contract(stale, contract_cfg(), quote_fetched_at=stale["quote_fetched_at"])
        receipt = {"request_sha256": tariffs.request_bytes_sha256(self.raw), "dispatch_entered": False}
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
        receipt = {"request_sha256": tariffs.request_bytes_sha256(self.raw), "dispatch_entered": False}
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch("requests.post") as post, self.assertRaisesRegex(RuntimeError, "admission"):
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, contract=self.contract)
            post.assert_not_called()
        self.assertFalse(receipt["dispatch_entered"])

    def test_one_receipt_dispatches_exactly_once(self):
        receipt = {"request_sha256": tariffs.request_bytes_sha256(self.raw), "dispatch_entered": False}
        with tempfile.TemporaryDirectory() as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            study.save(receipt_path, receipt)
            with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "fixture-only"}), mock.patch("requests.post", return_value=FakeResponse()) as post:
                study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=lambda: nullcontext(), contract=self.contract)
                with self.assertRaisesRegex(RuntimeError, "already dispatched"):
                    study.completion_http(self.payload, time.monotonic() + 60, receipt, receipt_path, admission=lambda: nullcontext(), contract=self.contract)
            self.assertEqual(post.call_count, 1)

    def test_freshness_is_rechecked_after_admission_yields(self):
        receipt = {"request_sha256": tariffs.request_bytes_sha256(self.raw), "dispatch_entered": False}
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
    FEE = Decimal("0.06")

    def test_zero_and_plain_costs_settle_only_with_affirmative_non_byok(self):
        evidence = study.charge_evidence({"cost": 0, "is_byok": False}, self.FEE)
        self.assertEqual((evidence.complete, evidence.actual, evidence.billing_mode), (True, Decimal("0"), "non-byok"))
        evidence = study.charge_evidence({"cost": "2.5", "is_byok": False, "cost_details": {"upstream_inference_cost": "9"}}, self.FEE)
        self.assertEqual((evidence.complete, evidence.actual), (True, Decimal("2.5")))

    def test_byok_settles_fee_plus_upstream_and_flags_fee_breach(self):
        usage = {"cost": "0.006", "is_byok": True, "cost_details": {"upstream_inference_cost": "1"}}
        evidence = study.charge_evidence(usage, self.FEE)
        self.assertEqual((evidence.complete, evidence.actual, evidence.fee_breach), (True, Decimal("1.006"), False))
        usage["cost"] = "0.07"
        evidence = study.charge_evidence(usage, self.FEE)
        self.assertEqual((evidence.actual, evidence.fee_breach), (Decimal("1.07"), True))

    def test_partial_byok_retains_the_known_fee_floor(self):
        evidence = study.charge_evidence({"cost": "2", "is_byok": True}, self.FEE)
        self.assertEqual((evidence.complete, evidence.actual, evidence.known_floor, evidence.billing_mode), (False, None, Decimal("2"), "byok-incomplete"))
        evidence = study.charge_evidence({"is_byok": True, "cost_details": {"upstream_inference_cost": "3"}}, self.FEE)
        self.assertEqual(evidence.known_floor, Decimal("3"))

    def test_missing_null_and_nonboolean_is_byok_is_ambiguous(self):
        for usage in ({"cost": "0.006", "cost_details": {"upstream_inference_cost": "1"}}, {"cost": "0.006", "is_byok": None, "cost_details": {"upstream_inference_cost": "1"}}, {"cost": "0.006", "is_byok": "yes", "cost_details": {"upstream_inference_cost": "1"}}, {"cost": "0.006", "is_byok": 1, "cost_details": {"upstream_inference_cost": "1"}}):
            with self.subTest(usage=usage):
                evidence = study.charge_evidence(usage, self.FEE)
                self.assertEqual((evidence.complete, evidence.actual, evidence.billing_mode), (False, None, "ambiguous"))
                self.assertEqual(evidence.known_floor, Decimal("1"))
        self.assertEqual(study.charge_evidence({}, self.FEE).known_floor, Decimal("0"))

    def test_paid_callbacks_are_mandatory(self):
        with self.assertRaises(RuntimeError):
            study.require_paid_callbacks(None, object(), object(), object())
        study.require_paid_callbacks(object(), object(), object(), object())

    def test_financial_prices_rejects_token_only_quotes(self):
        with self.assertRaises(RuntimeError):
            study.financial_prices({"financial_quote": {"policy": "old", "prompt_per_token": "1", "completion_per_token": "1"}})
        candidate = quoted_candidate()
        upstream, attempt = study.financial_prices(candidate)
        self.assertEqual(attempt, upstream * Decimal("1.06"))

class PaidSettlement(unittest.TestCase):
    def test_settlement_survives_receipt_observer_and_competing_writer_failures(self):
        import sqlite3
        from types import SimpleNamespace
        class BaseModel:
            def __init__(self, **kwargs):
                pass

            def _prepare_messages_for_api(self, messages):
                return messages

            def _parse_actions(self, body):
                return []

        modules = {"minisweagent.exceptions": SimpleNamespace(FormatError=ValueError), "minisweagent.models.openrouter_textbased_model": SimpleNamespace(OpenRouterTextbasedModel=BaseModel)}

        for failure in (None, "receipt", "observer", "competing_writer", "admission_denied"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                out = Path(temporary)
                receipt_path = out / "receipt.json"
                with sqlite3.connect(out / "budget.sqlite") as db:
                    db.execute("CREATE TABLE requests (id TEXT PRIMARY KEY, run TEXT, bound TEXT, actual TEXT, tokens INTEGER, state TEXT, receipt TEXT)")
                    db.execute("INSERT INTO requests VALUES ('request','run','1',NULL,NULL,'reserved',?)", (str(receipt_path),))
                bounder = SimpleNamespace(bound=lambda messages: 1, observe=mock.Mock(side_effect=RuntimeError("observer failed") if failure == "observer" else None))
                body = {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "is_byok": False, "cost": "0.01"}, "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}

                def complete(payload, deadline, receipt, path, **options):
                    if failure == "admission_denied":
                        with sqlite3.connect(out / "budget.sqlite") as db:
                            db.execute("UPDATE requests SET state='settled',bound='0',actual='0',tokens=0 WHERE id='request'")
                        raise study.BudgetLimited("Dispatch admission denied", {"caps": ["aggregate_money_reservation"]})
                    receipt["dispatch_entered"] = True
                    if failure == "competing_writer":
                        with sqlite3.connect(out / "budget.sqlite") as db:
                            db.execute("UPDATE requests SET state='settled',actual='0.02',tokens=3 WHERE id='request'")
                    return SimpleNamespace(raise_for_status=lambda: None), body

                save = study.save
                def save_receipt(path, value):
                    if failure == "receipt" and value.get("status") == "settled":
                        raise OSError("receipt write failed")
                    save(path, value)

                cfg = {**contract_cfg(), "wall_seconds": 60, "http_request_timeout_seconds": 30}
                messages = [{"role": "user", "content": "task"}]
                with mock.patch.dict(sys.modules, modules), mock.patch.object(study, "agent_settings", return_value={"model": {}}), mock.patch.object(study, "completion_http", side_effect=complete), mock.patch.object(study, "save", side_effect=save_receipt):
                    model = study.paid_model(out, "run", quoted_candidate(), cfg=cfg, input_bounder=bounder, reservation=lambda *args, **kwargs: ("request", receipt_path), transport_admission=lambda *args: nullcontext(), state_guard=lambda *args: nullcontext())
                    if failure:
                        with self.assertRaises((RuntimeError, OSError)):
                            model.query(messages)
                    else:
                        self.assertEqual(model.query(messages)["content"], "done")
                with sqlite3.connect(out / "budget.sqlite") as db:
                    expected = ("settled", "0", 0) if failure == "admission_denied" else ("settled", "0.02", 3) if failure == "competing_writer" else ("settled", "0.01", 2)
                    self.assertEqual(db.execute("SELECT state,actual,tokens FROM requests").fetchone(), expected)
                if failure in (None, "observer"):
                    receipt = study.load(receipt_path)
                    self.assertEqual((receipt["status"], receipt["actual_usd"]), ("settled", "0.01"))
                if failure == "admission_denied":
                    receipt = study.load(receipt_path)
                    self.assertEqual((receipt["status"], receipt["retained_bound_usd"]), ("not_dispatched", "0"))
                    events = [study.load(path) for path in (out / "resource-limits/run").glob("*.json")]
                    self.assertEqual([event["caps"] for event in events], [["aggregate_money_reservation"]])


if __name__ == "__main__":
    unittest.main()


"""Native text-only tariff bounds and the final outbound request contract.

Primary sources (read 2026-11-07):
- Endpoint/pricing schema: https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md
- Provider selection and max_price: https://openrouter.ai/docs/guides/routing/provider-selection.md
- Service tiers: https://openrouter.ai/docs/guides/features/service-tiers.md
- Prompt caching: https://openrouter.ai/docs/guides/best-practices/prompt-caching.md
- Reasoning tokens: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md

Finite-bound assumptions are stated in `endpoint_quote` and recorded per
endpoint in the returned evidence. Anything outside the documented schema,
or without a documented finite quantity bound, is a quote failure
(TariffError), never an endpoint outage.
"""

import copy
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
import math
import re
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

FINANCIAL_QUOTE_POLICY = "text-only-component-closure-max-v2"

# Plugin ids verified in primary docs (plugins guide and per-plugin pages,
# read 2026-11-07). Account-policy evidence names any others; every id it
# lists is disabled by name as well, so this floor need not be exhaustive.
DOCUMENTED_PLUGIN_IDS = ("web", "file-parser", "response-healing", "alignment")
ENDPOINT_UNAVAILABLE = "No current active endpoint meets public reasoning/context/output constraints"

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
SELECTOR_KEYS = {"min_prompt_tokens", "utc_days", "utc_start", "utc_end"}

# Documented component units from the endpoint Pricing schema.
COMPONENT_UNITS = {
    "prompt": "usd_per_input_token",
    "input_cache_read": "usd_per_input_token",
    "input_cache_write": "usd_per_input_token",
    "input_cache_write_1h": "usd_per_input_token",
    "completion": "usd_per_output_token",
    "internal_reasoning": "usd_per_output_token",
    "request": "usd_per_request",
    "audio": "usd_per_audio_input_token",
    "audio_output": "usd_per_audio_output_token",
    "image": "usd_per_input_image",
    "image_output": "usd_per_output_image",
    "image_token": "usd_per_image_token",
    "input_audio_cache": "usd_per_cached_audio_input_token",
    "web_search": "usd_per_web_search",
}
INPUT_COMPONENTS = ("prompt", "input_cache_read", "input_cache_write", "input_cache_write_1h")
OUTPUT_COMPONENTS = ("completion", "internal_reasoning")
# Quantities the frozen text-only request itself proves are zero: no media or
# audio input parts, no tools/plugins/search in the final payload.
ZERO_QUANTITY_COMPONENTS = ("audio", "image", "image_token", "input_audio_cache", "web_search")
# Output modalities are not fully request-controlled. A nonzero rate blocks
# unless frozen quantity evidence proves a zero quantity for the candidate.
OUTPUT_MODALITY_COMPONENTS = ("audio_output", "image_output")
PRICE_KEYS = frozenset(COMPONENT_UNITS)
# PricingOverride carries only this documented subset of price keys.
OVERRIDE_PRICE_KEYS = frozenset({"prompt", "completion", "input_cache_read", "input_cache_write", "input_cache_write_1h", "audio", "input_audio_cache"})

TIER_ALIASES = {"fast": "priority", "standard": "default", "turbo": "priority", "highspeed": "priority", "prime": "priority"}
KNOWN_TIERS = {None, "flex", "priority", "ultrafast"}


class TariffError(RuntimeError, ValueError):
    """A quote/admission failure. Never an endpoint-availability record."""


def _decimal(value, what):
    if isinstance(value, bool) or value is None:
        raise TariffError(f"Missing {what}")
    try:
        result = Decimal(str(value))
    except InvalidOperation as error:
        raise TariffError(f"Invalid {what}") from error
    if not result.is_finite():
        raise TariffError(f"Invalid {what}")
    return result


def rate(value, what="tariff rate"):
    result = _decimal(value, what)
    if result < 0:
        raise TariffError(f"Negative {what}")
    return result


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _price_decimal(value):
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, (str, int)) and not isinstance(value, bool):
        result = _decimal(value, "tariff price")
    else:
        raise TariffError("Tariff prices must be exact decimal strings")
    if result < 0:
        raise TariffError("Negative tariff price")
    return result


Money = Annotated[Decimal, BeforeValidator(_price_decimal)]


class _Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class PricingOverride(_Strict):
    prompt: Money | None = None
    completion: Money | None = None
    input_cache_read: Money | None = None
    input_cache_write: Money | None = None
    input_cache_write_1h: Money | None = None
    audio: Money | None = None
    input_audio_cache: Money | None = None
    min_prompt_tokens: float | int | None = None
    utc_days: list[str] | None = None
    utc_start: float | int | None = None
    utc_end: float | int | None = None


class Pricing(_Strict):
    prompt: Money
    completion: Money
    internal_reasoning: Money | None = None
    input_cache_read: Money | None = None
    input_cache_write: Money | None = None
    input_cache_write_1h: Money | None = None
    request: Money | None = None
    audio: Money | None = None
    audio_output: Money | None = None
    image: Money | None = None
    image_output: Money | None = None
    image_token: Money | None = None
    input_audio_cache: Money | None = None
    web_search: Money | None = None
    discount: float | int | None = None
    overrides: list[PricingOverride] | None = None


class Endpoint(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore")

    tag: str
    status: int
    context_length: int
    max_completion_tokens: int | None = None
    max_prompt_tokens: int | None = None
    supported_parameters: list[str] = Field(default_factory=list)
    service_tier: str | None = None
    supports_implicit_caching: bool | None = None


def _schema_error(error, what):
    locations = sorted({".".join(str(part) for part in item.get("loc", ())) for item in error.errors()})
    return TariffError(f"Invalid {what} schema at: {', '.join(locations)}")


def parse_endpoint(raw):
    if not isinstance(raw, dict):
        raise TariffError("Endpoint evidence must be an object")
    try:
        endpoint = Endpoint.model_validate(raw)
    except ValidationError as error:
        raise _schema_error(error, "endpoint") from error
    if endpoint.context_length <= 0 or endpoint.service_tier not in KNOWN_TIERS:
        raise TariffError("Endpoint has no positive context or carries an unknown service tier")
    if endpoint.max_completion_tokens is not None and endpoint.max_completion_tokens <= 0:
        raise TariffError("Endpoint max_completion_tokens must be positive")
    if endpoint.max_prompt_tokens is not None and endpoint.max_prompt_tokens <= 0:
        raise TariffError("Endpoint max_prompt_tokens must be positive")
    return endpoint


def _unknown_zero_keys(raw, known):
    """Unknown keys whose value is exactly numeric zero; anything else blocks later."""
    zeros = []
    for key, value in raw.items():
        if key in known:
            continue
        try:
            if not isinstance(value, bool) and _decimal(value, "unknown tariff component") == 0:
                zeros.append(key)
                continue
        except TariffError:
            pass
        raise TariffError(f"Unknown applicable tariff component or selector blocks admission: {key}")
    return zeros


def parse_pricing(raw, require_positive=True):
    """Strict pricing parse. Raw values are preserved by the caller verbatim."""
    if not isinstance(raw, dict):
        raise TariffError("Endpoint pricing evidence must be an object")
    unknown_zero = _unknown_zero_keys(raw, PRICE_KEYS | {"discount", "overrides"})
    cleaned = {key: value for key, value in raw.items() if key not in unknown_zero}
    overrides = cleaned.get("overrides") or []
    if not isinstance(overrides, list) or any(not isinstance(item, dict) for item in overrides):
        raise TariffError("Pricing overrides must be a list of objects")
    cleaned_overrides = []
    for item in overrides:
        zeros = _unknown_zero_keys(item, OVERRIDE_PRICE_KEYS | SELECTOR_KEYS)
        unknown_zero += [f"overrides.{key}" for key in zeros]
        cleaned_overrides.append({key: value for key, value in item.items() if key not in zeros})
    if "overrides" in cleaned:
        cleaned["overrides"] = cleaned_overrides
    try:
        pricing = Pricing.model_validate(cleaned)
    except ValidationError as error:
        raise _schema_error(error, "endpoint pricing") from error
    if pricing.prompt <= 0 or (require_positive and pricing.completion <= 0):
        raise TariffError("Require explicit positive prompt and completion token pricing")
    discount = _decimal(pricing.discount, "pricing discount") if pricing.discount is not None else Decimal(0)
    if discount > 1:
        raise TariffError("Pricing discount above one would imply negative prices")
    for override in pricing.overrides or []:
        validate_selectors(override)
    return pricing, sorted(set(unknown_zero))


def _hhmm(value, key):
    number = _decimal(value, f"pricing schedule {key}")
    if number != int(number) or not 0 <= int(number) <= 2400 or int(number) % 100 >= 60:
        raise TariffError(f"Invalid pricing schedule {key} HHMM clock")
    return int(number)


def validate_selectors(override):
    """Validate schedule selectors separately from prices. Returns normalized selectors."""
    normalized = {}
    if override.min_prompt_tokens is not None:
        threshold = _decimal(override.min_prompt_tokens, "pricing schedule min_prompt_tokens")
        if threshold < 0:
            raise TariffError("Invalid pricing schedule min_prompt_tokens")
        normalized["min_prompt_tokens"] = str(threshold)
    if override.utc_days is not None:
        days = override.utc_days
        if not days or len(set(days)) != len(days) or any(day not in WEEKDAYS for day in days):
            raise TariffError("Invalid pricing schedule utc_days")
        normalized["utc_days"] = list(days)
    has_start, has_end = override.utc_start is not None, override.utc_end is not None
    if has_start != has_end:
        raise TariffError("Pricing schedule time window needs both utc_start and utc_end")
    if has_start:
        normalized["utc_start"] = _hhmm(override.utc_start, "utc_start")
        normalized["utc_end"] = _hhmm(override.utc_end, "utc_end")
        if normalized["utc_start"] == normalized["utc_end"]:
            raise TariffError("Pricing schedule time window is empty")
    return normalized


def _clock_minutes(hhmm):
    return (hhmm // 100) * 60 + hhmm % 100


def schedule_applies(override, prompt_tokens, utc_weekday=None, utc_hhmm=None):
    """Exact selector semantics: strict token threshold; [start, end) may wrap."""
    selectors = validate_selectors(override)
    if "min_prompt_tokens" in selectors and not Decimal(prompt_tokens) > Decimal(selectors["min_prompt_tokens"]):
        return False
    if "utc_days" in selectors:
        if utc_weekday is None or utc_weekday not in selectors["utc_days"]:
            return False
    if "utc_start" in selectors or "utc_end" in selectors:
        if "utc_start" not in selectors or "utc_end" not in selectors or utc_hhmm is None:
            return False
        now, start, end = _clock_minutes(_hhmm(utc_hhmm, "utc time")), _clock_minutes(selectors["utc_start"]), _clock_minutes(selectors["utc_end"])
        inside = start <= now < end if start < end else now >= start or now < end
        if not inside:
            return False
    return True


def resolved_rates(pricing, prompt_tokens, utc_weekday=None, utc_hhmm=None):
    """One applicable schedule resolved with inheritance; later entries win per key."""
    rates = {}
    for key in PRICE_KEYS:
        value = getattr(pricing, key, None)
        if value is not None:
            rates[key] = value
    for override in pricing.overrides or []:
        if schedule_applies(override, prompt_tokens, utc_weekday, utc_hhmm):
            for key in OVERRIDE_PRICE_KEYS:
                value = getattr(override, key, None)
                if value is not None:
                    rates[key] = value
    return rates


def discount_factor(pricing):
    """Positive discounts are forgone; a negative discount is a markup and counts."""
    discount = _decimal(pricing.discount, "pricing discount") if pricing.discount is not None else Decimal(0)
    return (1 - discount) if discount < 0 else Decimal(1)


def component_maxima(pricing):
    """Per-component maximum across base and every validated schedule alternative.

    Overrides are conditional replacements, never cumulative charges, so each
    component is maximized across schedules and components are added later.
    """
    factor = discount_factor(pricing)
    maxima = {}
    for key in PRICE_KEYS:
        values = []
        base = getattr(pricing, key, None)
        if base is not None:
            values.append(base)
        for override in pricing.overrides or []:
            value = getattr(override, key, None)
            if value is not None:
                values.append(value)
        if values:
            maxima[key] = max(values) * factor
    return maxima


EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max"}
REASONING_KEYS = {"enabled", "effort", "max_tokens", "exclude"}
VERBOSITY_VALUES = {"low", "medium", "high", "xhigh", "max"}


def validate_reasoning(value, what="reasoning"):
    if not isinstance(value, dict) or not value or not set(value) <= REASONING_KEYS:
        raise TariffError(f"Unsupported nested {what} controls")
    if "enabled" in value and not isinstance(value["enabled"], bool):
        raise TariffError(f"Unsupported nested {what}.enabled")
    if "effort" in value and value["effort"] not in EFFORTS:
        raise TariffError(f"Unsupported nested {what}.effort")
    if "max_tokens" in value and (type(value["max_tokens"]) is not int or value["max_tokens"] <= 0):
        raise TariffError(f"Unsupported nested {what}.max_tokens")
    if "exclude" in value and not isinstance(value["exclude"], bool):
        raise TariffError(f"Unsupported nested {what}.exclude")
    return dict(value)


def resolve_variant(catalog, model, label):
    """Resolve a candidate effort label to the exact frozen request controls.

    Labels: `variant=<name>` (frozen catalog), `effort=<effort>`, or a bare
    effort word used by retained driver candidates. Unsupported controls
    fail; nothing is silently dropped.
    """
    if not isinstance(label, str) or not label:
        raise TariffError("Candidate effort label is missing")
    if label.startswith("variant="):
        name = label[len("variant="):]
        settings = (catalog or {}).get(model, {}).get(name) if isinstance(catalog, dict) else None
        if not isinstance(settings, dict) or not set(settings) <= {"reasoning", "verbosity"}:
            raise TariffError("Frozen variant catalog lacks the exact supported variant")
        resolved = {}
        if settings.get("reasoning"):
            resolved["reasoning"] = validate_reasoning(settings["reasoning"], "variant reasoning")
        if settings.get("verbosity"):
            if settings["verbosity"] not in VERBOSITY_VALUES:
                raise TariffError("Unsupported variant verbosity")
            resolved["verbosity"] = settings["verbosity"]
        return resolved
    if label.startswith("effort="):
        effort = label[len("effort="):]
        if not effort:
            return {}
        if effort not in EFFORTS:
            raise TariffError("Unsupported reasoning effort label")
        return {"reasoning": {"enabled": True, "effort": effort}}
    if label in EFFORTS:
        return {"reasoning": {"effort": label}}
    raise TariffError("Candidate effort is not an exact variant or effort label")


def _candidate(cfg):
    candidate = cfg.get("candidate") if isinstance(cfg.get("candidate"), dict) else {}
    model = cfg.get("model") or candidate.get("model")
    effort = cfg.get("effort") or candidate.get("effort")
    return model, effort


def _text_only_architecture(cfg):
    """Raw candidate-bound model architecture proving text-only output, or None."""
    architecture = cfg.get("model_architecture")
    if not isinstance(architecture, dict):
        return None
    if architecture.get("output_modalities") == ["text"]:
        return architecture
    return None


def input_bound(endpoint):
    """Endpoint-declared financial input ceiling. Never an estimator output."""
    if endpoint.max_prompt_tokens is not None:
        return endpoint.max_prompt_tokens, "endpoint.max_prompt_tokens capacity"
    return endpoint.context_length, "endpoint.context_length capacity (max_prompt_tokens unknown; input shares the documented context window)"


def output_bound(endpoint, cfg):
    """Documented finite financial ceiling for completion/reasoning tokens.

    Only endpoint-declared capacities count. cfg overrides and reasoning
    request controls are not accepted as universal billing ceilings, and a
    missing max_completion_tokens is unknown evidence resolved through the
    documented shared context window, never an outage by itself.
    """
    if "financial_output_token_bound" in cfg:
        raise TariffError("Unchecked cfg financial_output_token_bound overrides are not accepted; finance from endpoint-declared capacity")
    candidates = []
    if endpoint.max_completion_tokens is not None:
        candidates.append((endpoint.max_completion_tokens, "endpoint.max_completion_tokens capacity"))
    candidates.append((endpoint.context_length, "endpoint.context_length capacity (input and output share the documented context window)"))
    bound, source = min(candidates)
    return bound, source


def endpoint_upstream_bound(endpoint, maxima, cfg):
    """Complete one-attempt upstream bound for one endpoint, with evidence."""
    in_bound, in_source = input_bound(endpoint)
    out_bound, out_source = output_bound(endpoint, cfg)
    # reasoning.max_tokens is a request control for some providers; it does
    # not prove a universal hidden-output billing ceiling, so it never
    # tightens the financial reasoning quantity.
    reasoning_bound = out_bound
    quantities = {"prompt": in_bound, "input_cache_read": in_bound, "input_cache_write": in_bound, "input_cache_write_1h": in_bound, "completion": out_bound, "internal_reasoning": reasoning_bound, "request": 1}
    architecture = _text_only_architecture(cfg)
    components, total = {}, Decimal(0)
    for key, unit in COMPONENT_UNITS.items():
        component_rate = maxima.get(key)
        if component_rate is None:
            continue
        if key in ZERO_QUANTITY_COMPONENTS:
            quantity, treatment = 0, "quantity is zero under the frozen text-only final payload with documented plugins explicitly disabled; raw rate preserved"
        elif key in OUTPUT_MODALITY_COMPONENTS:
            if component_rate > 0 and architecture is None:
                raise TariffError(f"No finite quantity bound can be proved for tariff component: {key}; validated candidate-bound text-only architecture evidence is required")
            quantity, treatment = 0, ("zero quantity: candidate-bound raw model architecture declares output_modalities == ['text']" if component_rate > 0 else "zero rate")
        else:
            quantity, treatment = quantities[key], "endpoint-declared bounded quantity; additive across components"
        charge = component_rate * quantity
        total += charge
        components[key] = {"unit": unit, "max_rate_per_unit": str(component_rate), "quantity_bound": quantity, "max_charge_usd": str(charge), "treatment": treatment}
    detail = {"components": components, "output_token_bound": out_bound, "output_token_bound_source": out_source, "reasoning_token_bound": reasoning_bound, "input_token_bound": in_bound, "input_token_bound_source": in_source}
    if architecture is not None and any(maxima.get(key, Decimal(0)) > 0 for key in OUTPUT_MODALITY_COMPONENTS):
        detail["model_architecture"] = architecture
        detail["model_architecture_sha256"] = digest(architecture)
    return total, detail


def normalize_tier(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise TariffError("Routing context service tier must be a string")
    tier = TIER_ALIASES.get(value, value)
    if tier not in {"default", "flex", "priority", "ultrafast"}:
        raise TariffError("Routing context carries an unknown service tier")
    return tier


def admissible_tiers(cfg, explicit_tags, endpoints_by_tag):
    """Tiers that could serve the final request, plus explicit uncertainty notes."""
    context = cfg.get("routing_context")
    explicit = {endpoints_by_tag[tag].service_tier for tag in explicit_tags if tag in endpoints_by_tag}
    if not isinstance(context, dict) or "workspace_default_service_tier" not in context:
        return set(KNOWN_TIERS), ["workspace default service tier is not in frozen evidence; every documented tier is financed"]
    default = normalize_tier(context.get("workspace_default_service_tier"))
    if default is None:
        # No workspace default and no request tier: standard endpoints, plus
        # open-weight priority endpoints that join default routing. Public
        # endpoint data does not prove open/closed weight, so priority stays.
        tiers = {None, "priority"} | explicit
        notes = ["no workspace default tier; priority endpoints are financed because open-weight priority endpoints can join default routing and weight openness is not in public endpoint evidence"]
    elif default == "default":
        tiers, notes = {None} | explicit, ["workspace default pins the standard tier; explicitly selected tier endpoints remain financed"]
    elif default == "flex":
        tiers, notes = {None, "flex"} | explicit, ["workspace default tier is flex with standard fallback"]
    elif default == "priority":
        tiers, notes = {None, "priority"} | explicit, ["workspace default tier is priority with standard fallback"]
    else:
        tiers, notes = {None, "priority", "ultrafast"} | explicit, ["workspace default tier is ultrafast with priority and standard fallback"]
    allowed = context.get("workspace_allowed_tiers")
    if allowed is not None:
        if not isinstance(allowed, list):
            raise TariffError("Routing context allowed tiers must be a list")
        normalized = {normalize_tier(item) for item in allowed}
        tiers &= {None if item == "default" else item for item in normalized} | {None}
        notes.append("workspace allowed-tier restriction applied from frozen evidence; the default tier is always allowed")
    return tiers, notes


def routing_number(per_token):
    """USD/token -> USD/million for prompt/completion caps only, exact or fail."""
    normalized = rate(per_token, "routing tariff rate")
    with localcontext() as context:
        context.prec = max(28, len(normalized.as_tuple().digits) + 6)
        exact = normalized * 1000000
    numeric = float(exact)
    if not math.isfinite(numeric) or Decimal(json.dumps(numeric)) != exact:
        raise TariffError("Routing tariff cannot serialize exactly without changing the witness rate")
    return numeric


def _eligible(endpoint, cfg):
    if endpoint.status != 0 or not {"reasoning", "max_tokens"}.issubset(endpoint.supported_parameters):
        return False
    if endpoint.context_length < cfg["max_input_tokens"] + cfg["max_output_tokens"]:
        return False
    # max_completion_tokens=None is unknown evidence, not unavailability:
    # the documented shared context window already proves the requested
    # output fits when the context check above passes.
    if endpoint.max_completion_tokens is not None and endpoint.max_completion_tokens < cfg["max_output_tokens"]:
        return False
    if endpoint.max_prompt_tokens is not None and endpoint.max_prompt_tokens < cfg["max_input_tokens"]:
        return False
    return True


def endpoint_quote(endpoints, cfg):
    """Complete text-only financial quote for one candidate. See module docstring."""
    if not isinstance(endpoints, list):
        raise TariffError("Endpoint evidence must be a list")
    for key in ("max_input_tokens", "max_output_tokens"):
        if type(cfg.get(key)) is not int or cfg[key] <= 0:
            raise TariffError(f"Quote requires a positive frozen {key}")
    if "byok_fee_ceiling_fraction" not in cfg:
        raise TariffError("Quote requires the explicit approved BYOK fee allowance")
    fee = rate(cfg["byok_fee_ceiling_fraction"], "BYOK fee fraction")
    model, effort = _candidate(cfg)
    resolved = resolve_variant(cfg.get("variant_catalog"), model, effort) if effort is not None else {}
    parsed = [(raw, parse_endpoint(raw)) for raw in endpoints]
    by_tag = {endpoint.tag: endpoint for _, endpoint in parsed}
    if len(by_tag) != len(parsed):
        raise TariffError("Duplicate endpoint tags in quote evidence")
    eligible = [(raw, endpoint) for raw, endpoint in parsed if _eligible(endpoint, cfg)]
    if not eligible:
        raise RuntimeError(ENDPOINT_UNAVAILABLE)
    priced = {}
    for raw, endpoint in eligible:
        pricing, unknown_zero = parse_pricing(raw.get("pricing"))
        priced[endpoint.tag] = (pricing, component_maxima(pricing), unknown_zero)
    witness_raw, witness = min(eligible, key=lambda item: (rate(item[0]["pricing"]["prompt"], "witness prompt rate"), rate(item[0]["pricing"]["completion"], "witness completion rate"), item[1].tag))
    route_prompt = rate(witness_raw["pricing"]["prompt"], "witness prompt rate")
    route_completion = rate(witness_raw["pricing"]["completion"], "witness completion rate")
    routing_cap = {"prompt": routing_number(route_prompt), "completion": routing_number(route_completion)}
    selected = sorted(endpoint.tag for raw, endpoint in eligible if rate(raw["pricing"]["prompt"], "base prompt rate") <= route_prompt and rate(raw["pricing"]["completion"], "base completion rate") <= route_completion)
    tiers, tier_notes = admissible_tiers(cfg, selected, by_tag)
    if "account_policy" in cfg:
        validate_account_policy(cfg)
    evidence, financial = [], []
    for raw, endpoint in parsed:
        selector_match = any(endpoint.tag == tag or endpoint.tag.startswith(tag + "/") for tag in selected)
        in_closure = endpoint.status == 0 and selector_match and endpoint.service_tier in tiers
        record = {"tag": endpoint.tag, "status": endpoint.status, "service_tier": endpoint.service_tier, "context_length": endpoint.context_length, "max_completion_tokens": endpoint.max_completion_tokens, "max_prompt_tokens": endpoint.max_prompt_tokens, "supported_parameters": list(endpoint.supported_parameters), "supports_implicit_caching": endpoint.supports_implicit_caching, "pricing_raw": raw.get("pricing"), "in_witness_set": endpoint.tag in selected, "in_financial_closure": in_closure}
        if in_closure:
            if endpoint.tag not in priced:
                pricing, unknown_zero = parse_pricing(raw.get("pricing"))
                priced[endpoint.tag] = (pricing, component_maxima(pricing), unknown_zero)
            pricing, maxima, unknown_zero = priced[endpoint.tag]
            bound, detail = endpoint_upstream_bound(endpoint, maxima, cfg)
            record.update({"unknown_zero_components": unknown_zero, "discount_raw": pricing.discount, "discount_factor_applied": str(discount_factor(pricing)), "schedules": [validate_selectors(item) for item in pricing.overrides or []], "component_maxima": {key: str(value) for key, value in sorted(maxima.items())}, "upstream_bound_usd": str(bound), **detail})
            financial.append((endpoint, maxima, bound, detail))
        evidence.append(record)
    if not financial:
        raise TariffError("No selector-matching active endpoint can be financed under the frozen routing context")
    upstream = max(bound for _, _, bound, _ in financial)
    # Component maxima stay correlated per endpoint in endpoint_evidence.
    # There is deliberately no cross-endpoint maxima table to recombine.
    output_financial = max(detail["output_token_bound"] for _, _, _, detail in financial)
    reasoning_financial = max(detail["reasoning_token_bound"] for _, _, _, detail in financial)
    input_financial = max(detail["input_token_bound"] for _, _, _, detail in financial)
    return {
        "policy": FINANCIAL_QUOTE_POLICY,
        "candidate": {"model": model, "effort": effort},
        "resolved_variant": resolved,
        "upstream_bound_usd": str(upstream),
        "attempt_bound_usd": str(upstream * (1 + fee)),
        "fee_fraction": str(fee),
        "financial_components_note": "per-endpoint only; see endpoint_evidence[].component_maxima and components",
        "plugin_policy": {"documented_plugin_ids": list(DOCUMENTED_PLUGIN_IDS), "request_level_disables_required": True, "account_policy_evidence_required_at_dispatch": True, "note": "plugins: [] inherits account defaults and never proves zero plugin charges"},
        "quantities": {"input_tokens": input_financial, "input_token_bound_source": "endpoint-declared max_prompt_tokens or context_length capacity per endpoint; never a token estimate", "requested_max_tokens": cfg["max_output_tokens"], "output_tokens_financial": output_financial, "reasoning_tokens_financial": reasoning_financial, "requests": 1},
        "routing_prompt_per_token": str(route_prompt),
        "routing_completion_per_token": str(route_completion),
        "routing_max_price": routing_cap,
        "routing_witness": {"tag": witness.tag, "prompt_per_token": str(route_prompt), "completion_per_token": str(route_completion), "selection": "lowest current full-context-compatible base prompt, then ITS completion, then tag"},
        "eligible_endpoint_tags": selected,
        "financial_endpoint_tags": sorted(endpoint.tag for endpoint, _, _, _ in financial),
        "endpoint_evidence": evidence,
        "endpoints_sha256": digest(endpoints),
        "public_constraints": {"input_bound": cfg["max_input_tokens"], "max_tokens": cfg["max_output_tokens"], "required_parameters": ["reasoning", "max_tokens"], "status": 0},
        "selector_closure": "provider.only witness tags plus every active regional/tier descendant that could be admitted; raw base prices never exclude a selector-matching endpoint from financial coverage",
        "routing_uncertainty": tier_notes + ["max_price evaluation under discounts/overrides is not fully documented; selector-matching endpoints are financed regardless of raw base prices", "public endpoint data does not prove account privacy, BYOK or workspace eligibility"],
        "privacy_eligibility": "Unproven by endpoint metadata; data_collection=deny and require_parameters remain mandatory at dispatch",
    }


def _record_upstream(record):
    maxima = {key: rate(value, "financial component maximum") for key, value in record["component_maxima"].items()}
    upstream = maxima.get("request", Decimal(0))
    upstream += record["input_token_bound"] * sum((maxima.get(key, Decimal(0)) for key in INPUT_COMPONENTS), Decimal(0))
    upstream += record["output_token_bound"] * maxima.get("completion", Decimal(0))
    upstream += record["reasoning_token_bound"] * maxima.get("internal_reasoning", Decimal(0))
    return upstream


def attempt_reservation(quote, estimated_input_tokens=None):
    """Complete upstream+fee reservation, recomputed per endpoint then maximized.

    Component correlations stay inside each endpoint. An estimated input
    count is recorded for diagnostics only and can never shrink the
    financial input quantity, which is endpoint-declared capacity.
    """
    if not isinstance(quote, dict) or quote.get("policy") != FINANCIAL_QUOTE_POLICY:
        raise TariffError("A complete current financial quote is required before dispatch")
    if estimated_input_tokens is not None and (type(estimated_input_tokens) is not int or estimated_input_tokens < 0):
        raise TariffError("Estimated input tokens must be a nonnegative integer when supplied")
    records = [record for record in quote.get("endpoint_evidence") or [] if isinstance(record, dict) and record.get("in_financial_closure")]
    if not records or any("component_maxima" not in record or "input_token_bound" not in record or "output_token_bound" not in record or "reasoning_token_bound" not in record for record in records):
        raise TariffError("Quote lacks per-endpoint financial evidence for reservation recomputation")
    per_endpoint = [(record["tag"], _record_upstream(record)) for record in records]
    tag, upstream = max(per_endpoint, key=lambda item: item[1])
    if upstream != rate(quote.get("upstream_bound_usd"), "quote upstream bound"):
        raise TariffError("Recomputed per-endpoint reservation does not reproduce the quoted upstream bound")
    fee = rate(quote["fee_fraction"], "quote fee fraction")
    bound = upstream * (1 + fee)
    if bound != rate(quote.get("attempt_bound_usd"), "quote attempt bound"):
        raise TariffError("Recomputed reservation does not reproduce the quoted attempt bound")
    quantities = quote["quantities"]
    return {"upstream_usd": upstream, "fee_usd": bound - upstream, "bound_usd": bound, "financial_input_tokens": quantities["input_tokens"], "estimated_input_tokens": estimated_input_tokens, "max_endpoint_tag": tag, "output_tokens_financial": quantities["output_tokens_financial"], "reasoning_tokens_financial": quantities["reasoning_tokens_financial"]}


def validate_quote(candidate):
    quote = candidate.get("financial_quote") if isinstance(candidate, dict) else None
    if not isinstance(quote, dict) or quote.get("policy") != FINANCIAL_QUOTE_POLICY:
        raise TariffError("A complete current financial quote is required; token-only bounds are not a full charge")
    upstream, attempt = rate(quote.get("upstream_bound_usd"), "quote upstream bound"), rate(quote.get("attempt_bound_usd"), "quote attempt bound")
    fee = rate(quote.get("fee_fraction"), "quote fee fraction")
    if attempt != upstream * (1 + fee):
        raise TariffError("Quote attempt bound is not upstream plus the approved fee fraction")
    if not quote.get("eligible_endpoint_tags") or not quote.get("financial_endpoint_tags") or not quote.get("endpoint_evidence"):
        raise TariffError("Quote lacks endpoint closure evidence")
    return quote


ROLES = {"system", "user", "assistant"}
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")


class RequestContractError(ValueError):
    """Final outbound payload rejection. Messages never carry prompt content."""


def validate_account_policy(cfg):
    """Frozen account-plugin evidence, normalized. Raises when unresolved.

    cfg["account_policy"] must be the parent's frozen export summary:
    {"source": str, "captured_at": epoch seconds, "raw_sha256": hex str,
     "default_plugins": [{"id": str, "enabled": bool,
                          "prevent_overrides": bool}, ...]}.
    Public metadata never proves this state; the parent binds the raw
    export by hash. An enabled enforced ("Prevent overrides") plugin can
    never be disabled at request level and blocks dispatch outright.
    """
    policy = cfg.get("account_policy")
    if not isinstance(policy, dict) or set(policy) != {"source", "captured_at", "raw_sha256", "default_plugins"}:
        raise TariffError("Frozen account policy evidence is required before paid dispatch; plugin defaults are unresolved")
    if not isinstance(policy["source"], str) or not policy["source"].strip() or not isinstance(policy["raw_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", policy["raw_sha256"]):
        raise TariffError("Account policy evidence must name its source and bind the raw export hash")
    captured = policy["captured_at"]
    if isinstance(captured, bool) or not isinstance(captured, (int, float)) or not math.isfinite(captured) or captured <= 0:
        raise TariffError("Account policy evidence must carry a finite capture time")
    defaults = policy["default_plugins"]
    if not isinstance(defaults, list):
        raise TariffError("Account policy default_plugins must be a list")
    normalized, seen = [], set()
    for item in defaults:
        if not isinstance(item, dict) or set(item) != {"id", "enabled", "prevent_overrides"} or not isinstance(item["id"], str) or not item["id"] or not isinstance(item["enabled"], bool) or not isinstance(item["prevent_overrides"], bool) or item["id"] in seen:
            raise TariffError("Account policy default plugin entries are malformed")
        seen.add(item["id"])
        if item["enabled"] and item["prevent_overrides"]:
            raise TariffError(f"Account plugin is enforced and cannot be disabled per request: {item['id']}")
        normalized.append(dict(item))
    return {"source": policy["source"], "captured_at": captured, "raw_sha256": policy["raw_sha256"], "default_plugins": normalized}


def disabled_plugins(policy):
    """Request-level disables for every documented or account-named plugin."""
    ids = list(DOCUMENTED_PLUGIN_IDS)
    for item in policy["default_plugins"]:
        if item["id"] not in ids:
            ids.append(item["id"])
    return [{"id": plugin_id, "enabled": False} for plugin_id in ids]


def _contract_core(contract):
    return {key: contract.get(key) for key in ("model", "variant_label", "resolved_variant", "max_tokens", "provider", "plugins", "financial_quote_sha256")}


def request_contract(candidate, cfg, quote_fetched_at=None, quote_max_age_seconds=7200):
    """The immutable approved contract one paid request must match exactly."""
    quote = validate_quote(candidate)
    model, effort = candidate.get("model"), candidate.get("effort")
    quoted = quote.get("candidate") if isinstance(quote.get("candidate"), dict) else {}
    if quoted.get("model") != model or quoted.get("effort") != effort:
        raise TariffError("Financial quote candidate identity does not match the requested model and effort")
    if cfg.get("max_output_tokens") != quote["quantities"]["requested_max_tokens"]:
        raise TariffError("Requested max_tokens differs from the quoted request quantity")
    resolved = resolve_variant(cfg.get("variant_catalog"), model, effort)
    if resolved != quote.get("resolved_variant"):
        raise TariffError("Resolved variant no longer matches the quoted variant")
    if type(quote_max_age_seconds) is not int or quote_max_age_seconds <= 0:
        raise TariffError("Quote maximum age must be a positive integer")
    policy_max_age = cfg.get("account_policy_max_age_seconds", 7200)
    if type(policy_max_age) is not int or policy_max_age <= 0:
        raise TariffError("Account policy maximum age must be a positive integer")
    policy = validate_account_policy(cfg)
    contract = {
        "model": model,
        "variant_label": effort,
        "resolved_variant": copy.deepcopy(resolved),
        "max_tokens": cfg["max_output_tokens"],
        "provider": {"only": list(quote["eligible_endpoint_tags"]), "max_price": dict(quote["routing_max_price"]), "allow_fallbacks": False, "require_parameters": True, "data_collection": "deny"},
        "plugins": disabled_plugins(policy),
        "account_policy": policy,
        "account_policy_max_age_seconds": policy_max_age,
        "financial_quote_sha256": digest(quote),
        "quote_fetched_at": quote_fetched_at,
        "quote_max_age_seconds": quote_max_age_seconds,
    }
    contract["contract_sha256"] = digest(_contract_core(contract))
    return contract


def _finite_number(value):
    return (type(value) is int and not isinstance(value, bool)) or (type(value) is float and math.isfinite(value))


def validate_final_payload(payload, contract):
    """Validate the post-variant payload and return the exact bytes to send.

    Runs on the actual outbound representation. Callers must post the
    returned immutable bytes and never mutate the payload afterwards.
    """
    if not isinstance(contract, dict) or not isinstance(payload, dict):
        raise RequestContractError("Final request requires an approved contract and payload object")
    if contract.get("contract_sha256") != digest(_contract_core(contract)):
        raise RequestContractError("Approved contract was mutated after construction")
    resolved = contract.get("resolved_variant") or {}
    expected = {"model", "messages", "max_tokens", "usage", "stream", "plugins", "provider"}
    if "reasoning" in resolved:
        expected.add("reasoning")
    if "verbosity" in resolved:
        expected.add("verbosity")
    if set(payload) != expected:
        raise RequestContractError("Final request top-level fields differ from the approved contract")
    model = payload["model"]
    if not isinstance(model, str) or model != contract.get("model") or not MODEL_RE.fullmatch(model) or ":" in model or "@" in model:
        raise RequestContractError("Final request model is not the concrete quoted model")
    messages = payload["messages"]
    if not isinstance(messages, list) or not messages:
        raise RequestContractError("Final request messages must be a nonempty list")
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or set(message) != {"role", "content"} or message.get("role") not in ROLES or not isinstance(message.get("content"), str):
            raise RequestContractError(f"Final request message {index} is not approved text-only content")
    if messages[-1]["role"] == "assistant":
        raise RequestContractError("Final request must not end with an assistant prefill message")
    if type(payload["max_tokens"]) is not int or payload["max_tokens"] != contract.get("max_tokens"):
        raise RequestContractError("Final request max_tokens differs from the approved contract")
    if "reasoning" in resolved:
        validate_reasoning(payload["reasoning"], "final reasoning")
        if payload["reasoning"] != resolved["reasoning"]:
            raise RequestContractError("Final request reasoning differs from the frozen variant")
    if "verbosity" in resolved and payload["verbosity"] != resolved["verbosity"]:
        raise RequestContractError("Final request verbosity differs from the frozen variant")
    if payload["stream"] is not False or payload["usage"] != {"include": True}:
        raise RequestContractError("Final request stream or usage differs from the approved contract")
    plugins = payload["plugins"]
    if not isinstance(plugins, list) or plugins != contract.get("plugins") or any(not isinstance(item, dict) or set(item) != {"id", "enabled"} or item.get("enabled") is not False for item in plugins):
        raise RequestContractError("Final request plugins are not the exact approved request-level disables")
    provider = payload["provider"]
    if not isinstance(provider, dict) or provider != contract.get("provider"):
        raise RequestContractError("Final request provider controls differ from the approved contract")
    max_price = provider.get("max_price") or {}
    if set(max_price) != {"prompt", "completion"} or any(not _finite_number(value) or value < 0 for value in max_price.values()):
        raise RequestContractError("Final request provider caps are not the exact paired witness caps")
    try:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()
    except (TypeError, ValueError) as error:
        raise RequestContractError("Final request is not finite JSON data") from error
    if json.loads(raw) != payload:
        raise RequestContractError("Final request does not survive exact JSON serialization")
    return raw


def request_bytes_sha256(raw):
    return hashlib.sha256(raw).hexdigest()





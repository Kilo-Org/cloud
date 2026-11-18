"""Text-only tariff bounds at the dearest public provider price.

The Kilo catalog price is not a bound: the gateway can route to a provider
whose public price is far above it. A quote therefore takes per-component
maxima over the Kilo catalog pricing and every public OpenRouter endpoint
price for the model, including every schedule override tier, with positive
discounts undone because a discount can expire. The bound is an input rate
over a byte-based input ceiling plus 2048, an output rate over the frozen
max_tokens, and the per-request fee, summed across components. Spending
control is the local ledger only; no per-request cap is sent. Anything
outside the documented pricing schema, missing endpoint evidence, or a
quantity without a finite bound is a quote failure (TariffError), never a
model outage.
"""

import copy
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import hashlib
import json
import math
import re
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

FINANCIAL_QUOTE_POLICY = "kilo-gateway-dearest-public-max-v2"
MODEL_UNAVAILABLE = "No Kilo catalog model meets frozen text/context/output constraints"
GATEWAY_INPUT_FUDGE_TOKENS = 2048
KNOWN_TIERS = {None, "flex", "priority", "ultrafast"}
CLASSIFIER_QUOTE_POLICY = "public-endpoint-classifier-max-v1"
# The largest classifier request (buildClassifierRequest in
# packages/auto-routing-contracts, every prefix at its length cap with 4-byte
# code points) serializes to 27,061 UTF-8 bytes, and one token never exceeds
# one byte. 32,768 input tokens bounds one question attempt with margin.
# One billed classification runs per gateway request, with at most two HTTP
# attempts. Billing may be per question, and the request has six questions,
# so the bound prices every question on every attempt. The classifier
# request sends no max_tokens, so its output price must be exactly zero.
CLASSIFIER_INPUT_TOKENS_PER_QUESTION_ATTEMPT = 32768
CLASSIFIER_QUESTIONS_PER_CLASSIFICATION = 6
CLASSIFIER_MAX_ATTEMPTS_PER_CLASSIFICATION = 2

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
SELECTOR_KEYS = {"min_prompt_tokens", "utc_days", "utc_start", "utc_end"}

# Documented component units from the catalog Pricing schema.
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
# audio input parts and no tools or search in the final payload.
ZERO_QUANTITY_COMPONENTS = ("audio", "image", "image_token", "input_audio_cache", "web_search")
# Output modalities are not fully request-controlled. A nonzero rate blocks
# unless frozen quantity evidence proves a zero quantity for the candidate.
OUTPUT_MODALITY_COMPONENTS = ("audio_output", "image_output")
PRICE_KEYS = frozenset(COMPONENT_UNITS)
# PricingOverride carries only this documented subset of price keys.
OVERRIDE_PRICE_KEYS = frozenset({"prompt", "completion", "input_cache_read", "input_cache_write", "input_cache_write_1h", "audio", "input_audio_cache"})


class TariffError(RuntimeError, ValueError):
    """A quote/admission failure. Never a model-availability record."""


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


def _schema_error(error, what):
    locations = sorted({".".join(str(part) for part in item.get("loc", ())) for item in error.errors()})
    return TariffError(f"Invalid {what} schema at: {', '.join(locations)}")


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
        raise TariffError("Catalog pricing evidence must be an object")
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
        raise _schema_error(error, "catalog pricing") from error
    if pricing.prompt <= 0 or (require_positive and pricing.completion <= 0):
        raise TariffError("Require explicit positive prompt and completion token pricing")
    discount = _decimal(pricing.discount, "pricing discount") if pricing.discount is not None else Decimal(0)
    if discount >= 1:
        raise TariffError("Pricing discount of one or above cannot be undone to a finite undiscounted price")
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
    """Undo the discount: a positive discount can expire, a negative one is a markup."""
    discount = _decimal(pricing.discount, "pricing discount") if pricing.discount is not None else Decimal(0)
    if discount >= 1:
        raise TariffError("Pricing discount of one or above cannot be undone to a finite undiscounted price")
    return (1 - discount) if discount < 0 else Decimal(1) / (1 - discount)


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


def _text_only_architecture(architecture):
    """Raw candidate-bound model architecture proving text-only output, or None."""
    if not isinstance(architecture, dict):
        return None
    if architecture.get("output_modalities") == ["text"]:
        return architecture
    return None


ORGANIZATION_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def validate_organization_id(value):
    """Canonical UUID organization id, or fail closed. Never a secret."""
    if not isinstance(value, str) or not ORGANIZATION_ID_RE.fullmatch(value):
        raise TariffError("A frozen canonical Kilo organization UUID is required")
    return value.lower()


def ceil_microdollars(value):
    """Round a USD bound up to whole microdollars."""
    return _decimal(value, "USD bound").quantize(Decimal("0.000001"), rounding=ROUND_CEILING)


def _rates(maxima):
    input_rate = sum((maxima.get(key, Decimal(0)) for key in INPUT_COMPONENTS), Decimal(0))
    output_rate = sum((maxima.get(key, Decimal(0)) for key in OUTPUT_COMPONENTS), Decimal(0))
    return input_rate, output_rate, maxima.get("request", Decimal(0))


def _bound(maxima, input_quantity, output_quantity, allowance):
    input_rate, output_rate, request_rate = _rates(maxima)
    solver = input_rate * input_quantity + output_rate * output_quantity + request_rate
    return solver, ceil_microdollars(solver + allowance)


def _components(maxima, input_quantity, output_quantity, architecture):
    quantities = {key: input_quantity for key in INPUT_COMPONENTS}
    quantities.update({key: output_quantity for key in OUTPUT_COMPONENTS})
    quantities["request"] = 1
    components = {}
    for key, unit in COMPONENT_UNITS.items():
        component_rate = maxima.get(key)
        if component_rate is None:
            continue
        if key in ZERO_QUANTITY_COMPONENTS:
            quantity, treatment = 0, "quantity is zero under the frozen text-only final payload; raw rate preserved"
        elif key in OUTPUT_MODALITY_COMPONENTS:
            if component_rate > 0 and architecture is None:
                raise TariffError(f"No finite quantity bound can be proved for tariff component: {key}; validated candidate-bound text-only architecture evidence is required")
            quantity, treatment = 0, ("zero quantity: candidate-bound raw model architecture declares output_modalities == ['text']" if component_rate > 0 else "zero rate")
        else:
            quantity, treatment = quantities[key], "frozen bounded quantity; additive across components"
        components[key] = {"unit": unit, "max_rate_per_unit": str(component_rate), "quantity_bound": quantity, "max_charge_usd": str(component_rate * quantity), "treatment": treatment}
    return components


def _quote_dict(model, effort, resolved, maxima, cfg, allowance, extra):
    input_quantity = cfg["max_input_tokens"] + GATEWAY_INPUT_FUDGE_TOKENS
    output_quantity = cfg["max_output_tokens"]
    solver, attempt = _bound(maxima, input_quantity, output_quantity, allowance)
    return {
        "policy": FINANCIAL_QUOTE_POLICY,
        "candidate": {"model": model, "effort": effort},
        "resolved_variant": resolved,
        "solver_bound_usd": str(solver),
        "classifier_allowance_usd": str(allowance),
        "attempt_bound_usd": str(attempt),
        "component_maxima": {key: str(value) for key, value in sorted(maxima.items())},
        "quantities": {"input_quantity": input_quantity, "max_input_tokens": cfg["max_input_tokens"], "output_tokens": output_quantity, "requested_max_tokens": cfg["max_output_tokens"], "requests": 1},
        **extra,
    }


def _allowance(value):
    allowance = _decimal(value, "classifier allowance") if value is not None else Decimal(0)
    if allowance < 0:
        raise TariffError("Classifier allowance must be nonnegative")
    return allowance


def _endpoint_maxima(endpoints, require_positive=True):
    """Per-component maxima over every public endpoint price, overrides included."""
    if not isinstance(endpoints, list) or not endpoints:
        raise TariffError("Public endpoint price evidence is required; the catalog price alone is not a bound")
    parsed = [(raw, parse_endpoint(raw)) for raw in endpoints]
    if len({endpoint.tag for _, endpoint in parsed}) != len(parsed):
        raise TariffError("Duplicate endpoint tags in quote evidence")
    maxima, evidence = {}, []
    for raw, endpoint in parsed:
        pricing, unknown_zero = parse_pricing(raw.get("pricing"), require_positive=require_positive)
        endpoint_maxima = component_maxima(pricing)
        for key, value in endpoint_maxima.items():
            maxima[key] = max(maxima.get(key, Decimal(0)), value)
        evidence.append({"tag": endpoint.tag, "status": endpoint.status, "service_tier": endpoint.service_tier, "context_length": endpoint.context_length, "max_completion_tokens": endpoint.max_completion_tokens, "max_prompt_tokens": endpoint.max_prompt_tokens, "supported_parameters": list(endpoint.supported_parameters), "pricing_raw": raw.get("pricing"), "unknown_zero_components": unknown_zero, "discount_factor_applied": str(discount_factor(pricing)), "component_maxima": {key: str(value) for key, value in sorted(endpoint_maxima.items())}})
    return maxima, evidence


def catalog_quote(entry, cfg, classifier_allowance_usd=None, endpoints=None):
    """Complete text-only quote at the dearest public price for one model.

    Required cfg keys: max_input_tokens, max_output_tokens, candidate
    {model, effort}, and variant_catalog (loaded dict) for variant= labels.
    The entry is one raw Kilo catalog model object and endpoints is the raw
    public endpoint list for the same model; both are preserved by hash.
    """
    if not isinstance(entry, dict):
        raise TariffError("Catalog model evidence must be an object")
    for key in ("max_input_tokens", "max_output_tokens"):
        if type(cfg.get(key)) is not int or cfg[key] <= 0:
            raise TariffError(f"Quote requires a positive frozen {key}")
    model, effort = _candidate(cfg)
    if entry.get("id") != model:
        raise TariffError("Catalog quote model identity mismatch")
    context = entry.get("context_length")
    if type(context) is not int or context <= 0:
        raise TariffError("Catalog model requires a positive context_length")
    if context < cfg["max_input_tokens"] + cfg["max_output_tokens"]:
        raise RuntimeError(MODEL_UNAVAILABLE)
    supported = entry.get("supported_parameters")
    if not isinstance(supported, list) or not all(isinstance(item, str) for item in supported):
        raise TariffError("Catalog model lacks supported_parameters evidence")
    if not {"reasoning", "max_tokens"}.issubset(supported):
        raise RuntimeError(MODEL_UNAVAILABLE)
    resolved = resolve_variant(cfg.get("variant_catalog"), model, effort) if effort is not None else {}
    pricing, unknown_zero = parse_pricing(entry.get("pricing"))
    maxima = component_maxima(pricing)
    endpoint_maxima, endpoint_evidence = _endpoint_maxima(endpoints)
    for key, value in endpoint_maxima.items():
        maxima[key] = max(maxima.get(key, Decimal(0)), value)
    architecture = _text_only_architecture(entry.get("architecture"))
    components = _components(maxima, cfg["max_input_tokens"] + GATEWAY_INPUT_FUDGE_TOKENS, cfg["max_output_tokens"], architecture)
    extra = {"components": components, "pricing_raw": entry.get("pricing"), "unknown_zero_components": unknown_zero, "context_length": context, "supported_parameters": list(supported), "catalog_entry_sha256": digest(entry), "endpoint_evidence": endpoint_evidence, "endpoints_sha256": digest(endpoints)}
    if architecture is not None and any(maxima.get(key, Decimal(0)) > 0 for key in OUTPUT_MODALITY_COMPONENTS):
        extra["model_architecture"] = architecture
        extra["model_architecture_sha256"] = digest(architecture)
    return _quote_dict(model, effort, resolved, maxima, cfg, _allowance(classifier_allowance_usd), extra)


def worst_case_quote(quotes, model, effort, cfg, classifier_allowance_usd=None):
    """Router-arm quote: per-component maximum over every pool quote, plus allowance."""
    if not quotes:
        raise TariffError("Router quote requires at least one quoted pool model")
    maxima = {}
    for quote in quotes:
        validate_quote({"financial_quote": quote})
        for key, value in quote["component_maxima"].items():
            maxima[key] = max(maxima.get(key, Decimal(0)), rate(value, "pool component maximum"))
    quantities = {tuple(sorted(quote["quantities"].items())) for quote in quotes}
    if len(quantities) != 1:
        raise TariffError("Pool quotes do not share one frozen quantity contract")
    resolved = resolve_variant(cfg.get("variant_catalog"), model, effort) if effort is not None else {}
    extra = {"pool_quote_sha256": sorted(digest(quote) for quote in quotes), "pool_models": sorted({quote["candidate"]["model"] for quote in quotes})}
    return _quote_dict(model, effort, resolved, maxima, cfg, _allowance(classifier_allowance_usd), extra)


def classifier_endpoint_quote(model, endpoints):
    """Classifier price from public endpoints only; the Kilo catalog does not list it.

    The classifier request sends no max_tokens, so a priced output cannot
    be bounded: every endpoint output price must be exactly zero.
    """
    if not isinstance(model, str) or not MODEL_RE.fullmatch(model):
        raise TariffError("Classifier quote requires an exact model id")
    maxima, evidence = _endpoint_maxima(endpoints, require_positive=False)
    for record in evidence:
        for key in OUTPUT_COMPONENTS:
            if rate(record["component_maxima"].get(key, "0"), "classifier output rate") != 0:
                raise TariffError(f"Classifier endpoint {record['tag']} prices {key} output; the classifier request sends no max_tokens, so the quote fails")
    quote = {"policy": CLASSIFIER_QUOTE_POLICY, "model": model, "component_maxima": {key: str(value) for key, value in sorted(maxima.items())}, "endpoint_evidence": evidence, "endpoints_sha256": digest(endpoints)}
    return {**quote, "bound_usd": str(classifier_allowance_bound(quote))}


def classifier_allowance_bound(quote):
    """Bound: dearest input rate x 32768 x 6 questions x 2 attempts, plus request fees."""
    if not isinstance(quote, dict) or not isinstance(quote.get("component_maxima"), dict):
        raise TariffError("Classifier quote lacks component maxima")
    maxima = {key: rate(value, "classifier component maximum") for key, value in quote["component_maxima"].items()}
    input_rate, output_rate, request_rate = _rates(maxima)
    if output_rate != 0:
        raise TariffError("Classifier output price must be exactly zero; the classifier request sends no max_tokens")
    per_question_attempt = input_rate * CLASSIFIER_INPUT_TOKENS_PER_QUESTION_ATTEMPT + request_rate
    return ceil_microdollars(per_question_attempt * CLASSIFIER_QUESTIONS_PER_CLASSIFICATION * CLASSIFIER_MAX_ATTEMPTS_PER_CLASSIFICATION)


def attempt_reservation(quote, estimated_input_tokens=None, request_bytes=None):
    """Per-request reservation from the actual byte-based input bound.

    The input quantity is the larger of the caller's conservative input
    bound and the exact request byte length, plus a 2048 fudge. The bound
    is rounded up to whole microdollars for exact ledger accounting.
    """
    validate_quote({"financial_quote": quote})
    for value, what in ((estimated_input_tokens, "estimated input tokens"), (request_bytes, "request bytes")):
        if value is not None and (type(value) is not int or value < 0):
            raise TariffError(f"{what} must be a nonnegative integer when supplied")
    quantity = max(estimated_input_tokens or 0, request_bytes or 0) + GATEWAY_INPUT_FUDGE_TOKENS
    maxima = {key: rate(value, "financial component maximum") for key, value in quote["component_maxima"].items()}
    allowance = rate(quote["classifier_allowance_usd"], "classifier allowance")
    solver, bound = _bound(maxima, quantity, quote["quantities"]["output_tokens"], allowance)
    return {"bound_usd": bound, "solver_usd": solver, "classifier_allowance_usd": allowance, "input_quantity": quantity, "estimated_input_tokens": estimated_input_tokens, "request_bytes": request_bytes, "output_tokens": quote["quantities"]["output_tokens"]}


def validate_quote(candidate):
    quote = candidate.get("financial_quote") if isinstance(candidate, dict) else None
    if not isinstance(quote, dict) or quote.get("policy") != FINANCIAL_QUOTE_POLICY:
        raise TariffError("A complete current Kilo catalog quote is required; token-only bounds are not a full charge")
    maxima_raw = quote.get("component_maxima")
    quantities = quote.get("quantities") if isinstance(quote.get("quantities"), dict) else {}
    if not isinstance(maxima_raw, dict) or not maxima_raw or type(quantities.get("input_quantity")) is not int or type(quantities.get("output_tokens")) is not int:
        raise TariffError("Quote lacks component maxima or frozen quantities")
    maxima = {key: rate(value, "financial component maximum") for key, value in maxima_raw.items()}
    allowance = rate(quote.get("classifier_allowance_usd"), "classifier allowance")
    solver, attempt = _bound(maxima, quantities["input_quantity"], quantities["output_tokens"], allowance)
    if rate(quote.get("solver_bound_usd"), "quote solver bound") != solver or rate(quote.get("attempt_bound_usd"), "quote attempt bound") != attempt:
        raise TariffError("Quote bounds do not reproduce from its component maxima and allowance")
    quoted = quote.get("candidate") if isinstance(quote.get("candidate"), dict) else {}
    if not isinstance(quoted.get("model"), str) or not quoted["model"]:
        raise TariffError("Quote lacks its candidate model identity")
    return quote


ROLES = {"system", "user", "assistant"}
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")


class RequestContractError(ValueError):
    """Final outbound payload rejection. Messages never carry prompt content."""


def _contract_core(contract):
    return {key: contract.get(key) for key in ("model", "variant_label", "resolved_variant", "max_tokens", "kilo_organization_id", "financial_quote_sha256")}


def request_contract(candidate, cfg, quote_fetched_at=None, quote_max_age_seconds=7200):
    """The immutable approved contract one gateway request must match exactly."""
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
    contract = {
        "model": model,
        "variant_label": effort,
        "resolved_variant": copy.deepcopy(resolved),
        "max_tokens": cfg["max_output_tokens"],
        "kilo_organization_id": validate_organization_id(cfg.get("kilo_organization_id")),
        "financial_quote_sha256": digest(quote),
        "quote_fetched_at": quote_fetched_at,
        "quote_max_age_seconds": quote_max_age_seconds,
    }
    contract["contract_sha256"] = digest(_contract_core(contract))
    return contract


def validate_final_payload(payload, contract):
    """Validate the post-variant payload and return the exact bytes to send.

    Runs on the actual outbound representation. Callers must post the
    returned immutable bytes and never mutate the payload afterwards. The
    gateway deletes client `usage` and may replace `provider`, so neither is
    sent; plugins and tools are absent, not disabled by name.
    """
    if not isinstance(contract, dict) or not isinstance(payload, dict):
        raise RequestContractError("Final request requires an approved contract and payload object")
    if contract.get("contract_sha256") != digest(_contract_core(contract)):
        raise RequestContractError("Approved contract was mutated after construction")
    resolved = contract.get("resolved_variant") or {}
    expected = {"model", "messages", "max_tokens", "stream"}
    if "reasoning" in resolved:
        expected.add("reasoning")
    if "verbosity" in resolved:
        expected.add("verbosity")
    if set(payload) != expected:
        raise RequestContractError("Final request top-level fields differ from the approved contract")
    model = payload["model"]
    if not isinstance(model, str) or model != contract.get("model") or not MODEL_RE.fullmatch(model) or ":" in model or "@" in model:
        raise RequestContractError("Final request model is not the quoted model")
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
    if payload["stream"] is not False:
        raise RequestContractError("Final request stream differs from the approved contract")
    try:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()
    except (TypeError, ValueError) as error:
        raise RequestContractError("Final request is not finite JSON data") from error
    if json.loads(raw) != payload:
        raise RequestContractError("Final request does not survive exact JSON serialization")
    return raw


def request_bytes_sha256(raw):
    return hashlib.sha256(raw).hexdigest()

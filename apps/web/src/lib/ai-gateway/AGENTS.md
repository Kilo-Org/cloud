# AI Gateway

## Organization Model/Provider Policies

`checkOrganizationModelRestrictions` in [`llm-proxy-helpers.ts`](./llm-proxy-helpers.ts) enforces Enterprise-plan `model_deny_list`, `provider_allow_list`, and `provider_deny_list` settings.

**Custom LLM models ([`custom-llm/`](./custom-llm)) and direct BYOK models ([`providers/direct-byok/`](./providers/direct-byok)) must not be subject to these policies.** Enabling either requires explicit admin action (configuring a custom LLM entry in the admin panel, or an organization admin adding BYOK credentials), so the organization has already consented to these models being available. Running them through the allow/deny lists is unnecessary — the admin can simply not enable the model — and counterproductive, because the lists target public model IDs and providers, which do not correspond to custom-llm public IDs or the `direct-byok` provider marker.

## Forbidden Free Models

[`forbidden-free-models.ts`](./forbidden-free-models.ts) lists free-tier model IDs that must be blocked from direct use. When a free Kilo-exclusive model is removed from the active model catalogue, **add its public ID to `forbiddenFreeModelIds`** so that it cannot be selected directly by clients that still reference the old ID. This applies both to models that were entirely discontinued and to models that remain accessible only indirectly through `kilo-auto`. Do not annotate individual entries in that set with comments explaining why they are forbidden; this file-level documentation covers the rationale.

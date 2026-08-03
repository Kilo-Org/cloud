# AI Gateway

## Organization model/provider policies

Custom LLM models ([`custom-llm/`](./custom-llm)) and direct BYOK models ([`providers/direct-byok/`](./providers/direct-byok)) must not be passed through `checkOrganizationModelRestrictions`. Enabling either already requires explicit admin action, so enforcing the organization's model/provider allow/deny lists on them is unnecessary and counterproductive.

## Unavailable models

When a model must be made unavailable (for example a free Kilo-exclusive model removed from the code base, or a region-restricted model), add its public ID to `unavailableModelIds` in [`unavailable-models.ts`](./unavailable-models.ts) so stale clients get a generic unavailable-model error.

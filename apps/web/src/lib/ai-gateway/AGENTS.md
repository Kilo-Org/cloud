# AI Gateway

## Organization model/provider policies

Custom LLM models ([`custom-llm/`](./custom-llm)) and direct BYOK models ([`providers/direct-byok/`](./providers/direct-byok)) must not be passed through `checkOrganizationModelRestrictions`. Enabling either already requires explicit admin action, so enforcing the organization's model/provider allow/deny lists on them is unnecessary and counterproductive.

## Forbidden free models

When a free Kilo-exclusive model is removed, add its public ID to `forbiddenFreeModelIds` in [`forbidden-free-models.ts`](./forbidden-free-models.ts) so stale clients cannot keep invoking it directly.

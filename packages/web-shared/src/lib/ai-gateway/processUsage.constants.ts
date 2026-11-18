// For BYOK (Bring Your Own Key) requests, OpenRouter only reports 5% of the actual cost
// because that's what they charge for the BYOK feature. Although we now use upstream_inference_cost, we still do some sanity checks.
export const OPENROUTER_BYOK_COST_MULTIPLIER = 20.0;

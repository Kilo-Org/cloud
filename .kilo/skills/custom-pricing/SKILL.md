---
name: custom-pricing
description: Builds custom model pricing JSON for the admin Gateway > Custom Pricing screen by fetching list prices from OpenRouter or Vercel AI Gateway and applying a requested discount. Use when asked to discount a model, add or update custom pricing, mirror a provider promotion, or prepare JSON to paste into the Custom Pricing editor.
---

# Custom pricing

Custom pricing replaces the price Kilo bills and shows for exact gateway model IDs. It is
stored in `ai_gateway_config.custom_pricing` and edited at `/admin/gateway?tab=custom-pricing`.
When nothing is stored, the gateway uses `CUSTOM_PRICING_FALLBACK_CONFIG` in
`packages/web-shared/src/lib/ai-gateway/custom-pricing.constants.ts`. The schema is
`CustomPricingConfigSchema` in `packages/db/src/schema-types.ts`.

## Format

```json
{
  "models": [
    {
      "model": "google/gemini-4-argon",
      "discountPercentage": 50,
      "fallbackOnly": false,
      "pricing": [
        {
          "start_context_length": 0,
          "pricing": {
            "prompt_per_million": 2,
            "completion_per_million": 10,
            "input_cache_read_per_million": 0.1,
            "input_cache_write_per_million": 0.1875
          }
        }
      ]
    }
  ]
}
```

- Prices are USD per million tokens. The first tier starts at 0; later tiers start at strictly
  ascending total input token counts, and the highest tier at or below the request's input
  length applies.
- A `null` cache price bills those tokens at `prompt_per_million`.
- `discountPercentage` only appends `(N% off)` to the model name. It never changes a price.
- `fallbackOnly: true` bills the prices only when the upstream reports no cost. Omit it for a
  real discount.
- `model` must be the exact ID users request, including variants such as `:free`.

## Workflow

1. Confirm the gateway model IDs, the discount percentage, and the source: `openrouter`
   (default; Kilo's catalog comes from OpenRouter) or `vercel`.
2. Generate entries with the bundled script. It fetches public pricing, needs no API key, and
   does the arithmetic, so do not compute prices by hand:

   ```bash
   node .kilo/skills/custom-pricing/scripts/discounted-pricing.mjs \
     --source openrouter --discount 20 google/gemini-2.5-pro anthropic/claude-sonnet-4.5
   ```

   - When OpenRouter endpoints of a model have different list prices, the script exits and lists
     each endpoint tag with its discounted base tier. Ask the user which endpoint to price from,
     then rerun with `--provider <tag>`. Do not pick one silently.
   - Use `gateway-id=source-id` when the source names the model differently, for example
     `--source vercel google/gemini-2.5-pro=google/gemini-2.5-pro-preview`.
   - `--fallback-only` sets `fallbackOnly`. `--no-label` omits `discountPercentage`.
3. Merge the printed entries into the current configuration: ask the user to paste the JSON from
   the admin screen (it shows the in-code defaults when nothing is stored), replace entries with
   the same `model`, keep the rest, and return the complete `{ "models": [...] }` document for
   the user to paste and save.
4. State the source, endpoint, discount, and each model's resulting base prices in the reply.

## Source notes

- OpenRouter: `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`. Endpoint
  prices are per token and already reduced by the endpoint's `discount` fraction; the script
  divides by `1 - discount` to recover the list price before applying the requested discount.
  `overrides[].min_prompt_tokens` become later tiers.
- Vercel AI Gateway: `GET https://ai-gateway.vercel.sh/v1/models`. `*_tiers[].min` become tier
  starts. Vercel's thresholds can differ by one token from OpenRouter's (for example `200001`
  versus `200000`); keep the source's value.
- Neither source's service tiers, regional prices, web search, image, or audio prices are
  represented; custom pricing only covers text tokens.

#!/usr/bin/env node
// Prints discounted custom pricing entries for the admin Gateway > Custom Pricing screen.
// Usage: node discounted-pricing.mjs --source openrouter|vercel --discount <percent>
//          [--provider <OpenRouter endpoint tag>] [--fallback-only] [--no-label]
//          <gateway-model-id>[=<source-model-id>] ...

import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: 'string' },
    discount: { type: 'string' },
    provider: { type: 'string' },
    'fallback-only': { type: 'boolean', default: false },
    'no-label': { type: 'boolean', default: false },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

const discountPercentage = Number(values.discount);
if (!['openrouter', 'vercel'].includes(values.source)) fail('--source must be openrouter or vercel');
if (!Number.isFinite(discountPercentage) || discountPercentage < 0 || discountPercentage > 100)
  fail('--discount must be a percentage between 0 and 100');
if (positionals.length === 0) fail('Pass at least one gateway model ID');

const factor = 1 - discountPercentage / 100;

/** USD per token string -> discounted USD per million tokens, without float noise. */
function perMillion(perToken) {
  if (perToken === undefined || perToken === null) return null;
  const value = Number(perToken);
  if (!Number.isFinite(value) || value < 0) fail(`Invalid upstream price: ${perToken}`);
  return Number((value * 1_000_000 * factor).toPrecision(12));
}

function tier(start_context_length, prices) {
  return {
    start_context_length,
    pricing: {
      prompt_per_million: perMillion(prices.prompt),
      completion_per_million: perMillion(prices.completion),
      input_cache_read_per_million: perMillion(prices.input_cache_read),
      input_cache_write_per_million: perMillion(prices.input_cache_write),
    },
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) fail(`${url} returned ${response.status}`);
  return response.json();
}

/** OpenRouter lists already-discounted endpoint prices; `discount` undoes that to the list price. */
function undoOpenRouterDiscount(prices, discount) {
  if (!discount || discount <= 0 || discount >= 1) return prices;
  return Object.fromEntries(
    Object.entries(prices).map(([key, value]) => [
      key,
      typeof value === 'string' ? String(Number(value) / (1 - discount)) : value,
    ])
  );
}

function openRouterTiers(pricing) {
  const { discount, overrides = [], ...base } = pricing;
  const listBase = undoOpenRouterDiscount(base, discount);
  return [
    tier(0, listBase),
    ...overrides
      .toSorted((a, b) => a.min_prompt_tokens - b.min_prompt_tokens)
      .map(({ min_prompt_tokens, ...override }) =>
        tier(min_prompt_tokens, { ...listBase, ...undoOpenRouterDiscount(override, discount) })
      ),
  ];
}

async function fromOpenRouter(sourceId) {
  const { data } = await getJson(`https://openrouter.ai/api/v1/models/${sourceId}/endpoints`);
  const endpoints = data.endpoints.filter(endpoint => endpoint.pricing);
  if (endpoints.length === 0) fail(`${sourceId} has no priced OpenRouter endpoints`);
  const candidates = values.provider
    ? endpoints.filter(endpoint => endpoint.tag === values.provider)
    : endpoints;
  if (candidates.length === 0)
    fail(
      `${sourceId} has no endpoint tagged ${values.provider}. Tags: ${endpoints.map(e => e.tag).join(', ')}`
    );
  const tierSets = candidates.map(endpoint => JSON.stringify(openRouterTiers(endpoint.pricing)));
  if (new Set(tierSets).size > 1) {
    const listing = candidates
      .map(
        (endpoint, index) =>
          `  ${endpoint.tag}: ${JSON.stringify(JSON.parse(tierSets[index])[0].pricing)}`
      )
      .join('\n');
    fail(
      `${sourceId} endpoints have different list prices; pass --provider <tag>.\n` +
        `Discounted base tier per endpoint:\n${listing}`
    );
  }
  return JSON.parse(tierSets[0]);
}

function vercelTierStarts(pricing) {
  const starts = new Set([0]);
  for (const key of ['input', 'output', 'input_cache_read', 'input_cache_write']) {
    for (const { min } of pricing[`${key}_tiers`] ?? []) starts.add(min);
  }
  return [...starts].toSorted((a, b) => a - b);
}

function vercelPriceAt(pricing, key, start) {
  const tiers = pricing[`${key}_tiers`];
  if (!tiers) return pricing[key];
  const match = tiers.findLast(({ min }) => min <= start);
  return match?.cost ?? pricing[key];
}

async function fromVercel(sourceId) {
  const { data } = await getJson('https://ai-gateway.vercel.sh/v1/models');
  const model = data.find(entry => entry.id === sourceId);
  if (!model) fail(`${sourceId} is not listed by Vercel AI Gateway`);
  const { pricing } = model;
  if (!pricing?.input || !pricing.output) fail(`${sourceId} has no token pricing on Vercel`);
  return vercelTierStarts(pricing).map(start =>
    tier(start, {
      prompt: vercelPriceAt(pricing, 'input', start),
      completion: vercelPriceAt(pricing, 'output', start),
      input_cache_read: vercelPriceAt(pricing, 'input_cache_read', start),
      input_cache_write: vercelPriceAt(pricing, 'input_cache_write', start),
    })
  );
}

const entries = [];
for (const positional of positionals) {
  const [model, sourceId = model] = positional.split('=');
  const pricing =
    values.source === 'openrouter' ? await fromOpenRouter(sourceId) : await fromVercel(sourceId);
  entries.push({
    model,
    ...(!values['no-label'] && discountPercentage > 0 && { discountPercentage }),
    ...(values['fallback-only'] && { fallbackOnly: true }),
    pricing,
  });
}

console.log(JSON.stringify(entries, null, 2));

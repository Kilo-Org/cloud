/**
 * Fetch and cache the recommended models list.
 *
 * Fetch order:
 *   1. KV cache (< 1 hour old)
 *   2. GET /api/recommended-models from the app
 *
 * Throws if both are unavailable — alerting should fail loudly
 * rather than silently using a stale hardcoded list.
 */

import { z } from 'zod';

const recommendedModelsSchema = z.array(z.string().min(1)).min(1);

const KV_KEY = 'o11y:recommended-models';
const KV_TTL_SECONDS = 3600; // 1 hour

type RecommendedModelsEnv = {
	O11Y_ALERT_STATE: KVNamespace;
	O11Y_API_BASE_URL: string;
};

export async function getRecommendedModels(env: RecommendedModelsEnv): Promise<Set<string>> {
	// 1. Try KV cache
	const cached = await env.O11Y_ALERT_STATE.get(KV_KEY);
	if (cached) {
		try {
			const parsed = recommendedModelsSchema.safeParse(JSON.parse(cached));
			if (parsed.success) {
				return new Set(parsed.data);
			}
		} catch {
			// Corrupted cache — fall through to network fetch.
		}
	}

	// 2. Fetch from the app
	const response = await fetch(`${env.O11Y_API_BASE_URL}/api/recommended-models`, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(5_000),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch recommended models: ${response.status} ${response.statusText}`);
	}

	const parsed = recommendedModelsSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error(`Invalid recommended models response: ${parsed.error.message}`);
	}

	await env.O11Y_ALERT_STATE.put(KV_KEY, JSON.stringify(parsed.data), {
		expirationTtl: KV_TTL_SECONDS,
	});
	return new Set(parsed.data);
}

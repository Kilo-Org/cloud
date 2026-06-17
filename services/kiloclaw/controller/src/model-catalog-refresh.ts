/**
 * Periodically seeds the kilocode provider's model catalog into openclaw.json.
 *
 * TEMPORARY WORKAROUND (Pylon #21841). OpenClaw's live model discovery never
 * populates the agent model registry for the kilocode provider, so the
 * image-capability gate resolves every model as text-only (`input: ["text"]`)
 * and refuses vision — even though the Kilo Gateway advertises the correct
 * `["text","image"]` modalities. We work around it by writing the live gateway
 * catalog into `models.providers.kilocode.models`, which the capability gate
 * DOES read.
 *
 * OpenClaw hot-reloads openclaw.json on change — a `models.providers.*.models`
 * edit is a hot reload, not a restart — so a write takes effect within ~1s with
 * no gateway bounce.
 *
 * Cadence: a short delay after boot (so config-writer has finished its
 * `models: []` write and the gateway's file watcher is active), then daily. A
 * model newly added to the gateway becomes vision-capable on the instance
 * within one refresh interval (or on the next controller start).
 *
 * Remove once OpenClaw feeds discovery into the model registry / capability
 * resolution.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { atomicWrite } from './atomic-write';

const DEFAULT_CONFIG_PATH = '/root/.openclaw/openclaw.json';
const DEFAULT_GATEWAY_BASE_URL = 'https://api.kilo.ai/api/gateway/';

// openclaw.json holds secrets (API keys, gateway token); keep it owner-only.
const CONFIG_FILE_MODE = 0o600;

const INITIAL_REFRESH_DELAY_MS = 30 * 1000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;

// Numeric/price fields can be `null` in the gateway/OpenRouter contract (e.g.
// `top_provider.max_completion_tokens` is routinely null), so every optional
// number/price is also nullable — otherwise one null model would fail the
// schema. We additionally parse entries individually (see fetchModelCatalog)
// so a single unexpected entry can never reject the whole catalog.
const priceField = z.union([z.string(), z.number()]).nullable().optional();

/** Subset of the Kilo Gateway `/models` response we map into the catalog. */
const GatewayModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    architecture: z.object({ input_modalities: z.array(z.string()).optional() }).optional(),
    supported_parameters: z.array(z.string()).optional(),
    pricing: z
      .object({
        prompt: priceField,
        completion: priceField,
        input_cache_read: priceField,
        input_cache_write: priceField,
      })
      .optional(),
    context_length: z.number().nullable().optional(),
    top_provider: z.object({ max_completion_tokens: z.number().nullable().optional() }).optional(),
  })
  .passthrough();

// Only require the envelope shape here; each entry is validated individually.
const GatewayResponseSchema = z.object({ data: z.array(z.unknown()) });

/** OpenClaw provider model-definition shape written into the config. */
export type OpenClawModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

export type ModelCatalogRefreshDeps = {
  fetch: typeof fetch;
  readConfig: (path: string) => string;
  writeConfig: (path: string, data: string) => void;
};

const defaultDeps: ModelCatalogRefreshDeps = {
  fetch: (...args) => fetch(...args),
  readConfig: p => fs.readFileSync(p, 'utf8'),
  writeConfig: (p, data) => atomicWrite(p, data, undefined, { mode: CONFIG_FILE_MODE }),
};

function toPricePerMillion(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : 0;
}

function mapGatewayModel(entry: z.infer<typeof GatewayModelSchema>): OpenClawModelDef {
  const modalities = entry.architecture?.input_modalities ?? [];
  const supportsImage = modalities.some(m => m.toLowerCase() === 'image');
  const params = entry.supported_parameters ?? [];
  return {
    id: entry.id,
    name: entry.name || entry.id,
    reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
    input: supportsImage ? ['text', 'image'] : ['text'],
    cost: {
      input: toPricePerMillion(entry.pricing?.prompt),
      output: toPricePerMillion(entry.pricing?.completion),
      cacheRead: toPricePerMillion(entry.pricing?.input_cache_read),
      cacheWrite: toPricePerMillion(entry.pricing?.input_cache_write),
    },
    contextWindow: entry.context_length ?? 1_000_000,
    maxTokens: entry.top_provider?.max_completion_tokens ?? 128_000,
  };
}

function resolveGatewayModelsUrl(env: NodeJS.ProcessEnv): string {
  const base = env.KILOCODE_API_BASE_URL || DEFAULT_GATEWAY_BASE_URL;
  return new URL('models', base.endsWith('/') ? base : `${base}/`).toString();
}

/**
 * Fetches the live model catalog from the Kilo Gateway and maps it into the
 * OpenClaw provider model-definition shape. Uses the same auth/org/feature
 * headers as the instance so the catalog matches what this org can actually
 * use. Throws on missing key or non-OK response.
 */
export async function fetchModelCatalog(
  env: NodeJS.ProcessEnv,
  deps: ModelCatalogRefreshDeps = defaultDeps
): Promise<OpenClawModelDef[]> {
  const apiKey = env.KILOCODE_API_KEY;
  if (!apiKey) {
    throw new Error('KILOCODE_API_KEY not set; cannot fetch model catalog');
  }
  const res = await deps.fetch(resolveGatewayModelsUrl(env), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'x-kilocode-feature': env.KILOCODE_FEATURE || 'kiloclaw',
      ...(env.KILOCODE_ORGANIZATION_ID
        ? { 'X-KiloCode-OrganizationId': env.KILOCODE_ORGANIZATION_ID }
        : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gateway /models returned HTTP ${res.status}`);
  }
  const parsed = GatewayResponseSchema.parse(await res.json());
  const models: OpenClawModelDef[] = [];
  let skipped = 0;
  for (const raw of parsed.data) {
    const entry = GatewayModelSchema.safeParse(raw);
    if (!entry.success) {
      skipped++;
      continue;
    }
    models.push(mapGatewayModel(entry.data));
  }
  if (skipped > 0) {
    console.warn(`[model-catalog-refresh] skipped ${skipped} unparseable model entries`);
  }
  return models;
}

/**
 * Fetches the catalog and writes it into `models.providers.kilocode.models`,
 * preserving every other field. Skips the write (leaving the existing config
 * untouched) when the fetch yields nothing or the kilocode provider block does
 * not yet exist — config-writer owns creating that block at boot.
 */
export async function refreshModelCatalog(
  env: NodeJS.ProcessEnv,
  configPath: string = DEFAULT_CONFIG_PATH,
  deps: ModelCatalogRefreshDeps = defaultDeps
): Promise<{ written: boolean; count: number }> {
  const models = await fetchModelCatalog(env, deps);
  if (models.length === 0) {
    console.warn('[model-catalog-refresh] gateway returned 0 models; leaving config unchanged');
    return { written: false, count: 0 };
  }

  // Read-modify-write is a single synchronous tick (no await between read and
  // write), so no other handler in this controller process — config restore,
  // patch, agent mutation — can interleave and have its write silently lost.
  // The only residual window is the external OpenClaw gateway process writing
  // this file between readFileSync and renameSync; skip-when-unchanged below
  // keeps writes rare enough that this is negligible for a temporary shim.
  const config: unknown = JSON.parse(deps.readConfig(configPath));
  const kilocode = (config as { models?: { providers?: Record<string, unknown> } })?.models
    ?.providers?.kilocode;
  if (!kilocode || typeof kilocode !== 'object') {
    console.warn(
      '[model-catalog-refresh] kilocode provider block missing; skipping (config-writer owns creation)'
    );
    return { written: false, count: 0 };
  }

  const current = (kilocode as { models?: unknown }).models;
  if (JSON.stringify(current) === JSON.stringify(models)) {
    // Catalog unchanged — avoid a needless write and OpenClaw hot reload.
    return { written: false, count: models.length };
  }

  (kilocode as { models: OpenClawModelDef[] }).models = models;
  deps.writeConfig(configPath, JSON.stringify(config, null, 2));
  console.log(`[model-catalog-refresh] seeded ${models.length} kilocode models into ${configPath}`);
  return { written: true, count: models.length };
}

let initialTimeout: ReturnType<typeof setTimeout> | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic catalog refresh: once shortly after boot, then daily.
 * No-op when `KILOCODE_API_KEY` is absent (nothing to authenticate the fetch).
 */
export function startModelCatalogRefresh(
  env: NodeJS.ProcessEnv,
  configPath: string = DEFAULT_CONFIG_PATH,
  deps: ModelCatalogRefreshDeps = defaultDeps
): void {
  if (initialTimeout !== null || refreshInterval !== null) {
    stopModelCatalogRefresh();
  }
  if (!env.KILOCODE_API_KEY) {
    console.warn('[model-catalog-refresh] KILOCODE_API_KEY not set; refresh disabled');
    return;
  }

  async function run(): Promise<void> {
    try {
      await refreshModelCatalog(env, configPath, deps);
    } catch (err) {
      console.error('[model-catalog-refresh] refresh failed:', err);
    }
  }

  initialTimeout = setTimeout(() => {
    void run();
    refreshInterval = setInterval(() => void run(), REFRESH_INTERVAL_MS);
  }, INITIAL_REFRESH_DELAY_MS);
}

export function stopModelCatalogRefresh(): void {
  if (initialTimeout !== null) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

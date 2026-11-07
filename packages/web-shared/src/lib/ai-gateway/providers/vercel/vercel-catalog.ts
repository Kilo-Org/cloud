import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';

/** The fields of a Vercel AI Gateway `/v1/models` entry that describe a chat model. */
const VercelCatalogModelSchema = z.object({
  id: z.string(),
  type: z.literal('language'),
  description: z.string().catch(''),
  created: z.number(),
  released: z.number().optional().catch(undefined),
  context_window: z.number(),
  max_tokens: z.number().optional().catch(undefined),
  modalities: z.object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  }),
  supported_parameters: z.array(z.string()).optional().catch(undefined),
  pricing: z.object({
    input: z.string(),
    output: z.string(),
    input_cache_read: z.string().optional().catch(undefined),
    input_cache_write: z.string().optional().catch(undefined),
  }),
  /** Milliseconds since the epoch. */
  deprecated_at: z
    .number()
    .int()
    .min(0)
    .max(Date.UTC(9999, 11, 31))
    .nullable()
    .optional()
    .catch(undefined),
  reasoning_options: z
    .array(
      z.object({
        type: z.string(),
        values: z.array(z.string()).optional().catch(undefined),
      })
    )
    .optional()
    .catch(undefined),
});

export type VercelCatalogModel = z.infer<typeof VercelCatalogModelSchema>;

/** Vercel's chat models by Vercel model ID. */
export type VercelCatalog = ReadonlyMap<string, VercelCatalogModel>;

const VercelCatalogResponseSchema = z.object({ data: z.array(z.unknown()) });

/** Keeps the language models that output text. Entries that do not parse are left out. */
export function parseVercelCatalog(body: unknown): VercelCatalog {
  return new Map(
    VercelCatalogResponseSchema.parse(body).data.flatMap(entry => {
      const parsed = VercelCatalogModelSchema.safeParse(entry);
      return parsed.success && parsed.data.modalities.output.includes('text')
        ? [[parsed.data.id, parsed.data] as const]
        : [];
    })
  );
}

/**
 * Vercel's model list, cached in the shared fetch cache like `getRawOpenRouterModels`, so the
 * model list and the provider sync read the same data.
 */
export async function getVercelCatalog(): Promise<VercelCatalog> {
  const response = await fetch(`${VERCEL_AI_GATEWAY.apiUrl}/models`, {
    cache: 'force-cache',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${VERCEL_AI_GATEWAY.apiKey}`,
      ...ATTRIBUTION_HEADERS,
    },
    next: { revalidate: 60 },
  });
  if (!response.ok) {
    const error = new Error(`Fetching Vercel AI Gateway models failed: ${response.status}`);
    captureException(error, {
      tags: { endpoint: 'vercel/models', source: 'vercel_api' },
      extra: { status: response.status, statusText: response.statusText },
    });
    throw error;
  }
  return parseVercelCatalog(await response.json());
}

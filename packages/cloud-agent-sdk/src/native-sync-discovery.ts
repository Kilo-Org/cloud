import { z } from 'zod';
import type { NativePresenceConnection } from './native-sync';

// Match the native client's 4 MiB / 1,024-frame retained-work bounds. A model
// page leaves room above the runner's 48 KiB entries for its outcome wrapper.
const discoveryLimits = {
  pageBytes: 60 * 1024,
  catalogBytes: 4 * 1024 * 1024,
  pages: 1024,
};

const modelSchema = z.object({
  id: z.string(),
  providerID: z.string(),
  name: z.string(),
  limit: z.object({
    context: z.number().int(),
    input: z.number().int().optional(),
    output: z.number().int(),
  }),
  variants: z.array(z.object({ id: z.string() })),
});
const pageSchema = z.object({
  models: z.array(modelSchema),
  nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
const outcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), result: pageSchema }),
  z.object({
    status: z.literal('failed'),
    error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
  }),
  z.object({ status: z.literal('unknown') }),
]);

export type NativeDiscoveredModel = z.infer<typeof modelSchema>;

const catalogChangedMessage = 'Model catalog changed. Refresh host options to try again.';
/** Read the complete native catalog; a failed later page never becomes a partial success. */
export async function listNativeModels(
  connection: Pick<NativePresenceConnection, 'command'>,
  instanceID: string
): Promise<NativeDiscoveredModel[]> {
  const models: NativeDiscoveredModel[] = [];
  let cursor = 0;
  let bytes = 0;
  let pages = 0;
  let catalogRevision: string | undefined;
  const encoder = new TextEncoder();
  for (;;) {
    pages += 1;
    if (pages > discoveryLimits.pages) throw new Error('Model discovery exceeded the page limit');
    const reply = await connection.command(
      instanceID,
      'list_models',
      cursor === 0 ? {} : { cursor, catalogRevision }
    );
    if (reply.status === 'unknown') {
      throw new Error('Discovery outcome unknown. Refresh to try again.');
    }
    const pageBytes = encoder.encode(JSON.stringify(reply.body) ?? 'null').byteLength;
    if (pageBytes > discoveryLimits.pageBytes) {
      throw new Error('Model discovery page exceeded the byte limit');
    }
    bytes += pageBytes;
    if (bytes > discoveryLimits.catalogBytes) {
      throw new Error('Model discovery exceeded the catalog byte limit');
    }
    const outcome = outcomeSchema.parse(reply.body);
    if (outcome.status === 'failed') {
      if (outcome.error?.code === 'catalog_changed') {
        throw new Error(catalogChangedMessage);
      }
      throw new Error(outcome.error?.message ?? 'Model discovery failed');
    }
    if (outcome.status === 'unknown') {
      throw new Error('Discovery outcome unknown. Refresh to try again.');
    }
    const page = outcome.result;
    if (catalogRevision !== undefined && page.catalogRevision !== catalogRevision) {
      throw new Error(catalogChangedMessage);
    }
    catalogRevision = page.catalogRevision;
    if (page.nextCursor !== null && page.nextCursor <= cursor) {
      throw new Error('Model discovery cursor did not advance');
    }
    if (page.nextCursor !== null && page.nextCursor !== cursor + page.models.length) {
      throw new Error('Model discovery cursor skipped model records');
    }
    models.push(...page.models);
    if (page.nextCursor === null) return models;
    cursor = page.nextCursor;
  }
}

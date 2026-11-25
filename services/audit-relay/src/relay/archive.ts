import { AuditBatchSchema } from '@kilocode/sts-contracts';
import { z } from 'zod';
import { errorName } from './error-name';

/** The slice of the R2 bucket binding the archive, checkpoint and verify code needs. */
export type ArchiveBucket = Pick<R2Bucket, 'put' | 'get' | 'head' | 'list'>;

export const ARCHIVE_PREFIX = 'streams/';
export const CHECKPOINT_PREFIX = 'checkpoints/';
export const DEAD_LETTER_PREFIX = 'dead-letter/';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ArchivedBatchSchema = z.strictObject({
  batch: AuditBatchSchema,
  prevHash: HashSchema,
  hash: HashSchema,
});
export type ArchivedBatch = z.infer<typeof ArchivedBatchSchema>;

/**
 * What an archive key holds. `corrupt` is an object that exists but does not decode to an
 * `ArchivedBatch`; an R2 I/O failure is thrown instead, because a retry can fix it.
 */
export type ArchivedRead =
  | { kind: 'ok'; object: ArchivedBatch }
  | { kind: 'missing' }
  | { kind: 'corrupt'; detail: string };

/** The key already holds a different chain hash: a second writer, or a rewritten object. */
export class ArchiveConflictError extends Error {
  constructor(
    readonly key: string,
    readonly storedHash: string,
    readonly expectedHash: string
  ) {
    super(`archive object ${key} holds hash ${storedHash}, expected ${expectedHash}`);
    this.name = 'ArchiveConflictError';
  }
}

export function archiveStreamPrefix(stream: string): string {
  return `${ARCHIVE_PREFIX}${stream}/`;
}

/** Zero-padded so R2's lexicographic listing is sequence order. */
export function archiveObjectKey(stream: string, toSeq: number): string {
  return `${archiveStreamPrefix(stream)}${String(toSeq).padStart(12, '0')}.json.gz`;
}

export function archiveSequenceOf(key: string): number | null {
  const match = /\/(\d{12})\.json\.gz$/.exec(key);
  return match ? Number(match[1]) : null;
}

/** `dead-letter/<stream or unknown>/<enqueue time>-<message id>.gz`. */
export function deadLetterKey(stream: string | null, enqueuedAt: Date, messageId: string): string {
  return `${DEAD_LETTER_PREFIX}${stream ?? 'unknown'}/${enqueuedAt.toISOString()}-${messageId}.gz`;
}

async function pipeThrough(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer());
}

export function gzipJson(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return pipeThrough(bytes, new CompressionStream('gzip'));
}

/**
 * Writes an object only if the key is free. A bucket-lock rule rejects the write to a key that
 * already exists; that is success for the caller to confirm by reading the stored object back.
 */
export async function putImmutable(
  bucket: ArchiveBucket,
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<'written' | 'existing'> {
  try {
    await bucket.put(key, body, { httpMetadata: { contentType } });
    return 'written';
  } catch (error) {
    const existing = await bucket.head(key);
    if (!existing) throw error;
    return 'existing';
  }
}

export async function writeArchivedBatch(
  bucket: ArchiveBucket,
  object: ArchivedBatch
): Promise<'written' | 'existing'> {
  const key = archiveObjectKey(object.batch.stream, object.batch.toSeq);
  const outcome = await putImmutable(bucket, key, await gzipJson(object), 'application/gzip');
  if (outcome === 'written') return outcome;

  const stored = await readArchivedObject(bucket, key);
  if (stored.kind === 'missing') {
    throw new Error(`archive object ${key} disappeared between write and read`);
  }
  const storedHash = stored.kind === 'ok' ? stored.object.hash : 'unreadable';
  if (storedHash !== object.hash) throw new ArchiveConflictError(key, storedHash, object.hash);
  return 'existing';
}

export async function readArchivedObject(
  bucket: ArchiveBucket,
  key: string
): Promise<ArchivedRead> {
  const object = await bucket.get(key);
  if (!object) return { kind: 'missing' };
  const compressed = new Uint8Array(await object.arrayBuffer());
  try {
    const json = await pipeThrough(compressed, new DecompressionStream('gzip'));
    const parsed = ArchivedBatchSchema.safeParse(
      JSON.parse(new TextDecoder().decode(json)) as unknown
    );
    if (!parsed.success) return { kind: 'corrupt', detail: 'schema' };
    return { kind: 'ok', object: parsed.data };
  } catch (error) {
    return { kind: 'corrupt', detail: errorName(error) };
  }
}

/** Every key under `prefix`, following R2's cursor until the listing is complete. */
export async function listObjectKeys(bucket: ArchiveBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

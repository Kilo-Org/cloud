import { z } from 'zod';
import {
  EgressAuditRecordSchema,
  EgressAuditRequestSchema,
  GetEgressAuditInputSchema,
  type EgressAuditRecord,
  type GetEgressAuditInput,
  type GetEgressAuditResponse,
} from '../shared/egress-audit.js';

type AuditStorage = Pick<DurableObjectStorage, 'put' | 'list' | 'transaction'>;

const CHUNK_PREFIX = 'containers:egress-audit:chunk:';
const CHUNK_SIZE = 64;
const MAX_CHUNKS = 256;
// Protect the caller's five-second retry deadline even during rapid rollover.
const MIN_RETENTION_MS = 60_000;
const chunkSchema = z
  .object({
    records: z.array(EgressAuditRecordSchema.strict()).min(1).max(CHUNK_SIZE),
    lastCommittedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
type AuditChunk = z.infer<typeof chunkSchema>;
type AuditCache = { chunks: AuditChunk[]; requests: Map<string, EgressAuditRecord> };

function chunkKey(id: number): string {
  return `${CHUNK_PREFIX}${String(Math.floor((id - 1) / CHUNK_SIZE)).padStart(16, '0')}`;
}

export class EgressAuditStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cache: AuditCache | undefined;

  constructor(private readonly storage: AuditStorage) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async load(): Promise<AuditCache> {
    if (this.cache) return this.cache;
    const rows = await this.storage.list<unknown>({ prefix: CHUNK_PREFIX, limit: MAX_CHUNKS + 1 });
    if (rows.size > MAX_CHUNKS) throw new Error('Egress audit chunk limit exceeded');
    const cache: AuditCache = { chunks: [], requests: new Map() };
    let lastId: number | undefined;
    for (const [key, value] of rows) {
      const chunk = chunkSchema.parse(value);
      for (const [index, record] of chunk.records.entries()) {
        if (
          key !== chunkKey(record.id) ||
          (record.id - 1) % CHUNK_SIZE !== index ||
          (lastId !== undefined && record.id !== lastId + 1) ||
          cache.requests.has(record.requestId)
        ) {
          throw new Error('Invalid egress audit chunk history');
        }
        lastId = record.id;
        cache.requests.set(record.requestId, record);
      }
      cache.chunks.push(chunk);
    }
    this.cache = cache;
    return cache;
  }

  async recordEgressRequest(input: unknown): Promise<EgressAuditRecord> {
    const request = EgressAuditRequestSchema.parse(input);
    return this.serialize(async () => {
      const cache = await this.load();
      const existing = cache.requests.get(request.requestId);
      if (existing) return { ...existing };
      const newest = cache.chunks.at(-1);
      const lastId = newest?.records.at(-1)?.id ?? 0;
      if (lastId === Number.MAX_SAFE_INTEGER) throw new Error('Egress audit id exhausted');
      const record = { ...request, id: lastId + 1 };
      const rollover = newest === undefined || newest.records.length === CHUNK_SIZE;
      const oldest = rollover && cache.chunks.length === MAX_CHUNKS ? cache.chunks[0] : undefined;
      const now = Date.now();
      if (oldest && now - oldest.lastCommittedAtMs < MIN_RETENTION_MS) {
        throw new Error('Egress audit capacity reached within retry retention window');
      }
      const chunk: AuditChunk = {
        records: rollover ? [record] : [...newest.records, record],
        lastCommittedAtMs: now,
      };
      try {
        if (oldest) {
          await this.storage.transaction(async txn => {
            await txn.put(chunkKey(record.id), chunk);
            await txn.delete(chunkKey(oldest.records[0].id));
          });
        } else {
          await this.storage.put(chunkKey(record.id), chunk);
        }
      } catch (error) {
        // The write may have committed before its acknowledgement was lost.
        this.cache = undefined;
        throw error;
      }
      if (rollover) cache.chunks.push(chunk);
      else cache.chunks[cache.chunks.length - 1] = chunk;
      if (oldest) {
        cache.chunks.shift();
        for (const pruned of oldest.records) cache.requests.delete(pruned.requestId);
      }
      cache.requests.set(record.requestId, record);
      return { ...record };
    });
  }

  async getEgressAudit(input: GetEgressAuditInput = {}): Promise<GetEgressAuditResponse> {
    const { cursor = 0, limit = 50 } = GetEgressAuditInputSchema.parse(input);
    return this.serialize(async () => {
      const cache = await this.load();
      const records: EgressAuditRecord[] = [];
      for (const record of cache.requests.values()) {
        if (record.id > cursor) records.push({ ...record });
        if (records.length > limit) break;
      }
      const hasMore = records.length > limit;
      if (hasMore) records.pop();
      return { records, nextCursor: hasMore ? (records.at(-1)?.id ?? null) : null };
    });
  }
}

import { z } from 'zod';
import {
  EgressAuditRecordSchema,
  EgressAuditRequestSchema,
  GetEgressAuditInputSchema,
  type EgressAuditRecord,
  type GetEgressAuditInput,
  type GetEgressAuditResponse,
} from '../shared/egress-audit.js';

type AuditStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;

const COUNTER_KEY = 'containers:egress-audit:sequence';
const RECORD_PREFIX = 'containers:egress-audit:record:';
const REQUEST_PREFIX = 'containers:egress-audit:request:';
const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function recordKey(id: number): string {
  return `${RECORD_PREFIX}${String(id).padStart(16, '0')}`;
}

export async function recordEgressRequest(
  storage: AuditStorage,
  input: unknown
): Promise<EgressAuditRecord> {
  const request = EgressAuditRequestSchema.parse(input);
  const requestKey = `${REQUEST_PREFIX}${request.requestId}`;
  const stored = await storage.get<unknown>([COUNTER_KEY, requestKey]);
  const existing = stored.get(requestKey);
  if (existing !== undefined) return EgressAuditRecordSchema.parse(existing);

  const id = sequenceSchema.parse(stored.get(COUNTER_KEY) ?? 0) + 1;
  const record = EgressAuditRecordSchema.parse({ ...request, id });
  // One multi-key write atomically commits the sequence, record, and retry identity.
  await storage.put({ [COUNTER_KEY]: id, [recordKey(id)]: record, [requestKey]: record });
  return record;
}

export async function getEgressAudit(
  storage: AuditStorage,
  input: GetEgressAuditInput = {}
): Promise<GetEgressAuditResponse> {
  const { cursor = 0, limit = 50 } = GetEgressAuditInputSchema.parse(input);
  const rows = await storage.list<unknown>({
    prefix: RECORD_PREFIX,
    startAfter: recordKey(cursor),
    limit: limit + 1,
  });
  const records = [...rows.values()].map(record => EgressAuditRecordSchema.parse(record));
  const hasMore = records.length > limit;
  if (hasMore) records.pop();
  return { records, nextCursor: hasMore ? (records.at(-1)?.id ?? null) : null };
}

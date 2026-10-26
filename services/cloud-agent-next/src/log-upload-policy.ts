import { z } from 'zod';

export const LOG_UPLOAD_BODY_TIMEOUT_MS = 30_000;
export const LOG_UPLOAD_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const LOG_UPLOAD_MAX_REQUESTS = 8192;
const BUDGET_KEY = 'log_upload_budget';
const budgetSchema = z.object({
  scope: z.string(),
  bytes: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
});

/** The caller authenticates the current runtime before reserving. Failed writes still consume budget. */
export async function reserveLogUploadBudget(
  storage: DurableObjectStorage,
  scope: string,
  bytes: number,
  authorize?: (tx: DurableObjectTransaction) => Promise<boolean>
): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > LOG_UPLOAD_MAX_TOTAL_BYTES)
    return false;
  return storage.transaction(async tx => {
    if (authorize && !(await authorize(tx))) return false;
    const raw = await tx.get<unknown>(BUDGET_KEY);
    const saved = raw === undefined ? undefined : budgetSchema.parse(raw);
    const budget = saved?.scope === scope ? saved : { scope, bytes: 0, requests: 0 };
    if (
      budget.requests >= LOG_UPLOAD_MAX_REQUESTS ||
      budget.bytes + bytes > LOG_UPLOAD_MAX_TOTAL_BYTES
    )
      return false;
    await tx.put(BUDGET_KEY, { scope, bytes: budget.bytes + bytes, requests: budget.requests + 1 });
    return true;
  });
}

export class LogUploadReadError extends Error {
  constructor(readonly status: 408 | 413) {
    super(status === 408 ? 'Log upload timed out' : 'Log body too large');
  }
}

/** Bounds the complete body read, even when a sender never sends another chunk or EOF. */
export async function readLogUploadBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LogUploadReadError(408)), LOG_UPLOAD_BODY_TIMEOUT_MS);
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) throw new LogUploadReadError(413);
      length += value.byteLength;
      if (length > maxBytes) throw new LogUploadReadError(413);
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    clearTimeout(timer);
    // Guest-controlled cancellation must not extend the body deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

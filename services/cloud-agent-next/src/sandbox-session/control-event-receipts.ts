import { z } from 'zod';
import { canonicalControlEventJson } from '../shared/control-event-canonical.js';
import { wrapperInstanceIdSchema } from '../shared/sandbox-control-protocol.js';

export const CONTROL_EVENT_RECEIPTS_KEY = 'control_event_receipts';
const CONTROL_EVENT_RECEIPT_LIMIT = 64;

const controlEventReceiptSchema = z
  .object({
    receiptId: z.string().uuid(),
    receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
    wrapperInstanceId: wrapperInstanceIdSchema,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const controlEventReceiptStoreSchema = z
  .object({
    activeWrapperInstanceId: wrapperInstanceIdSchema.optional(),
    highWater: z.record(wrapperInstanceIdSchema, z.number().int().nonnegative()),
    retiredWrapperInstanceIds: z
      .array(wrapperInstanceIdSchema)
      .max(CONTROL_EVENT_RECEIPT_LIMIT)
      .default([]),
    receipts: z.array(controlEventReceiptSchema).max(CONTROL_EVENT_RECEIPT_LIMIT),
  })
  .strict();

export type ControlEventReceiptInput = {
  receiptId?: string;
  receiptHash?: string;
  sequence?: number;
  wrapperInstanceId?: string;
};

export type ControlEventReceiptDisposition = 'apply' | 'duplicate' | 'conflict' | 'stale';

type ControlEventReceiptStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

type ControlEventReceiptState = z.infer<typeof controlEventReceiptStoreSchema>;

export function parseControlEventReceipt(input: ControlEventReceiptInput) {
  return controlEventReceiptSchema.safeParse({
    receiptId: input.receiptId,
    receiptHash: input.receiptHash,
    sequence: input.sequence,
    wrapperInstanceId: input.wrapperInstanceId,
  });
}

export function readControlEventReceipts(
  storage: ControlEventReceiptStorage
): ControlEventReceiptState {
  const stored = storage.get<unknown>(CONTROL_EVENT_RECEIPTS_KEY);
  if (stored === undefined) {
    return { highWater: {}, retiredWrapperInstanceIds: [], receipts: [] };
  }
  const parsed = controlEventReceiptStoreSchema.safeParse(stored);
  if (!parsed.success) throw new Error('Invalid control event receipt storage');
  return parsed.data;
}

export function controlEventReceiptDisposition(
  storage: ControlEventReceiptStorage,
  input: ControlEventReceiptInput
): ControlEventReceiptDisposition {
  if (
    input.receiptId === undefined &&
    input.receiptHash === undefined &&
    input.sequence === undefined
  )
    return 'apply';
  const receipt = parseControlEventReceipt(input);
  if (!receipt.success) return 'conflict';
  const state = readControlEventReceipts(storage);
  if (
    state.retiredWrapperInstanceIds.includes(receipt.data.wrapperInstanceId) ||
    (state.activeWrapperInstanceId !== undefined &&
      state.activeWrapperInstanceId !== receipt.data.wrapperInstanceId)
  )
    return 'stale';
  const stored = state.receipts.find(
    item =>
      item.receiptId === receipt.data.receiptId &&
      item.wrapperInstanceId === receipt.data.wrapperInstanceId
  );
  if (stored)
    return stored.receiptHash === receipt.data.receiptHash &&
      stored.sequence === receipt.data.sequence
      ? 'duplicate'
      : 'conflict';
  return receipt.data.sequence <= (state.highWater[receipt.data.wrapperInstanceId] ?? 0)
    ? 'stale'
    : 'apply';
}

export function recordControlEventReceipt(
  storage: ControlEventReceiptStorage,
  input: ControlEventReceiptInput
): void {
  const receipt = parseControlEventReceipt(input);
  if (!receipt.success) return;
  const current = readControlEventReceipts(storage);
  storage.put(CONTROL_EVENT_RECEIPTS_KEY, {
    ...current,
    highWater: {
      ...current.highWater,
      [receipt.data.wrapperInstanceId]: receipt.data.sequence,
    },
    receipts: [...current.receipts, receipt.data].slice(-CONTROL_EVENT_RECEIPT_LIMIT),
  });
}

export function bindControlEventReceiptIdentity(
  storage: ControlEventReceiptStorage,
  wrapperInstanceId: string
): void {
  const current = readControlEventReceipts(storage);
  if (current.activeWrapperInstanceId === wrapperInstanceId) return;
  if (current.retiredWrapperInstanceIds.includes(wrapperInstanceId))
    throw new Error('Cannot bind a retired control event wrapper');
  if (current.activeWrapperInstanceId)
    retireControlEventReceiptIdentity(storage, current.activeWrapperInstanceId);
  storage.put(CONTROL_EVENT_RECEIPTS_KEY, {
    ...readControlEventReceipts(storage),
    activeWrapperInstanceId: wrapperInstanceId,
  });
}

export function retireControlEventReceiptIdentity(
  storage: ControlEventReceiptStorage,
  wrapperInstanceId: string
): void {
  const current = readControlEventReceipts(storage);
  const { [wrapperInstanceId]: _, ...highWater } = current.highWater;
  storage.put(CONTROL_EVENT_RECEIPTS_KEY, {
    ...current,
    ...(current.activeWrapperInstanceId === wrapperInstanceId
      ? { activeWrapperInstanceId: undefined }
      : {}),
    highWater,
    retiredWrapperInstanceIds: [
      ...current.retiredWrapperInstanceIds.filter(item => item !== wrapperInstanceId),
      wrapperInstanceId,
    ].slice(-CONTROL_EVENT_RECEIPT_LIMIT),
    receipts: current.receipts.filter(item => item.wrapperInstanceId !== wrapperInstanceId),
  });
}

export async function hasValidControlEventReceipt(
  event: 'session.event' | 'session.preparing',
  input: {
    identity: unknown;
    payload: unknown;
  } & ControlEventReceiptInput
): Promise<boolean> {
  if (
    input.receiptId === undefined &&
    input.receiptHash === undefined &&
    input.sequence === undefined
  )
    return true;
  const receipt = parseControlEventReceipt(input);
  if (!receipt.success) return false;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      canonicalControlEventJson({
        event,
        session: input.identity,
        payload: input.payload,
        sequence: receipt.data.sequence,
      })
    )
  );
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return hash === receipt.data.receiptHash;
}

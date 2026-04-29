// Inbound HTTP body reader with a hard size cap. Returns a sentinel (rather
// than throwing) when the stream exceeds the cap, keeping the success path
// obvious and letting the caller respond with 413 without an instanceof dance.

import type { IncomingMessage } from 'node:http';

/** Max accepted inbound webhook body. Messages are small — 1 MB is already generous. */
export const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024;

export const BODY_TOO_LARGE = Symbol('body-too-large');

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

export async function readBody(req: IncomingMessage): Promise<string | typeof BODY_TOO_LARGE> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = toBuffer(chunk);
    total += buf.length;
    if (total > MAX_WEBHOOK_BODY_BYTES) return BODY_TOO_LARGE;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

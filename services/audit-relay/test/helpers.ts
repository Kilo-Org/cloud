import type { AuditBatch, AuditEvent } from '@kilocode/sts-contracts';
import { env as bindings } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { archiveObjectKey, readArchivedObject, type ArchivedBatch } from '../src/relay/archive';

export const env = bindings as unknown as Env;

export const STREAM = 'sts:production:bundle:o11y';

/** A stream name no other test shares, so Durable Object state never leaks between tests. */
export function uniqueStream(label: string): string {
  return `${STREAM}-${label}-${crypto.randomUUID()}`;
}

export function auditEvent(seq: number): AuditEvent {
  return {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'kilo:sts:production',
    type: 'ai.kilo.sts.bundle.delivered',
    time: new Date(Date.UTC(2026, 10, 25, 10, 0, seq % 60)).toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: 6003,
      activityId: 2,
      outcome: 'success',
      actor: { kind: 'workload', id: 'sts' },
      attributes: { seq },
    },
  };
}

export function auditBatch(fromSeq: number, toSeq: number, stream = STREAM): AuditBatch {
  return {
    schemaVersion: 1,
    stream,
    fromSeq,
    toSeq,
    events: Array.from({ length: toSeq - fromSeq + 1 }, (_, index) => auditEvent(fromSeq + index)),
  };
}

export type CapturedRequest = { url: string; body: string | null };

/** A `fetch` replacement that records each request and answers through `respond`. */
export function recordingFetch(
  respond: (request: CapturedRequest) => Response | Promise<Response>
): { impl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    const request = { url, body };
    requests.push(request);
    return respond(request);
  };
  return { impl, requests };
}

export function axiomOk(): Response {
  return new Response('{}', { status: 200 });
}

export function requestBodyOf(request: CapturedRequest | undefined): unknown[] {
  if (!request?.body) return [];
  return JSON.parse(request.body) as unknown[];
}

/** The archived object for `stream` at `toSeq`; fails the test when it is absent or corrupt. */
export async function readArchived(stream: string, toSeq: number): Promise<ArchivedBatch> {
  const read = await readArchivedObject(env.AUDIT_ARCHIVE, archiveObjectKey(stream, toSeq));
  if (read.kind !== 'ok') throw new Error(`archive object ${stream}@${toSeq} is ${read.kind}`);
  return read.object;
}

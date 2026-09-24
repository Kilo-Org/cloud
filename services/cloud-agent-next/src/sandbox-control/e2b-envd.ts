import { withTimeout } from '@kilocode/worker-utils';
import { z } from 'zod';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import {
  E2B_SANDBOX_URL,
  E2B_MANAGEMENT_TIMEOUT_MS,
  readE2BResponseText,
  validateE2BApiKey,
  type E2BSandboxDetail,
} from './e2b-api.js';

const MANIFEST_PATH = '/opt/kilo/runtime-manifest.json';
const MANIFEST_MAX_BYTES = 16 * 1024;
const HEADER_MAX_BYTES = 16 * 1024;
const HEADER_MAX_COUNT = 64;
const START_REQUEST_MAX_BYTES = 64 * 1024;
const START_RESPONSE_MAX_BYTES = 32 * 1024;
const START_FRAME_MAX_BYTES = 4 * 1024;
const START_MAX_FRAMES = 8;
const WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';
const WRAPPER_COMMAND =
  'exec bun /opt/kilo/kilocode-control-wrapper.js >> /tmp/kilocode-control-wrapper.log 2>&1';
const manifestSchema = z.object({ runtimeBuildId: z.string().min(1).max(128) });
const startEventSchema = z
  .object({
    event: z.union([
      z
        .object({ start: z.object({ pid: z.number().int().positive().max(0xffff_ffff) }).strict() })
        .strict(),
      z.object({ keepalive: z.object({}).strict() }).strict(),
    ]),
  })
  .strict();

function bootstrapFailed(): E2BProviderError {
  return new E2BProviderError('byoc_e2b_bootstrap_failed');
}

function requireTimeRemaining(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted || Date.now() >= deadlineAt) throw bootstrapFailed();
}

function validateHeaders(headers: Headers): void {
  const encoder = new TextEncoder();
  let bytes = 0;
  let count = 0;
  for (const [name, value] of headers) {
    if (++count > HEADER_MAX_COUNT || name.length + value.length > HEADER_MAX_BYTES) {
      throw bootstrapFailed();
    }
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
    if (bytes > HEADER_MAX_BYTES) throw bootstrapFailed();
  }
}

function validateResponse(response: Response, maxBytes: number): void {
  validateHeaders(response.headers);
  if (response.status !== 200 || response.redirected || !response.body) throw bootstrapFailed();
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(Number(contentLength)) ||
      Number(contentLength) > maxBytes)
  )
    throw bootstrapFailed();
  for (const header of ['content-encoding', 'connect-content-encoding']) {
    const encoding = response.headers.get(header);
    if (encoding !== null && encoding.toLowerCase() !== 'identity') throw bootstrapFailed();
  }
}

function encodeStartRequest(
  env: Record<string, string>,
  providerRef: string,
  apiKey: string
): Uint8Array {
  const entries = Object.entries(env);
  if (entries.length > 64 || providerRef.length > 256) throw bootstrapFailed();
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [name, value] of entries) {
    if (
      name.length > 128 ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
      name.toUpperCase().startsWith('E2B_') ||
      typeof value !== 'string' ||
      value.length > START_REQUEST_MAX_BYTES ||
      name.includes(apiKey) ||
      value.includes(apiKey)
    )
      throw bootstrapFailed();
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
    if (bytes > START_REQUEST_MAX_BYTES) throw bootstrapFailed();
  }
  const envs = Object.fromEntries(entries);
  envs.PROVIDER_INSTANCE_ID = providerRef;
  envs.WRAPPER_LOG_PATH = WRAPPER_LOG_PATH;
  const json = JSON.stringify({
    process: { cmd: '/bin/bash', args: ['-l', '-c', WRAPPER_COMMAND], envs, cwd: '/' },
    stdin: false,
  });
  if (json.includes(apiKey)) throw bootstrapFailed();
  const payload = encoder.encode(json);
  if (payload.byteLength > START_REQUEST_MAX_BYTES) throw bootstrapFailed();
  const frame = new Uint8Array(5 + payload.byteLength);
  new DataView(frame.buffer).setUint32(1, payload.byteLength);
  frame.set(payload, 5);
  return frame;
}

async function readStartAcknowledgement(
  response: Response,
  signal: AbortSignal,
  deadlineAt: number
): Promise<void> {
  if (!response.body) throw bootstrapFailed();
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (!contentType || !/^application\/connect\+json(?:;\s*charset=utf-8)?$/.test(contentType)) {
    throw bootstrapFailed();
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const frame = new Uint8Array(5 + START_FRAME_MAX_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let buffered = 0;
  let length: number | null = null;
  let received = 0;
  let frames = 0;
  try {
    for (;;) {
      requireTimeRemaining(signal, deadlineAt);
      const result = await reader.read();
      requireTimeRemaining(signal, deadlineAt);
      if (result.done) throw bootstrapFailed();
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw bootstrapFailed();
      received += chunk.byteLength;
      if (received > START_RESPONSE_MAX_BYTES) throw bootstrapFailed();
      let offset = 0;
      while (offset < chunk.byteLength) {
        const target = length === null ? 5 : 5 + length;
        const count = Math.min(target - buffered, chunk.byteLength - offset);
        frame.set(chunk.subarray(offset, offset + count), buffered);
        buffered += count;
        offset += count;
        if (length === null && buffered === 5) {
          length = new DataView(frame.buffer).getUint32(1);
          if (
            frame[0] !== 0 ||
            length === 0 ||
            length > START_FRAME_MAX_BYTES ||
            ++frames > START_MAX_FRAMES
          ) {
            throw bootstrapFailed();
          }
        }
        if (length !== null && buffered === 5 + length) {
          const event = startEventSchema.safeParse(
            JSON.parse(decoder.decode(frame.subarray(5, buffered)))
          );
          if (!event.success) throw bootstrapFailed();
          if ('start' in event.data.event) return;
          buffered = 0;
          length = null;
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function launchE2BWrapper(input: {
  apiKey: string;
  sandbox: E2BSandboxDetail;
  runtimeBuildId: string;
  providerRef: string;
  env: Record<string, string>;
  deadlineAt: number;
}): Promise<void> {
  const controller = new AbortController();
  try {
    validateE2BApiKey(input.apiKey);
    const deadlineAt = Math.min(input.deadlineAt, Date.now() + E2B_MANAGEMENT_TIMEOUT_MS);
    const timeoutMs = deadlineAt - Date.now();
    const token = input.sandbox.envdAccessToken;
    if (
      !Number.isSafeInteger(deadlineAt) ||
      timeoutMs <= 0 ||
      !token ||
      token.includes(input.apiKey)
    ) {
      throw bootstrapFailed();
    }
    const headers = new Headers({
      'E2b-Sandbox-Id': input.sandbox.sandboxID,
      'E2b-Sandbox-Port': '49983',
      'X-Access-Token': token,
      'Accept-Encoding': 'identity',
    });
    validateHeaders(headers);
    const body = encodeStartRequest(input.env, input.providerRef, input.apiKey);
    const signal = controller.signal;
    const runtimeBuildId = input.runtimeBuildId;
    const bootstrap = async () => {
      requireTimeRemaining(signal, deadlineAt);
      const query = new URLSearchParams({ path: MANIFEST_PATH });
      const manifestResponse = await fetch(
        new Request(`${E2B_SANDBOX_URL}/files?${query.toString()}`, {
          headers,
          cache: 'no-store',
          redirect: 'manual',
          signal,
        })
      );
      try {
        requireTimeRemaining(signal, deadlineAt);
        validateResponse(manifestResponse, MANIFEST_MAX_BYTES);
        const manifest = manifestSchema.safeParse(
          JSON.parse(await readE2BResponseText(manifestResponse, MANIFEST_MAX_BYTES, signal))
        );
        if (!manifest.success || manifest.data.runtimeBuildId !== runtimeBuildId)
          throw bootstrapFailed();
      } finally {
        if (!manifestResponse.bodyUsed) await manifestResponse.body?.cancel().catch(() => {});
      }
      requireTimeRemaining(signal, deadlineAt);
      const startHeaders = new Headers(headers);
      startHeaders.set('Content-Type', 'application/connect+json');
      startHeaders.set('Connect-Protocol-Version', '1');
      startHeaders.set('Connect-Accept-Encoding', 'identity');
      startHeaders.set('Keepalive-Ping-Interval', '50');
      validateHeaders(startHeaders);
      const startResponse = await fetch(
        new Request(`${E2B_SANDBOX_URL}/process.Process/Start`, {
          method: 'POST',
          headers: startHeaders,
          body,
          cache: 'no-store',
          redirect: 'manual',
          signal,
        })
      );
      try {
        requireTimeRemaining(signal, deadlineAt);
        validateResponse(startResponse, START_RESPONSE_MAX_BYTES);
        await readStartAcknowledgement(startResponse, signal, deadlineAt);
      } finally {
        if (!startResponse.bodyUsed) await startResponse.body?.cancel().catch(() => {});
      }
    };
    await withTimeout(bootstrap(), timeoutMs, 'E2B wrapper bootstrap timed out', () =>
      controller.abort()
    );
  } catch {
    throw bootstrapFailed();
  } finally {
    controller.abort();
  }
}

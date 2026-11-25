import { INGEST_CHUNK_MAX_BYTES } from '../util/ingest-limits';

export type DirectIngestConfigInput = {
  DIRECT_INGEST_PERCENT: string | undefined;
  DIRECT_INGEST_MAX_BYTES: string | undefined;
};

export type DirectIngestConfig = {
  percent: number;
  maxBytes: number;
};

export type DirectIngestConfigErrorReason = 'invalid_percent' | 'invalid_max_bytes';

export type DirectIngestConfigResult =
  | { ok: true; config: DirectIngestConfig }
  | { ok: false; reason: DirectIngestConfigErrorReason };

export type DirectIngestSelectionResult =
  | { selected: true; reason: 'percentage'; bucket: number | null }
  | { selected: false; reason: 'not_selected'; bucket: number | null };

const unsignedIntegerPattern = /^(0|[1-9]\d*)$/;

export function parseDirectIngestConfig(input: DirectIngestConfigInput): DirectIngestConfigResult {
  const percent = parseUnsignedInteger(input.DIRECT_INGEST_PERCENT);
  if (percent === null || percent > 100) {
    return { ok: false, reason: 'invalid_percent' };
  }

  const maxBytes = parseUnsignedInteger(input.DIRECT_INGEST_MAX_BYTES);
  if (maxBytes === null || maxBytes === 0 || maxBytes > INGEST_CHUNK_MAX_BYTES) {
    return { ok: false, reason: 'invalid_max_bytes' };
  }

  return { ok: true, config: { percent, maxBytes } };
}

export async function selectDirectIngestUser(
  config: DirectIngestConfig,
  kiloUserId: string
): Promise<DirectIngestSelectionResult> {
  if (config.percent === 0) {
    return { selected: false, reason: 'not_selected', bucket: null };
  }

  if (config.percent === 100) {
    return { selected: true, reason: 'percentage', bucket: null };
  }

  const bucket = await getDirectIngestUserBucket(kiloUserId);
  return bucket < config.percent
    ? { selected: true, reason: 'percentage', bucket }
    : { selected: false, reason: 'not_selected', bucket };
}

export async function getDirectIngestUserBucket(kiloUserId: string): Promise<number> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(kiloUserId))
  );
  const firstFourBytes = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0);
  return firstFourBytes % 100;
}

function parseUnsignedInteger(value: string | undefined): number | null {
  if (value === undefined || !unsignedIntegerPattern.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

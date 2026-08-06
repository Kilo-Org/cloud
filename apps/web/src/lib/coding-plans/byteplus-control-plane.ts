import 'server-only';

import { createHash, createHmac } from 'node:crypto';
import * as z from 'zod';

import {
  BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID,
  BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY,
} from '@/lib/config.server';

const BYTEPLUS_CONTROL_PLANE_URL = 'https://ark.ap-southeast-1.byteplusapi.com/';
const BYTEPLUS_CONTROL_PLANE_HOST = 'ark.ap-southeast-1.byteplusapi.com';
const BYTEPLUS_CONTROL_PLANE_SERVICE = 'ark';
const BYTEPLUS_CONTROL_PLANE_REGION = 'ap-southeast-1';
const BYTEPLUS_CONTROL_PLANE_VERSION = '2024-01-01';
const BYTEPLUS_CONTROL_PLANE_PROJECT = 'default';
const BYTEPLUS_CONTROL_PLANE_TIMEOUT_MS = 5_000;
const BYTEPLUS_CONTROL_PLANE_MAX_RESPONSE_BYTES = 64 * 1024;
const BYTEPLUS_LIST_SEATS_PAGE_SIZE = 100;
const BYTEPLUS_CONTENT_TYPE = 'application/json; charset=UTF-8';
const BYTEPLUS_SIGNED_HEADERS = ['content-type', 'host', 'x-content-sha256', 'x-date'] as const;

export type BytePlusControlPlaneErrorCode =
  | 'configuration'
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid_response'
  | 'application';

export class BytePlusControlPlaneError extends Error {
  readonly code: BytePlusControlPlaneErrorCode;

  constructor(code: BytePlusControlPlaneErrorCode) {
    super('BytePlus Coding Plan service is temporarily unavailable.');
    this.name = 'BytePlusControlPlaneError';
    this.code = code;
  }
}

export type BytePlusCodingPlanTier = 'Lite' | 'Pro';

export type BytePlusSeat = {
  seatId: string;
  bizInfo: BytePlusCodingPlanTier;
  seatStatus: 1 | 2;
  billingStatus: 1 | 2 | 3 | 4;
  apiKey?: string;
};

export type BytePlusSeatUsage = {
  shortTermUsage?: number;
  weeklyUsage?: number;
  monthlyUsage?: number;
  shortTermResetMilestone?: number;
  weeklyResetMilestone?: number;
  monthlyResetMilestone?: number;
};

const BytePlusScalarSchema = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const BytePlusUsernameSchema = z.string().trim().min(1).max(256);
const BytePlusSeatIdSchema = z.string().trim().min(1).max(256);

const BytePlusSeatSchema = z.object({
  SeatID: z.string().trim().min(1).max(256),
  UserName: z.string().trim().min(1).max(256).optional(),
  ProjectName: z.string().trim().min(1).max(128).optional(),
  BizInfo: BytePlusScalarSchema,
  SeatStatus: BytePlusScalarSchema,
  BillingStatus: BytePlusScalarSchema,
  ApiKey: z.string().min(1).max(512).nullable().optional(),
});

const BytePlusListResultSchema = z.object({
  Data: z.array(BytePlusSeatSchema).max(1_000),
  Total: z.number().int().nonnegative().safe().optional(),
});

const BytePlusListResponseSchema = z.object({
  ResponseMetadata: z.record(z.string(), z.unknown()).optional(),
  Result: BytePlusListResultSchema,
});

const BytePlusUsageResultSchema = z
  .object({
    ShortTermUsage: z.number().finite().optional(),
    WeeklyUsage: z.number().finite().optional(),
    MonthlyUsage: z.number().finite().optional(),
    ShortTermResetMilestone: z.number().finite().optional(),
    WeeklyResetMilestone: z.number().finite().optional(),
    MonthlyResetMilestone: z.number().finite().optional(),
  })
  .superRefine((result, context) => {
    if (Object.keys(result).length === 0) {
      context.addIssue({ code: 'custom', message: 'Usage result has no supported fields.' });
    }
  });

const BytePlusUsageResponseSchema = z.object({
  ResponseMetadata: z.record(z.string(), z.unknown()).optional(),
  Result: BytePlusUsageResultSchema,
});

type BytePlusApiAction = 'ListSeatInfos' | 'GetSeatInfoUsage';

type BytePlusRequestBody = Record<string, unknown>;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    asciiCompare(left, right)
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

function formatBytePlusDate(date: Date): { requestDate: string; shortDate: string } {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');
  const shortDate = `${year}${month}${day}`;
  return { requestDate: `${shortDate}T${hours}${minutes}${seconds}Z`, shortDate };
}

function canonicalQuery(action: BytePlusApiAction): string {
  return [
    ['Action', action],
    ['Version', BYTEPLUS_CONTROL_PLANE_VERSION],
  ]
    .sort(([left], [right]) => asciiCompare(left, right))
    .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(value)}`)
    .join('&');
}

function canonicalHeaders(headers: Record<string, string>): {
  value: string;
  signedHeaders: string;
} {
  const entries = BYTEPLUS_SIGNED_HEADERS.map(name => [name, headers[name]] as const).sort(
    ([left], [right]) => asciiCompare(left, right)
  );
  return {
    value: entries.map(([name, value]) => `${name}:${value.trim()}\n`).join(''),
    signedHeaders: entries.map(([name]) => name).join(';'),
  };
}

function buildAuthorization(input: {
  action: BytePlusApiAction;
  body: string;
  requestDate: string;
  shortDate: string;
  accessKeyId: string;
  secretAccessKey: string;
}): { authorization: string; contentHash: string } {
  const contentHash = sha256Hex(input.body);
  const headers = canonicalHeaders({
    'content-type': BYTEPLUS_CONTENT_TYPE,
    host: BYTEPLUS_CONTROL_PLANE_HOST,
    'x-content-sha256': contentHash,
    'x-date': input.requestDate,
  });
  const canonicalRequest = [
    'POST',
    '/',
    canonicalQuery(input.action),
    headers.value,
    headers.signedHeaders,
    contentHash,
  ].join('\n');
  const credentialScope = `${input.shortDate}/${BYTEPLUS_CONTROL_PLANE_REGION}/${BYTEPLUS_CONTROL_PLANE_SERVICE}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    input.requestDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const dateKey = hmacSha256(input.secretAccessKey, input.shortDate);
  const regionKey = hmacSha256(dateKey, BYTEPLUS_CONTROL_PLANE_REGION);
  const serviceKey = hmacSha256(regionKey, BYTEPLUS_CONTROL_PLANE_SERVICE);
  const signingKey = hmacSha256(serviceKey, 'request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    contentHash,
    authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${headers.signedHeaders}, Signature=${signature}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasProviderApplicationError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const metadata = value.ResponseMetadata;
  if (!isRecord(metadata)) return false;
  return (
    Object.hasOwn(metadata, 'Error') ||
    Object.hasOwn(metadata, 'ErrorCode') ||
    Object.hasOwn(metadata, 'ErrorMessage')
  );
}

function normalizeTier(value: string | number): BytePlusCodingPlanTier {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'lite' || normalized === '1') return 'Lite';
  if (normalized === 'pro' || normalized === '2') return 'Pro';
  throw new BytePlusControlPlaneError('invalid_response');
}

function normalizeSeatStatus(value: string | number): 1 | 2 {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'idle') return 1;
  if (normalized === '2' || normalized === 'active' || normalized === 'bound') return 2;
  throw new BytePlusControlPlaneError('invalid_response');
}

function normalizeBillingStatus(value: string | number): 1 | 2 | 3 | 4 {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'pending') return 1;
  if (normalized === '2' || normalized === 'running') return 2;
  if (normalized === '3' || normalized === 'expired') return 3;
  if (normalized === '4' || normalized === 'reclaimed') return 4;
  throw new BytePlusControlPlaneError('invalid_response');
}

function safeBytePlusErrorCode(error: unknown): BytePlusControlPlaneErrorCode {
  return error instanceof BytePlusControlPlaneError ? error.code : 'network';
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (
      Number.isSafeInteger(parsedLength) &&
      parsedLength > BYTEPLUS_CONTROL_PLANE_MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new BytePlusControlPlaneError('invalid_response');
    }
  }

  if (!response.body) {
    throw new BytePlusControlPlaneError('invalid_response');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BYTEPLUS_CONTROL_PLANE_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BytePlusControlPlaneError('invalid_response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  return body.toString('utf8');
}

async function callBytePlusControlPlane(
  action: BytePlusApiAction,
  body: BytePlusRequestBody
): Promise<unknown> {
  const accessKeyId = BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID;
  const secretAccessKey = BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new BytePlusControlPlaneError('configuration');
  }

  const serializedBody = stableJson(body);
  const { requestDate, shortDate } = formatBytePlusDate(new Date());
  const { authorization, contentHash } = buildAuthorization({
    action,
    body: serializedBody,
    requestDate,
    shortDate,
    accessKeyId,
    secretAccessKey,
  });

  let response: Response;
  try {
    response = await fetch(
      `${BYTEPLUS_CONTROL_PLANE_URL}?Action=${rfc3986Encode(action)}&Version=${rfc3986Encode(BYTEPLUS_CONTROL_PLANE_VERSION)}`,
      {
        method: 'POST',
        headers: {
          'content-type': BYTEPLUS_CONTENT_TYPE,
          host: BYTEPLUS_CONTROL_PLANE_HOST,
          'x-content-sha256': contentHash,
          'x-date': requestDate,
          Authorization: authorization,
        },
        body: serializedBody,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(BYTEPLUS_CONTROL_PLANE_TIMEOUT_MS),
      }
    );
  } catch (error) {
    const name =
      error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
        ? String((error as { name?: unknown }).name ?? '')
        : '';
    throw new BytePlusControlPlaneError(
      name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network'
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new BytePlusControlPlaneError('http');
  }

  let responseBody: string;
  try {
    responseBody = await readBoundedResponseBody(response);
  } catch (error) {
    throw new BytePlusControlPlaneError(safeBytePlusErrorCode(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody) as unknown;
  } catch {
    throw new BytePlusControlPlaneError('invalid_response');
  }
  if (hasProviderApplicationError(parsed)) {
    throw new BytePlusControlPlaneError('application');
  }
  return parsed;
}

function parseBytePlusSeat(value: z.infer<typeof BytePlusSeatSchema>): BytePlusSeat & {
  userName?: string;
  projectName?: string;
} {
  return {
    seatId: value.SeatID,
    bizInfo: normalizeTier(value.BizInfo),
    seatStatus: normalizeSeatStatus(value.SeatStatus),
    billingStatus: normalizeBillingStatus(value.BillingStatus),
    ...(value.ApiKey ? { apiKey: value.ApiKey } : {}),
    ...(value.UserName ? { userName: value.UserName } : {}),
    ...(value.ProjectName ? { projectName: value.ProjectName } : {}),
  };
}

export async function listBytePlusSeatsByUsername(
  input: { username: string; bizInfo: BytePlusCodingPlanTier } | string,
  tier?: BytePlusCodingPlanTier
): Promise<BytePlusSeat[]> {
  const rawUsername = typeof input === 'string' ? input : input.username;
  const usernameResult = BytePlusUsernameSchema.safeParse(rawUsername);
  const username = usernameResult.success ? usernameResult.data : null;
  const bizInfo = typeof input === 'string' ? tier : input.bizInfo;
  if (!username || (bizInfo !== 'Lite' && bizInfo !== 'Pro')) {
    throw new BytePlusControlPlaneError('invalid_response');
  }

  const parsed = BytePlusListResponseSchema.safeParse(
    await callBytePlusControlPlane('ListSeatInfos', {
      Filter: {
        BizInfo: bizInfo,
        UserName: username,
        SeatStatus: 2,
        BillingStatus: [2],
      },
      PageNum: 1,
      PageSize: BYTEPLUS_LIST_SEATS_PAGE_SIZE,
      ProjectName: BYTEPLUS_CONTROL_PLANE_PROJECT,
    })
  );
  if (!parsed.success) {
    throw new BytePlusControlPlaneError('invalid_response');
  }

  if (
    parsed.data.Result.Total !== undefined &&
    parsed.data.Result.Total > parsed.data.Result.Data.length
  ) {
    throw new BytePlusControlPlaneError('invalid_response');
  }

  try {
    return parsed.data.Result.Data.map(parseBytePlusSeat).map(seat => {
      // UserName and ProjectName are optional in some API responses. When
      // present, they must still agree with the exact filter supplied by Kilo.
      if (
        (seat.userName !== undefined && seat.userName !== username) ||
        (seat.projectName !== undefined && seat.projectName !== BYTEPLUS_CONTROL_PLANE_PROJECT)
      ) {
        throw new BytePlusControlPlaneError('invalid_response');
      }
      const { userName: _userName, projectName: _projectName, ...fieldPickedSeat } = seat;
      return fieldPickedSeat;
    });
  } catch (error) {
    throw new BytePlusControlPlaneError(safeBytePlusErrorCode(error));
  }
}

export async function getBytePlusSeatUsage(
  input: string | { seatId: string }
): Promise<BytePlusSeatUsage> {
  const rawSeatId = typeof input === 'string' ? input : input.seatId;
  const seatIdResult = BytePlusSeatIdSchema.safeParse(rawSeatId);
  if (!seatIdResult.success) {
    throw new BytePlusControlPlaneError('invalid_response');
  }
  const seatId = seatIdResult.data;

  const parsed = BytePlusUsageResponseSchema.safeParse(
    await callBytePlusControlPlane('GetSeatInfoUsage', { SeatID: seatId })
  );
  if (!parsed.success) {
    throw new BytePlusControlPlaneError('invalid_response');
  }

  return {
    ...(parsed.data.Result.ShortTermUsage !== undefined
      ? { shortTermUsage: parsed.data.Result.ShortTermUsage }
      : {}),
    ...(parsed.data.Result.WeeklyUsage !== undefined
      ? { weeklyUsage: parsed.data.Result.WeeklyUsage }
      : {}),
    ...(parsed.data.Result.MonthlyUsage !== undefined
      ? { monthlyUsage: parsed.data.Result.MonthlyUsage }
      : {}),
    ...(parsed.data.Result.ShortTermResetMilestone !== undefined
      ? { shortTermResetMilestone: parsed.data.Result.ShortTermResetMilestone }
      : {}),
    ...(parsed.data.Result.WeeklyResetMilestone !== undefined
      ? { weeklyResetMilestone: parsed.data.Result.WeeklyResetMilestone }
      : {}),
    ...(parsed.data.Result.MonthlyResetMilestone !== undefined
      ? { monthlyResetMilestone: parsed.data.Result.MonthlyResetMilestone }
      : {}),
  };
}

import 'server-only';

import { createHash } from 'crypto';
import { IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, IMPACT_CAMPAIGN_ID } from '@/lib/config.server';

const IMPACT_REVERSAL_DISPOSITION_CODE = 'REJECTED';

const IMPACT_BASE_URL = 'https://api.impact.com';
export const IMPACT_ORDER_ID_MACRO = 'IR_AN_64_TS';

export const IMPACT_ACTION_TRACKER_IDS = {
  signUp: 71655,
  trialStart: 71656,
  trialEnd: 71658,
  sale: 71659,
  visit: 71668,
} as const;

export type ImpactConversionPayload = {
  CampaignId: string;
  ActionTrackerId: number;
  EventDate: string;
  OrderId: string;
  ClickId?: string;
  CustomerId?: string;
  CustomerEmail?: string;
  CustomerStatus?: 'NEW';
  ItemSubTotal1?: string;
  CurrencyCode?: string;
  ItemCategory1?: string;
  ItemSku1?: string;
  ItemName1?: string;
  ItemQuantity1?: number;
  Numeric1?: number;
  PromoCode?: string;
};

type ImpactCustomerFields = {
  trackingId?: string | null;
  customerId: string;
  customerEmailHash: string;
  customerStatus?: 'NEW';
};

type ImpactSaleFields = ImpactCustomerFields & {
  orderId: string;
  amount: number;
  currencyCode: string;
  itemCategory: string;
  itemName: string;
  itemSku?: string;
  promoCode?: string;
};

type ImpactConfig = {
  accountSid: string;
  authToken: string;
  campaignId: string;
};

type ImpactActionReference = {
  actionId: string;
  actionUri?: string;
};

type ImpactRequestSuccess =
  | {
      ok: true;
      skipped: 'unconfigured';
      delivery?: never;
      actionId?: never;
      actionUri?: never;
      submissionUri?: never;
      responseBody?: string;
    }
  | {
      ok: true;
      delivery: 'accepted';
      skipped?: never;
      actionId?: never;
      actionUri?: never;
      submissionUri?: never;
      responseBody?: string;
    }
  | {
      ok: true;
      delivery: 'immediate';
      skipped?: never;
      actionId: string;
      actionUri?: string;
      submissionUri?: never;
      responseBody?: string;
    }
  | {
      ok: true;
      delivery: 'queued';
      skipped?: never;
      actionId?: never;
      actionUri?: never;
      submissionUri: string;
      responseBody?: string;
    };

type ImpactRequestFailure = {
  ok: false;
  failureKind: 'http_4xx' | 'http_5xx' | 'network' | 'submission_failed';
  statusCode?: number;
  responseBody?: string;
  error?: string;
};

export type ImpactDispatchResult = ImpactRequestSuccess | ImpactRequestFailure;

export type ImpactSubmissionResolutionResult =
  | {
      ok: true;
      status: 'resolved';
      actionId: string;
      actionUri?: string;
      responseBody?: string;
    }
  | {
      ok: true;
      status: 'pending';
      responseBody?: string;
    }
  | {
      ok: false;
      failureKind: 'http_4xx' | 'http_5xx' | 'network' | 'submission_failed';
      statusCode?: number;
      responseBody?: string;
      error?: string;
    };

function getImpactConfig(): ImpactConfig | null {
  if (!IMPACT_ACCOUNT_SID || !IMPACT_AUTH_TOKEN || !IMPACT_CAMPAIGN_ID) {
    return null;
  }

  return {
    accountSid: IMPACT_ACCOUNT_SID,
    authToken: IMPACT_AUTH_TOKEN,
    campaignId: IMPACT_CAMPAIGN_ID,
  };
}

export function isImpactConfigured(): boolean {
  return getImpactConfig() !== null;
}

function toEventDate(eventDate: Date): string {
  return eventDate.toISOString();
}

function normalizeTrackingId(trackingId?: string | null): string | undefined {
  const trimmed = trackingId?.trim();
  return trimmed ? trimmed : undefined;
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function buildCustomerFields(fields: ImpactCustomerFields) {
  return {
    ...(normalizeTrackingId(fields.trackingId)
      ? { ClickId: normalizeTrackingId(fields.trackingId) }
      : {}),
    CustomerId: fields.customerId,
    CustomerEmail: fields.customerEmailHash,
    ...(fields.customerStatus ? { CustomerStatus: fields.customerStatus } : {}),
  } satisfies Partial<ImpactConversionPayload>;
}

function buildSaleFields(fields: ImpactSaleFields) {
  return {
    ...buildCustomerFields(fields),
    OrderId: fields.orderId,
    ItemSubTotal1: formatAmount(fields.amount),
    CurrencyCode: fields.currencyCode.toUpperCase(),
    ItemCategory1: fields.itemCategory,
    ItemName1: fields.itemName,
    ItemQuantity1: 1,
    ...(fields.itemSku ? { ItemSku1: fields.itemSku } : {}),
    ...(fields.promoCode ? { PromoCode: fields.promoCode } : {}),
  } satisfies Partial<ImpactConversionPayload>;
}

export function hashEmailForImpact(email: string): string {
  return createHash('sha1').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export function buildVisitPayload(params: {
  trackingId: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.visit,
    EventDate: toEventDate(params.eventDate),
    ClickId: params.trackingId,
    OrderId: IMPACT_ORDER_ID_MACRO,
  };
}

export function buildSignUpPayload(params: {
  trackingId?: string | null;
  customerId: string;
  customerEmailHash: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.signUp,
    EventDate: toEventDate(params.eventDate),
    OrderId: IMPACT_ORDER_ID_MACRO,
    ...buildCustomerFields({
      trackingId: params.trackingId,
      customerId: params.customerId,
      customerEmailHash: params.customerEmailHash,
      customerStatus: 'NEW',
    }),
  };
}

export function buildTrialStartPayload(params: {
  trackingId?: string | null;
  customerId: string;
  customerEmailHash: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.trialStart,
    EventDate: toEventDate(params.eventDate),
    OrderId: IMPACT_ORDER_ID_MACRO,
    ...buildCustomerFields({
      trackingId: params.trackingId,
      customerId: params.customerId,
      customerEmailHash: params.customerEmailHash,
      customerStatus: 'NEW',
    }),
  };
}

export function buildTrialEndPayload(params: {
  trackingId?: string | null;
  customerId: string;
  customerEmailHash: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.trialEnd,
    EventDate: toEventDate(params.eventDate),
    OrderId: IMPACT_ORDER_ID_MACRO,
    ...buildCustomerFields({
      trackingId: params.trackingId,
      customerId: params.customerId,
      customerEmailHash: params.customerEmailHash,
      customerStatus: 'NEW',
    }),
  };
}

export function buildSalePayload(
  params: ImpactSaleFields & { eventDate: Date }
): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.sale,
    EventDate: toEventDate(params.eventDate),
    ...buildSaleFields(params),
  };
}

function buildImpactUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  return `${IMPACT_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function getAuthorizationHeader(config: ImpactConfig): string {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;
}

function parseJsonResponse(responseBody: string): unknown {
  try {
    return JSON.parse(responseBody) as unknown;
  } catch {
    return null;
  }
}

function getObjectProperty(record: Record<string, unknown>, key: string): unknown {
  if (key in record) {
    return record[key];
  }

  const lowerKey = key.toLowerCase();
  const matchedKey = Object.keys(record).find(candidate => candidate.toLowerCase() === lowerKey);
  return matchedKey ? record[matchedKey] : undefined;
}

function normalizeUri(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') {
    return undefined;
  }

  const trimmed = candidate.trim();
  return trimmed ? trimmed : undefined;
}

function actionIdFromUri(uri: string): string | undefined {
  const match = uri.match(/\/Actions\/([^/?#]+)/i);
  return match?.[1];
}

function submissionUriFromUri(uri: string): string | undefined {
  const match = uri.match(
    /(\/Advertisers\/[^"'\\\s/]+\/APISubmissions\/[^"'\\\s]+|\/APISubmissions\/[^"'\\\s]+)/i
  );
  return match?.[1];
}

function looksLikeImpactActionId(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function getSearchCandidates(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return [
    value,
    ...Object.values(record),
    getObjectProperty(record, 'Action'),
    getObjectProperty(record, 'Actions'),
    getObjectProperty(record, 'Result'),
    getObjectProperty(record, 'Results'),
    getObjectProperty(record, 'Data'),
    getObjectProperty(record, 'Payload'),
  ].filter(candidate => candidate !== undefined);
}

function findImpactActionReference(value: unknown, depth = 0): ImpactActionReference | null {
  if (depth > 4 || !value || typeof value !== 'object') {
    return null;
  }

  const candidates = getSearchCandidates(value);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const nestedMatch = findImpactActionReference(item, depth + 1);
        if (nestedMatch) {
          return nestedMatch;
        }
      }
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const actionUri =
      normalizeUri(getObjectProperty(record, 'ActionUri')) ??
      normalizeUri(getObjectProperty(record, 'Uri'));
    const hasExplicitActionId = getObjectProperty(record, 'ActionId') !== undefined;
    const actionIdCandidate = hasExplicitActionId
      ? normalizeUri(getObjectProperty(record, 'ActionId'))
      : normalizeUri(getObjectProperty(record, 'Id'));
    const actionId =
      actionIdCandidate &&
      (hasExplicitActionId || looksLikeImpactActionId(actionIdCandidate)) &&
      (!actionUri || actionIdFromUri(actionUri) === actionIdCandidate)
        ? actionIdCandidate
        : actionUri
          ? actionIdFromUri(actionUri)
          : undefined;

    if (actionId) {
      return {
        actionId,
        actionUri,
      };
    }

    const nestedMatch = findImpactActionReference(record, depth + 1);
    if (nestedMatch) {
      return nestedMatch;
    }
  }

  return null;
}

function findImpactSubmissionUri(value: unknown, depth = 0): string | null {
  if (depth > 4 || !value || typeof value !== 'object') {
    return null;
  }

  const candidates = getSearchCandidates(value);
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const submissionUri = submissionUriFromUri(candidate);
      if (submissionUri) {
        return submissionUri;
      }
      continue;
    }

    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const nestedUri = findImpactSubmissionUri(item, depth + 1);
        if (nestedUri) {
          return nestedUri;
        }
      }
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const directUri =
      normalizeUri(getObjectProperty(record, 'QueuedUri')) ??
      normalizeUri(getObjectProperty(record, 'SubmissionUri')) ??
      normalizeUri(getObjectProperty(record, 'Uri'));
    const submissionUri = directUri ? submissionUriFromUri(directUri) : undefined;
    if (submissionUri) {
      return submissionUri;
    }

    const nestedUri = findImpactSubmissionUri(record, depth + 1);
    if (nestedUri) {
      return nestedUri;
    }
  }

  return null;
}

function parseImpactRequestSuccess(responseBody: string): ImpactRequestSuccess {
  const parsedResponse = parseJsonResponse(responseBody);
  const actionReference = findImpactActionReference(parsedResponse);
  if (actionReference) {
    return {
      ok: true,
      delivery: 'immediate',
      actionId: actionReference.actionId,
      actionUri: actionReference.actionUri,
      responseBody,
    };
  }

  const submissionUri =
    findImpactSubmissionUri(parsedResponse) ?? submissionUriFromUri(responseBody) ?? null;
  if (submissionUri) {
    return {
      ok: true,
      delivery: 'queued',
      submissionUri,
      responseBody,
    };
  }

  return {
    ok: true,
    delivery: 'accepted',
    responseBody,
  };
}

async function sendImpactRequest(params: {
  method: 'POST' | 'GET' | 'DELETE';
  path: string;
  body?: BodyInit;
  contentType?: string;
}): Promise<ImpactDispatchResult> {
  const config = getImpactConfig();
  if (!config) {
    return {
      ok: true,
      skipped: 'unconfigured',
    };
  }

  try {
    const response = await fetch(buildImpactUrl(params.path), {
      method: params.method,
      headers: {
        Authorization: getAuthorizationHeader(config),
        Accept: 'application/json',
        ...(params.contentType ? { 'Content-Type': params.contentType } : {}),
      },
      ...(params.body ? { body: params.body } : {}),
    });

    const responseBody = await response.text();

    if (response.ok) {
      return parseImpactRequestSuccess(responseBody);
    }

    return {
      ok: false,
      failureKind: response.status >= 500 ? 'http_5xx' : 'http_4xx',
      statusCode: response.status,
      responseBody,
    };
  } catch (error) {
    return {
      ok: false,
      failureKind: 'network',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getNormalizedStatus(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.toUpperCase().replaceAll(' ', '_');
}

export async function sendImpactConversionPayload(
  payload: ImpactConversionPayload
): Promise<ImpactDispatchResult> {
  const result = await sendImpactRequest({
    method: 'POST',
    path: `/Advertisers/${IMPACT_ACCOUNT_SID}/Conversions`,
    body: JSON.stringify(payload),
    contentType: 'application/json',
  });

  if (
    result.ok &&
    payload.ActionTrackerId === IMPACT_ACTION_TRACKER_IDS.sale &&
    !result.skipped &&
    result.delivery !== 'immediate' &&
    result.delivery !== 'queued'
  ) {
    return {
      ok: false,
      failureKind: 'submission_failed',
      responseBody: result.responseBody,
      error: 'Impact sale success response missing action mapping',
    };
  }

  return result;
}

export async function resolveImpactSubmissionUri(
  submissionUri: string
): Promise<ImpactSubmissionResolutionResult> {
  const result = await sendImpactRequest({
    method: 'GET',
    path: submissionUri,
  });

  if (!result.ok) {
    return result.failureKind === 'network'
      ? {
          ok: false,
          failureKind: 'network',
          error: result.error,
        }
      : {
          ok: false,
          failureKind: result.failureKind,
          statusCode: result.statusCode,
          responseBody: result.responseBody,
        };
  }

  if (result.skipped === 'unconfigured') {
    return {
      ok: false,
      failureKind: 'submission_failed',
      error: 'Impact is unconfigured; cannot resolve queued submission',
    };
  }

  if (result.delivery === 'immediate') {
    return {
      ok: true,
      status: 'resolved',
      actionId: result.actionId,
      actionUri: result.actionUri,
      responseBody: result.responseBody,
    };
  }

  const parsedResponse = parseJsonResponse(result.responseBody ?? '');
  const status =
    parsedResponse && typeof parsedResponse === 'object'
      ? getNormalizedStatus(getObjectProperty(parsedResponse as Record<string, unknown>, 'Status'))
      : null;

  if (
    status === 'QUEUED' ||
    status === 'RUNNING' ||
    status === 'PENDING' ||
    status === 'IN_PROGRESS' ||
    status === 'PROCESSING'
  ) {
    return {
      ok: true,
      status: 'pending',
      responseBody: result.responseBody,
    };
  }

  return {
    ok: false,
    failureKind: 'submission_failed',
    responseBody: result.responseBody,
    error: status
      ? `Impact submission finished without action mapping (${status})`
      : 'Impact submission finished without action mapping',
  };
}

export async function reverseImpactAction(params: {
  actionId: string;
}): Promise<ImpactDispatchResult> {
  const formData = new URLSearchParams({
    ActionId: params.actionId,
    DispositionCode: IMPACT_REVERSAL_DISPOSITION_CODE,
  });

  return await sendImpactRequest({
    method: 'DELETE',
    path: `/Advertisers/${IMPACT_ACCOUNT_SID}/Actions`,
    body: formData.toString(),
    contentType: 'application/x-www-form-urlencoded',
  });
}

function throwIfImpactDispatchFailed(eventName: string, result: ImpactDispatchResult): void {
  if (result.ok) {
    return;
  }

  const details =
    result.failureKind === 'network'
      ? (result.error ?? 'unknown network error')
      : `status ${result.statusCode ?? 'unknown'}${result.responseBody ? `: ${result.responseBody}` : ''}`;
  throw new Error(`Impact ${eventName} dispatch failed (${result.failureKind}): ${details}`);
}

export async function trackVisit(params: { trackingId: string; eventDate: Date }): Promise<void> {
  const result = await sendImpactConversionPayload(buildVisitPayload(params));
  throwIfImpactDispatchFailed('visit', result);
}

export async function trackSignUp(params: {
  trackingId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): Promise<void> {
  const result = await sendImpactConversionPayload(
    buildSignUpPayload({
      trackingId: params.trackingId,
      customerId: params.customerId,
      customerEmailHash: hashEmailForImpact(params.customerEmail),
      eventDate: params.eventDate,
    })
  );
  throwIfImpactDispatchFailed('signup', result);
}

export async function trackTrialStart(params: {
  trackingId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): Promise<void> {
  const result = await sendImpactConversionPayload(
    buildTrialStartPayload({
      trackingId: params.trackingId,
      customerId: params.customerId,
      customerEmailHash: hashEmailForImpact(params.customerEmail),
      eventDate: params.eventDate,
    })
  );
  throwIfImpactDispatchFailed('trial_start', result);
}

export async function trackTrialEnd(params: {
  trackingId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): Promise<void> {
  const result = await sendImpactConversionPayload(
    buildTrialEndPayload({
      trackingId: params.trackingId,
      customerId: params.customerId,
      customerEmailHash: hashEmailForImpact(params.customerEmail),
      eventDate: params.eventDate,
    })
  );
  throwIfImpactDispatchFailed('trial_end', result);
}

export async function trackSale(
  params: Omit<ImpactSaleFields, 'customerEmailHash'> & { customerEmail: string; eventDate: Date }
): Promise<void> {
  const result = await sendImpactConversionPayload(
    buildSalePayload({
      trackingId: params.trackingId,
      customerId: params.customerId,
      customerEmailHash: hashEmailForImpact(params.customerEmail),
      orderId: params.orderId,
      amount: params.amount,
      currencyCode: params.currencyCode,
      eventDate: params.eventDate,
      itemCategory: params.itemCategory,
      itemName: params.itemName,
      itemSku: params.itemSku,
      promoCode: params.promoCode,
    })
  );
  throwIfImpactDispatchFailed('sale', result);
}

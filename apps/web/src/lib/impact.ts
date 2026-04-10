import 'server-only';

import { createHash } from 'crypto';
import { IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, IMPACT_CAMPAIGN_ID } from '@/lib/config.server';

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

function getImpactConfig() {
  if (!IMPACT_ACCOUNT_SID || !IMPACT_AUTH_TOKEN || !IMPACT_CAMPAIGN_ID) {
    return null;
  }

  return {
    accountSid: IMPACT_ACCOUNT_SID,
    authToken: IMPACT_AUTH_TOKEN,
    campaignId: IMPACT_CAMPAIGN_ID,
  };
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

export type ImpactDispatchResult =
  | {
      ok: true;
      actionTrackerId: number;
      skipped?: 'unconfigured';
    }
  | {
      ok: false;
      actionTrackerId: number;
      failureKind: 'http_4xx' | 'http_5xx' | 'network';
      statusCode?: number;
      responseBody?: string;
      error?: string;
    };

export async function sendImpactConversionPayload(
  payload: ImpactConversionPayload
): Promise<ImpactDispatchResult> {
  const config = getImpactConfig();
  if (!config) {
    return {
      ok: true,
      actionTrackerId: payload.ActionTrackerId,
      skipped: 'unconfigured',
    };
  }

  const url = `${IMPACT_BASE_URL}/Advertisers/${config.accountSid}/Conversions`;
  const authorization = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return {
        ok: true,
        actionTrackerId: payload.ActionTrackerId,
      };
    }

    const responseBody = await response.text();
    return {
      ok: false,
      actionTrackerId: payload.ActionTrackerId,
      failureKind: response.status >= 500 ? 'http_5xx' : 'http_4xx',
      statusCode: response.status,
      responseBody,
    };
  } catch (error) {
    return {
      ok: false,
      actionTrackerId: payload.ActionTrackerId,
      failureKind: 'network',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function throwIfImpactDispatchFailed(eventName: string, result: ImpactDispatchResult): void {
  if (result.ok) return;

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

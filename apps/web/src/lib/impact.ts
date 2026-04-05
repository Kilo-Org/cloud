import 'server-only';

import { createHash } from 'crypto';
import {
  IMPACT_ACCOUNT_SID,
  IMPACT_AUTH_TOKEN,
  IMPACT_CAMPAIGN_ID,
  IS_IN_AUTOMATED_TEST,
} from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';

const logInfo = sentryLogger('impact', 'info');
const logWarning = sentryLogger('impact', 'warning');
const logError = sentryLogger('impact', 'error');

const IMPACT_BASE_URL = 'https://api.impact.com';
export const IMPACT_ORDER_ID_MACRO = 'IR_AN_64_TS';

export const IMPACT_ACTION_TRACKER_IDS = {
  signUp: 71655,
  trialStart: 71656,
  trialEnd: 71658,
  sale: 71659,
  visit: 71668,
} as const;

type ImpactConversionPayload = {
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
  clickId?: string | null;
  customerId: string;
  customerEmail: string;
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

function normalizeClickId(clickId?: string | null): string | undefined {
  const trimmed = clickId?.trim();
  return trimmed ? trimmed : undefined;
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function buildCustomerFields(fields: ImpactCustomerFields) {
  return {
    ...(normalizeClickId(fields.clickId) ? { ClickId: normalizeClickId(fields.clickId) } : {}),
    CustomerId: fields.customerId,
    CustomerEmail: hashEmailForImpact(fields.customerEmail),
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
  clickId: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.visit,
    EventDate: toEventDate(params.eventDate),
    ClickId: params.clickId,
    OrderId: IMPACT_ORDER_ID_MACRO,
  };
}

export function buildSignUpPayload(params: {
  clickId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.signUp,
    EventDate: toEventDate(params.eventDate),
    OrderId: IMPACT_ORDER_ID_MACRO,
    ...buildCustomerFields({
      clickId: params.clickId,
      customerId: params.customerId,
      customerEmail: params.customerEmail,
      customerStatus: 'NEW',
    }),
  };
}

export function buildTrialStartPayload(params: {
  clickId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.trialStart,
    EventDate: toEventDate(params.eventDate),
    OrderId: IMPACT_ORDER_ID_MACRO,
    ...buildCustomerFields({
      clickId: params.clickId,
      customerId: params.customerId,
      customerEmail: params.customerEmail,
      customerStatus: 'NEW',
    }),
  };
}

export function buildTrialEndPayload(params: {
  clickId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): ImpactConversionPayload {
  return {
    CampaignId: IMPACT_CAMPAIGN_ID,
    ActionTrackerId: IMPACT_ACTION_TRACKER_IDS.trialEnd,
    EventDate: toEventDate(params.eventDate),
    OrderId: IMPACT_ORDER_ID_MACRO,
    ...buildCustomerFields({
      clickId: params.clickId,
      customerId: params.customerId,
      customerEmail: params.customerEmail,
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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function sendImpactConversion(
  payload: ImpactConversionPayload,
  eventName: string
): Promise<void> {
  const config = getImpactConfig();
  if (!config) return;

  const url = `${IMPACT_BASE_URL}/Advertisers/${config.accountSid}/Conversions`;
  const authorization = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  for (let attempt = 1; attempt <= 3; attempt++) {
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
        if (IS_IN_AUTOMATED_TEST) {
          logInfo('Impact conversion sent', {
            event_name: eventName,
            action_tracker_id: payload.ActionTrackerId,
          });
        }
        return;
      }

      const responseBody = await response.text();
      const shouldRetry = response.status >= 500 && attempt < 3;
      const log = shouldRetry ? logWarning : logError;
      log('Impact conversion request failed', {
        event_name: eventName,
        action_tracker_id: payload.ActionTrackerId,
        attempt,
        status: response.status,
        order_id: payload.OrderId,
        response_body: responseBody,
      });

      if (!shouldRetry) return;
    } catch (error) {
      const shouldRetry = attempt < 3;
      const log = shouldRetry ? logWarning : logError;
      log('Impact conversion request threw', {
        event_name: eventName,
        action_tracker_id: payload.ActionTrackerId,
        attempt,
        order_id: payload.OrderId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!shouldRetry) return;
    }

    await sleep(250 * attempt);
  }
}

export async function trackVisit(params: { clickId: string; eventDate: Date }): Promise<void> {
  await sendImpactConversion(buildVisitPayload(params), 'visit');
}

export async function trackSignUp(params: {
  clickId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): Promise<void> {
  await sendImpactConversion(buildSignUpPayload(params), 'signup');
}

export async function trackTrialStart(params: {
  clickId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): Promise<void> {
  await sendImpactConversion(buildTrialStartPayload(params), 'trial_start');
}

export async function trackTrialEnd(params: {
  clickId?: string | null;
  customerId: string;
  customerEmail: string;
  eventDate: Date;
}): Promise<void> {
  await sendImpactConversion(buildTrialEndPayload(params), 'trial_end');
}

export async function trackSale(params: ImpactSaleFields & { eventDate: Date }): Promise<void> {
  await sendImpactConversion(buildSalePayload(params), 'sale');
}

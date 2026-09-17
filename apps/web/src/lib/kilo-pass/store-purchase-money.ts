import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

export type StorePurchaseMoney = {
  amountChargedMinorUnits: number | null;
  currency: string | null;
  taxMinorUnits: number | null;
};

const ISO_4217_CURRENCY_CODE = /^[A-Z]{3}$/;
const DEFAULT_CURRENCY_EXPONENT = 2;

/**
 * Google Play states every amount as `Money { currencyCode, units, nanos }`,
 * where `units` is a decimal string and `nanos` a number of 10^-9 units. Our
 * records store the amount in the currency's smallest unit, so we need the
 * currency's exponent (2 for USD, 0 for JPY, 3 for KWD, ...).
 */
function currencyExponent(currencyCode: string): number | null {
  if (!ISO_4217_CURRENCY_CODE.test(currencyCode)) return null;
  try {
    return (
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode,
      }).resolvedOptions().maximumFractionDigits ?? DEFAULT_CURRENCY_EXPONENT
    );
  } catch {
    // An unrecognized-but-well-formed code is still chargeable; treat it like
    // the common two-decimal currency rather than failing the purchase.
    return DEFAULT_CURRENCY_EXPONENT;
  }
}

/**
 * Converts a Play `Money` into the smallest unit of its currency. Returns null
 * for anything unusable — a purchase must never fail because of the new fields.
 */
export function googlePlayMoneyToMinorUnits(
  money: androidpublisher_v3.Schema$Money | null | undefined
): number | null {
  if (!money) return null;
  const currencyCode = money.currencyCode;
  if (!currencyCode) return null;
  const exponent = currencyExponent(currencyCode);
  if (exponent === null) return null;

  const units = money.units == null ? 0 : Number(money.units);
  const nanos = money.nanos == null ? 0 : Number(money.nanos);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;

  const minorUnits = Math.round(units * 10 ** exponent + nanos / 10 ** (9 - exponent));
  return Number.isFinite(minorUnits) ? minorUnits : null;
}

function currencyCodeOf(money: androidpublisher_v3.Schema$Money | null | undefined): string | null {
  const currencyCode = money?.currencyCode;
  if (!currencyCode || !ISO_4217_CURRENCY_CODE.test(currencyCode)) return null;
  return currencyCode;
}

function noMoney(): StorePurchaseMoney {
  return {
    amountChargedMinorUnits: null,
    currency: null,
    taxMinorUnits: null,
  };
}

function moneyPair(
  total: androidpublisher_v3.Schema$Money | null | undefined,
  tax: androidpublisher_v3.Schema$Money | null | undefined
): StorePurchaseMoney {
  const amountChargedMinorUnits = googlePlayMoneyToMinorUnits(total);
  const taxMinorUnits = googlePlayMoneyToMinorUnits(tax);
  if (amountChargedMinorUnits === null && taxMinorUnits === null) return noMoney();
  // The amount decides the currency; a tax-only charge falls back to its own.
  return {
    amountChargedMinorUnits,
    currency: currencyCodeOf(amountChargedMinorUnits === null ? tax : total),
    taxMinorUnits,
  };
}

/**
 * Picks the money of the paid line item out of a Play order. Falls back to the
 * order's only line item, then to the order-level totals when that item carries
 * no money at all. Unusable money (missing or malformed) yields all nulls.
 */
export function googlePlayOrderMoneyForProduct(
  order: androidpublisher_v3.Schema$Order,
  productId: string
): StorePurchaseMoney {
  const items = order?.lineItems ?? [];
  const matchedItem = items.find(item => item.productId === productId);
  const item = matchedItem ?? (items.length === 1 ? items[0] : undefined);

  const itemMoney = moneyPair(item?.total, item?.tax);
  if (itemMoney.amountChargedMinorUnits !== null || itemMoney.taxMinorUnits !== null) {
    return itemMoney;
  }
  if (item && (item.total != null || item.tax != null)) {
    // The item carried money we could not interpret; the order totals would
    // attribute other items' money to this product, so stay empty instead.
    return noMoney();
  }
  if (!item) return noMoney();
  return moneyPair(order.total, order.tax);
}

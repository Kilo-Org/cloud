import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

export type StorePurchaseMoney = {
  amountChargedMinorUnits: number | null;
  currency: string | null;
  taxMinorUnits: number | null;
};

const ISO_4217_CURRENCY_CODE = /^[A-Z]{3}$/;
const DEFAULT_CURRENCY_EXPONENT = 2;

/**
 * The largest value the `integer` (int4) columns `amount_charged_minor_units`
 * and `tax_minor_units` accept. A converted amount above it would be rejected by
 * PostgreSQL and fail the whole insert, so it counts as unusable money and maps
 * to null like any other value we cannot record.
 */
export const MAX_STORABLE_MINOR_UNITS = 2_147_483_647;

/**
 * The ISO 4217 minor unit of every currency whose exponent is not the usual
 * two (ISO 4217 "list one": no decimals, three decimals, four decimals).
 * `Intl.NumberFormat` cannot supply this: its ICU/CLDR data is display data, and
 * reports no decimals for currencies whose minor unit is unused in cash (HUF,
 * IDR, ...) while reporting two for codes ISO leaves without one, so deriving
 * the exponent from it would mis-scale the stored amount.
 */
const NON_DEFAULT_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/**
 * Google Play states every amount as `Money { currencyCode, units, nanos }`,
 * where `units` is a decimal string and `nanos` a number of 10^-9 units. Our
 * records store the amount in the currency's ISO 4217 smallest unit, so we need
 * the currency's exponent (2 for USD, 0 for JPY, 3 for KWD, ...).
 *
 * An unrecognized-but-well-formed code is still chargeable; treat it like the
 * common two-decimal currency rather than failing the purchase. A malformed code
 * is not a currency at all, so it yields null.
 */
function currencyExponent(currencyCode: string): number | null {
  if (!ISO_4217_CURRENCY_CODE.test(currencyCode)) return null;
  return NON_DEFAULT_CURRENCY_EXPONENTS[currencyCode] ?? DEFAULT_CURRENCY_EXPONENT;
}

/**
 * Converts a Play `Money` into the ISO 4217 smallest unit of its currency.
 * Returns null for anything unusable — a purchase must never fail because of
 * the new fields.
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
  // A negative amount cannot be stored — the column's check constraint rejects
  // it — and a value above the `integer` maximum (or one that has already lost
  // precision beyond `Number.MAX_SAFE_INTEGER`) would be rejected or corrupted
  // by the column. Either way the whole insert would fail, so treat it as
  // unusable, like any other money we cannot record.
  if (
    !Number.isSafeInteger(minorUnits) ||
    minorUnits < 0 ||
    minorUnits > MAX_STORABLE_MINOR_UNITS
  ) {
    return null;
  }
  return minorUnits;
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
 * order's only line item, then — only when that is the order's single line item
 * — to the order-level totals. Unusable money (missing or malformed) yields all
 * nulls.
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
  // Only a single-line order's totals are this product's money: with several
  // line items they would attribute the whole order to this one product.
  if (items.length !== 1) return noMoney();
  return moneyPair(order.total, order.tax);
}

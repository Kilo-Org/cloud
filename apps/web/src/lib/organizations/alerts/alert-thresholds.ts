import * as z from 'zod';

const MICRODOLLARS_PER_DOLLAR = 1_000_000;

/**
 * All monetary amounts are USD, and the product contract for a threshold is
 * whole cents. Enforcing that at the persistence boundary rather than only in
 * the editor keeps every stored threshold expressible as an amount a customer
 * can type and read back, so the API cannot accept a threshold the editor is
 * unable to represent.
 */
const MICRODOLLARS_PER_CENT = MICRODOLLARS_PER_DOLLAR / 100;

/**
 * Product ceiling for a threshold. It is deliberately far below
 * `Number.MAX_SAFE_INTEGER` microdollars (about $9.0 billion) so every later
 * microdollar sum and comparison stays exact.
 */
const MAX_ALERT_THRESHOLD_USD = 1_000_000_000;
export const MAX_ALERT_THRESHOLD_MICRODOLLARS = MAX_ALERT_THRESHOLD_USD * MICRODOLLARS_PER_DOLLAR;

/** A threshold as persisted and compared: positive whole-cent microdollars. */
export const AlertThresholdMicrodollarsSchema = z
  .number()
  .int()
  .positive({ message: 'Enter an amount greater than $0' })
  // The ceiling is checked before whole cents so an absurdly large amount is
  // reported as being over the maximum rather than as an imprecise cent value.
  .max(MAX_ALERT_THRESHOLD_MICRODOLLARS, {
    message: `Enter an amount of at most $${MAX_ALERT_THRESHOLD_USD.toLocaleString('en-US')}`,
  })
  .multipleOf(MICRODOLLARS_PER_CENT, { message: 'Enter a dollar amount in whole cents' });

/**
 * A threshold as a customer types it: plain dollars and cents, optionally with a
 * leading `$` and grouping separators because the field reads as currency.
 */
const THRESHOLD_USD_INPUT_PATTERN = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses the editor's USD text into whole-cent microdollars. Cents are combined
 * with integer arithmetic so an amount like `0.07` cannot drift through binary
 * floating point, and the result is piped through the persisted threshold schema
 * so the editor and the API accept exactly the same amounts.
 */
export const AlertThresholdUsdInputSchema = z
  .string()
  .trim()
  .transform(value => value.replace(/^\$\s*/, ''))
  .refine(value => THRESHOLD_USD_INPUT_PATTERN.test(value), {
    message: 'Enter a dollar amount with up to two decimal places, for example 500.00',
  })
  .transform(value => {
    const [, dollars = '', cents = ''] = THRESHOLD_USD_INPUT_PATTERN.exec(value) ?? [];
    return (
      (Number(dollars.replaceAll(',', '')) * 100 + Number(cents.padEnd(2, '0'))) *
      MICRODOLLARS_PER_CENT
    );
  })
  .pipe(AlertThresholdMicrodollarsSchema);

/**
 * Renders a stored threshold as the exact two-decimal text the input accepts.
 * Grouping separators are deliberately omitted so the value round-trips through
 * `AlertThresholdUsdInputSchema` unchanged.
 */
export function formatAlertThresholdUsdInput(microdollars: number): string {
  const cents = Math.round(microdollars / MICRODOLLARS_PER_CENT);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Renders a microdollar amount as display currency for alert copy, in the list,
 * the editor, and the email alike. The locale is fixed so a server-rendered
 * email and the UI cannot disagree about grouping or decimals.
 */
export function formatAlertUsd(microdollars: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(microdollars / MICRODOLLARS_PER_DOLLAR);
}

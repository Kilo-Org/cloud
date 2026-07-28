import * as z from 'zod';

export const CLOUD_BILLING_SKU_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
export const CLOUD_BILLING_SKU_RATE_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/;

export const cloudBillingSkuRateSchema = z
  .string()
  .regex(
    CLOUD_BILLING_SKU_RATE_PATTERN,
    'Rate must be a positive decimal with at most 12 decimal places'
  )
  .refine(value => !/^0(?:\.0+)?$/.test(value), 'Rate must be greater than zero');

export const createCloudBillingSkuInputSchema = z.object({
  id: z
    .string()
    .regex(CLOUD_BILLING_SKU_ID_PATTERN, 'ID must be 3-80 lowercase letters, numbers, or hyphens'),
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().min(1, 'Description cannot be empty').max(1000).nullable(),
  unit: z.literal('second'),
  rate_cents_per_unit: cloudBillingSkuRateSchema,
});

export type CreateCloudBillingSkuInput = z.infer<typeof createCloudBillingSkuInputSchema>;
export const cloudBillingSkuIdSchema = createCloudBillingSkuInputSchema.shape.id;

export function normalizeCloudBillingSkuRate(value: string): string {
  const [integer, fraction = ''] = value.split('.');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
}

export function multiplyCloudBillingRate(rate: string, quantity: number): string {
  const parsed = cloudBillingSkuRateSchema.parse(rate);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1_000_000_000) {
    throw new Error('Quantity must be an integer between zero and one billion');
  }
  const [integer, fraction = ''] = parsed.split('.');
  const digits = `${integer}${fraction.padEnd(12, '0')}`.split('').map(Number);
  let carry = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const product = digits[index] * quantity + carry;
    digits[index] = product % 10;
    carry = Math.floor(product / 10);
  }
  while (carry > 0) {
    digits.unshift(carry % 10);
    carry = Math.floor(carry / 10);
  }
  const padded = digits.join('').padStart(13, '0');
  const whole = padded.slice(0, -12).replace(/^0+(?=\d)/, '');
  const remainder = padded.slice(-12).replace(/0+$/, '');
  return remainder ? `${whole}.${remainder}` : whole;
}

import { US_STOREFRONT_COUNTRY } from '@/lib/billing/storefront-country';

/**
 * Whether a surface may draw an in-app link to a web page that sells or manages
 * a purchase.
 *
 * One combination may: an iOS build whose App Store storefront is the United
 * States, where guideline 3.1.1(a) permits the link. Every other combination —
 * another storefront, a storefront the store did not answer for, and Android,
 * which is not enrolled in any external-content-links programme — shows the
 * destination as plain text with no control to press.
 *
 * The rule is pure so it can be read without a device or a store; the hook that
 * pairs it with the storefront read lives in `external-purchase-link`.
 */
export function canLinkExternalPurchase(
  platformOS: string,
  storefrontCountry: string | null
): boolean {
  return platformOS === 'ios' && storefrontCountry === US_STOREFRONT_COUNTRY;
}

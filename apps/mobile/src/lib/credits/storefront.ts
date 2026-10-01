import { Platform } from 'react-native';

/** The store a device buys credit packs from. */
type CreditStorefront = 'app_store' | 'play';

/**
 * The storefront this device buys from — the credit-pack flow's one platform
 * fork, kept in one place.
 *
 * It is a capability, not a preference: iOS ships StoreKit and has no Google
 * Play Billing, Android ships Play Billing and has no App Store, and the
 * backend validates a purchase against the store that made it. So the
 * storefront must name the store the platform actually has. Every other part of
 * the flow — the catalog, the four pack rows, the purchase sheet, the grant,
 * recovery, refunds and error copy — is one implementation for both platforms.
 */
export function getCreditStorefront(): CreditStorefront {
  return Platform.OS === 'ios' ? 'app_store' : 'play';
}

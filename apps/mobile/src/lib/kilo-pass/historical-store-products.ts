import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type RecoveryProduct = Pick<
  RouterOutputs['kiloPass']['getMobileStoreProducts']['products'][number],
  'appleProductId' | 'googleProductId'
>;

// Recognition is permanent until paid-transaction reconciliation is complete.
// These IDs must not disappear when the stores stop advertising subscriptions.
const LEGACY_APPLE_PRODUCT_IDS = [
  'kilopass.tier19.monthly.v1',
  'kilopass.tier49.monthly.v1',
  'kilopass.tier199.monthly.v1',
];
const LEGACY_GOOGLE_PRODUCT_IDS = ['kilopass_tier19', 'kilopass_tier49', 'kilopass_tier199'];

export function getHistoricalKiloPassProductIds(products: readonly RecoveryProduct[]) {
  return {
    appleProductIds: [
      ...new Set([...LEGACY_APPLE_PRODUCT_IDS, ...products.map(p => p.appleProductId)]),
    ],
    googleProductIds: [
      ...new Set([...LEGACY_GOOGLE_PRODUCT_IDS, ...products.map(p => p.googleProductId)]),
    ],
  };
}

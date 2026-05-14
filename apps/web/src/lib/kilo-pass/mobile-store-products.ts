import { getMonthlyPriceUsd } from './bonus';
import { KiloPassCadence, KiloPassTier } from './enums';

export type MobileStoreKiloPassProduct = {
  tier: KiloPassTier;
  cadence: KiloPassCadence.Monthly;
  appleProductId: string;
  googleProductId: string;
  googleBasePlanId: string;
  webMonthlyPriceUsd: number;
  suggestedStoreMonthlyPriceUsd: number;
};

const PRODUCT_IDS = {
  [KiloPassTier.Tier19]: {
    appleProductId: 'kilopass.tier19.monthly.v1',
    googleProductId: 'kilopass_tier19',
    googleBasePlanId: 'monthly-v1',
  },
  [KiloPassTier.Tier49]: {
    appleProductId: 'kilopass.tier49.monthly.v1',
    googleProductId: 'kilopass_tier49',
    googleBasePlanId: 'monthly-v1',
  },
  [KiloPassTier.Tier199]: {
    appleProductId: 'kilopass.tier199.monthly.v1',
    googleProductId: 'kilopass_tier199',
    googleBasePlanId: 'monthly-v1',
  },
} satisfies Record<
  KiloPassTier,
  {
    appleProductId: string;
    googleProductId: string;
    googleBasePlanId: string;
  }
>;

const STORE_PRODUCT_ORDER = [
  KiloPassTier.Tier199,
  KiloPassTier.Tier49,
  KiloPassTier.Tier19,
] satisfies KiloPassTier[];

function roundStoreMonthlyPrice(webMonthlyPriceUsd: number): number {
  const gross = webMonthlyPriceUsd * 1.3;
  return Math.round(gross * 100) / 100;
}

export function getMobileStoreKiloPassProduct(params: {
  tier: KiloPassTier;
}): MobileStoreKiloPassProduct {
  const webMonthlyPriceUsd = getMonthlyPriceUsd(params.tier);
  const ids = PRODUCT_IDS[params.tier];

  return {
    tier: params.tier,
    cadence: KiloPassCadence.Monthly,
    ...ids,
    webMonthlyPriceUsd,
    suggestedStoreMonthlyPriceUsd: roundStoreMonthlyPrice(webMonthlyPriceUsd),
  };
}

export function getAllMobileStoreKiloPassProducts(): MobileStoreKiloPassProduct[] {
  return STORE_PRODUCT_ORDER.map(tier => getMobileStoreKiloPassProduct({ tier }));
}

export function getMobileStoreKiloPassProductByAppleProductId(
  appleProductId: string
): MobileStoreKiloPassProduct | null {
  return (
    getAllMobileStoreKiloPassProducts().find(
      product => product.appleProductId === appleProductId
    ) ?? null
  );
}

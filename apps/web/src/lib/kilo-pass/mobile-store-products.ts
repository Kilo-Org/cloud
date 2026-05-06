import { getMonthlyPriceUsd } from './bonus';
import { KiloPassCadence, KiloPassTier } from './enums';

export type MobileStoreKiloPassProduct = {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  appleProductId: string;
  googleProductId: string;
  googleBasePlanId: string;
  webMonthlyPriceUsd: number;
  suggestedStoreMonthlyPriceUsd: number;
};

const PRODUCT_IDS = {
  [KiloPassTier.Tier19]: {
    [KiloPassCadence.Monthly]: {
      appleProductId: 'kilopass.tier19.monthly.v1',
      googleProductId: 'kilopass_tier19',
      googleBasePlanId: 'monthly-v1',
    },
    [KiloPassCadence.Yearly]: {
      appleProductId: 'kilopass.tier19.yearly.v1',
      googleProductId: 'kilopass_tier19',
      googleBasePlanId: 'yearly-v1',
    },
  },
  [KiloPassTier.Tier49]: {
    [KiloPassCadence.Monthly]: {
      appleProductId: 'kilopass.tier49.monthly.v1',
      googleProductId: 'kilopass_tier49',
      googleBasePlanId: 'monthly-v1',
    },
    [KiloPassCadence.Yearly]: {
      appleProductId: 'kilopass.tier49.yearly.v1',
      googleProductId: 'kilopass_tier49',
      googleBasePlanId: 'yearly-v1',
    },
  },
  [KiloPassTier.Tier199]: {
    [KiloPassCadence.Monthly]: {
      appleProductId: 'kilopass.tier199.monthly.v1',
      googleProductId: 'kilopass_tier199',
      googleBasePlanId: 'monthly-v1',
    },
    [KiloPassCadence.Yearly]: {
      appleProductId: 'kilopass.tier199.yearly.v1',
      googleProductId: 'kilopass_tier199',
      googleBasePlanId: 'yearly-v1',
    },
  },
} satisfies Record<
  KiloPassTier,
  Record<
    KiloPassCadence,
    {
      appleProductId: string;
      googleProductId: string;
      googleBasePlanId: string;
    }
  >
>;

const STORE_PRODUCT_ORDER = [
  { tier: KiloPassTier.Tier199, cadence: KiloPassCadence.Yearly },
  { tier: KiloPassTier.Tier199, cadence: KiloPassCadence.Monthly },
  { tier: KiloPassTier.Tier49, cadence: KiloPassCadence.Yearly },
  { tier: KiloPassTier.Tier49, cadence: KiloPassCadence.Monthly },
  { tier: KiloPassTier.Tier19, cadence: KiloPassCadence.Yearly },
  { tier: KiloPassTier.Tier19, cadence: KiloPassCadence.Monthly },
] satisfies { tier: KiloPassTier; cadence: KiloPassCadence }[];

function roundStoreMonthlyPrice(webMonthlyPriceUsd: number): number {
  const gross = webMonthlyPriceUsd * 1.3;
  return Math.round(gross * 100) / 100;
}

export function getMobileStoreKiloPassProduct(params: {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
}): MobileStoreKiloPassProduct {
  const webMonthlyPriceUsd = getMonthlyPriceUsd(params.tier);
  const ids = PRODUCT_IDS[params.tier][params.cadence];

  return {
    tier: params.tier,
    cadence: params.cadence,
    ...ids,
    webMonthlyPriceUsd,
    suggestedStoreMonthlyPriceUsd: roundStoreMonthlyPrice(webMonthlyPriceUsd),
  };
}

export function getAllMobileStoreKiloPassProducts(): MobileStoreKiloPassProduct[] {
  return STORE_PRODUCT_ORDER.map(product =>
    getMobileStoreKiloPassProduct({ tier: product.tier, cadence: product.cadence })
  );
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

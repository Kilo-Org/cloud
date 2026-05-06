export type AppleCreditProductTier = 'small' | 'medium' | 'large';

export type BackendAppleCreditProduct = {
  id: string;
  tier: AppleCreditProductTier;
  creditedCents: number;
  creditedMicrodollars: number;
};

export type AppleCreditDisplayProduct = BackendAppleCreditProduct & {
  localizedPrice: string;
  title: string;
};

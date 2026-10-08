export type ModelRow = {
  modelId: string;
  modelName: string;
  providerSlugs: string[];
  preferredIndex: number | undefined;
  sourceIndex: number;
  unavailableReason?: string;
};

export type PolicyPillVariant = 'trains' | 'retainsPrompts';

export type ProviderRow = {
  providerSlug: string;
  providerDisplayName: string;
  providerIconUrl: string | null;
  modelCount: number;
  trains: boolean;
  retainsPrompts: boolean;
  headquarters?: string;
  datacenters?: string[];
  unavailableReason?: string;
};

export type OfferingPricing = {
  promptPrice: string;
  completionPrice: string;
  /** List price, set only when Kilo's custom pricing bills less than it. */
  originalPromptPrice?: string;
  originalCompletionPrice?: string;
};

export type ProviderOffering = OfferingPricing & {
  providerSlug: string;
  providerDisplayName: string;
  providerIconUrl: string | null;
  trains: boolean;
  retainsPrompts: boolean;
};

export type ProviderModelRow = OfferingPricing & {
  modelId: string;
  modelName: string;
  preferredIndex: number | undefined;
  sourceIndex: number;
  trains: boolean;
  retainsPrompts: boolean;
};

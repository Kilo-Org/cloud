export type ModelRow = {
  modelId: string;
  modelName: string;
  providerSlugs: string[];
  preferredIndex: number | undefined;
  sourceIndex: number;
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
};

export type ProviderOffering = {
  providerSlug: string;
  providerDisplayName: string;
  providerIconUrl: string | null;
  trains: boolean;
  retainsPrompts: boolean;
  promptPrice: string;
  completionPrice: string;
};

export type ProviderModelRow = {
  modelId: string;
  modelName: string;
  preferredIndex: number | undefined;
  sourceIndex: number;
  promptPrice: string;
  completionPrice: string;
};

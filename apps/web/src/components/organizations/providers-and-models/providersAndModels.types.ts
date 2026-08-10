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

export type ProviderOffering = {
  providerSlug: string;
  providerDisplayName: string;
  providerIconUrl: string | null;
  trains: boolean;
  retainsPrompts: boolean;
  promptPrice: string | null;
  completionPrice: string | null;
};

export type ProviderModelRow = {
  modelId: string;
  modelName: string;
  preferredIndex: number | undefined;
  sourceIndex: number;
  promptPrice: string | null;
  completionPrice: string | null;
  trains: boolean;
  retainsPrompts: boolean;
};

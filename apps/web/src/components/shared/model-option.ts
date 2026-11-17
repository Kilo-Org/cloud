export type ModelOption = {
  id: string; // e.g., "anthropic/claude-sonnet-4.5"
  name: string; // e.g., "Claude Sonnet 4.5"
  /** Exact user-facing ID when `id` is an opaque selection value. */
  displayId?: string;
  /** Optional provider group for provider-aware catalogs. */
  providerGroup?: { id: string; label: string };
  /** Additional user-facing search terms. Opaque selection values stay excluded. */
  searchTerms?: string[];
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
  showGatewayMetadata?: boolean;
  unavailable?: boolean;
  /** Ordered list of variant key names (e.g., ["none","low","medium","high","max"]) */
  variants?: string[];
  /** Reasoning-control variants only; [] is known default-only, absent is unknown. */
  reasoningVariants?: string[];
  /** CLI catalog identity on remote-session options; Gateway options have none. */
  modelRef?: { providerID: string; modelID: string };
  /** 'legacy-gateway' options keep Gateway favorite identity despite a modelRef. */
  overrideSource?: 'cli-catalog' | 'legacy-gateway';
};

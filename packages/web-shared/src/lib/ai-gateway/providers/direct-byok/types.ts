import type { DirectByokProviderMetaId } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import type {
  GatewayChatApiKind,
  ProviderApiUrlOverrides,
  ProviderResponseTransforms,
  TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { DirectByokModel, OpenRouterProvider } from '@kilocode/db/schema-types';

export {
  DirectByokModelFlagSchema,
  DirectByokModelSchema,
  DirectByokModelArraySchema,
  type DirectByokModelFlag,
  type DirectByokModel,
} from '@kilocode/db/schema-types';

/**
 * Entry for the `/api/v1/providers` list, named after `DIRECT_BYOK_PROVIDERS_META`.
 * Data policy flags describe the whole request path, including any upstream
 * providers the service routes to.
 */
export type DirectByokProviderListing = {
  dataPolicy: Required<OpenRouterProvider['dataPolicy']>;
  icon: NonNullable<OpenRouterProvider['icon']>;
};

export type DirectByokProvider = {
  id: DirectByokProviderMetaId;
  base_url: string;
  base_url_overrides: ProviderApiUrlOverrides;
  models: () => Promise<ReadonlyArray<DirectByokModel>>;
  supported_chat_apis: ReadonlyArray<GatewayChatApiKind>;
  reasoning_details_transform: ProviderResponseTransforms | null;
  transformRequest(context: TransformRequestContext): void;
  /** Omitted when the general provider list already has a corresponding provider. */
  provider_listing?: DirectByokProviderListing;
};

export function faviconIcon(siteUrl: string): DirectByokProviderListing['icon'] {
  return {
    url: `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${siteUrl}&size=256`,
  };
}

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';

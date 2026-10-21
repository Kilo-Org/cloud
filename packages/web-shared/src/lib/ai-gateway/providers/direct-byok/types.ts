import type { DirectByokProviderMetaId } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import type {
  GatewayChatApiKind,
  Provider,
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

/** Upstream routing and authentication derived from a stored credential. */
export type DirectByokUpstream = Pick<
  Provider,
  | 'apiUrl'
  | 'apiUrlOverrides'
  | 'disableUrlSuffix'
  | 'apiKey'
  | 'apiKeyHeader'
  | 'awsBedrock'
  | 'supportedChatApis'
  | 'responseTransforms'
>;

export type DirectByokResolveUpstreamInput = {
  /** The decrypted credential stored for the provider. */
  credential: string;
  model: Pick<DirectByokModel, 'id' | 'endpoint'>;
  stream: boolean;
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
  /**
   * Builds the upstream from the stored credential, for providers whose URL or
   * authentication depends on it, such as cloud regions or signed requests.
   * Throws when the credential is unusable. When set, it replaces `base_url`,
   * `base_url_overrides`, `supported_chat_apis` and `reasoning_details_transform`
   * for requests.
   */
  resolveUpstream?(input: DirectByokResolveUpstreamInput): Promise<DirectByokUpstream>;
  /** The chat API a model must be called with, for providers where it varies per model. */
  getModelChatApi?(model: DirectByokModel): GatewayChatApiKind;
};

export function faviconIcon(siteUrl: string): DirectByokProviderListing['icon'] {
  return {
    url: `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${siteUrl}&size=256`,
  };
}

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';

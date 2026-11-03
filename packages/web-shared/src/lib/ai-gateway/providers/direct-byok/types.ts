import type { DirectByokProviderMetaId } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import type {
  GatewayChatApiKind,
  Provider,
  ProviderApiUrlOverrides,
  ProviderResponseTransforms,
  TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { DirectByokModel, OpenRouterProvider } from '@kilocode/db/schema-types';
import type { OpenRouterInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';

export {
  DirectByokModelFlagSchema,
  DirectByokModelSchema,
  DirectByokModelArraySchema,
  type DirectByokModelFlag,
  type DirectByokModel,
} from '@kilocode/db/schema-types';

/**
 * Entry for the `/api/v1/providers` list and the provider policy screens, named after
 * `DIRECT_BYOK_PROVIDERS_META`. Data policy flags describe the whole request path, including any
 * upstream providers the service routes to.
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

type DirectByokProviderBase = {
  id: DirectByokProviderMetaId;
  /** models.dev provider key; omitted for providers models.dev does not list. */
  models_dev_id?: string;
  models: () => Promise<ReadonlyArray<DirectByokModel>>;
  transformRequest(context: TransformRequestContext): void;
  /**
   * Builds the upstream for a request from the stored credential. Most providers
   * use `apiKeyUpstream`; cloud providers can derive regions or signed requests.
   * The upstream's `supportedChatApis` must match `getDirectByokModelChatApis`.
   */
  resolveUpstream(input: DirectByokResolveUpstreamInput): Promise<DirectByokUpstream>;
};

/**
 * The provider that organization provider allow-lists name for this service. A provider the
 * general provider list already has names it; any other provider gets its own listing under its
 * id, so allow-lists can name every direct BYOK provider.
 */
type DirectByokProviderPolicyName =
  | {
      /** The general provider list entry for the same service. */
      openrouter_inference_provider_id: OpenRouterInferenceProviderId;
      provider_listing?: undefined;
    }
  | {
      openrouter_inference_provider_id?: undefined;
      provider_listing: DirectByokProviderListing;
    };

/**
 * The chat APIs are known without the credential, so routing can choose between keys, and the
 * BYOK routing preview can explain the choice, without decrypting any key.
 */
export type DirectByokProvider = DirectByokProviderBase &
  DirectByokProviderPolicyName &
  (
    | {
        /** The chat APIs the upstream serves every model over. */
        supportedChatApis: ReadonlyArray<GatewayChatApiKind>;
        getModelChatApi?: undefined;
      }
    | {
        supportedChatApis?: undefined;
        /** The chat API a model must be called with, for providers where it varies per model. */
        getModelChatApi(model: DirectByokModel): GatewayChatApiKind;
      }
  );

/**
 * The upstream of a provider that takes the stored credential as a bearer API key, with the chat
 * APIs it serves. Spread the result into the provider.
 */
export function apiKeyUpstream(upstream: {
  apiUrl: string;
  apiUrlOverrides?: ProviderApiUrlOverrides;
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>;
  responseTransforms: ProviderResponseTransforms | null;
}): Pick<DirectByokProvider, 'resolveUpstream'> & {
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>;
} {
  return {
    supportedChatApis: upstream.supportedChatApis,
    async resolveUpstream({ credential }) {
      return {
        apiUrl: upstream.apiUrl,
        apiUrlOverrides: upstream.apiUrlOverrides ?? {},
        disableUrlSuffix: false,
        apiKey: credential,
        apiKeyHeader: null,
        supportedChatApis: upstream.supportedChatApis,
        responseTransforms: upstream.responseTransforms,
      };
    },
  };
}

export function faviconIcon(siteUrl: string): DirectByokProviderListing['icon'] {
  return {
    url: `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${siteUrl}&size=256`,
  };
}

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';

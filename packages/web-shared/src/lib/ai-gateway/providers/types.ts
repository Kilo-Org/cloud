import * as z from 'zod';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { FraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { OpenAiChatGptOwner } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import type { ClaudeBillingOwner } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import {
  ReasoningDetailsTransform,
  type CustomLlmAwsBedrockCredentials,
  type ReasoningDetailsTransform as ReasoningDetailsTransformType,
} from '@kilocode/db/schema-types';

export { ReasoningDetailsTransform };

export const ProviderTypeSchema = z.enum([
  'openrouter',
  'direct-byok',
  'inception',
  'mistral',
  'vercel',
  'openai-chatgpt',
  'claude-billing',
  'custom',
  'custom-public',
  'dev-tools',
]);

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export type BYOKResult = {
  decryptedAPIKey: string;
  providerId: UserByokProviderId;
  /** Set when the owner reordered their keys; see `BYOK_KEY_ORDER`. */
  priority?: number;
};

export type TransformRequestContext = {
  provider: Provider;
  model: string;
  request: GatewayRequest;
  originalHeaders: FraudDetectionHeaders;
  extraHeaders: Record<string, string>;
  userByok: BYOKResult[] | null;
  kilo_user_id: string;
  organization_id: string | null;
  session_id: string | null;
};

export type GatewayChatApiKind = GatewayRequest['kind'];

export const GatewayChatApiKindSchema = z.enum([
  'chat_completions',
  'responses',
  'messages',
]) satisfies z.ZodType<GatewayChatApiKind>;

export type ProviderApiUrlOverrides = Readonly<Partial<Record<GatewayChatApiKind, string>>>;

export type ProviderResponseTransforms = ReasoningDetailsTransformType;

export type SecureProxyRoute = {
  /** Proxy endpoint URL, used as-is. */
  url: string;
  /** Upstream authentication headers, applied by the proxy instead of the API key. */
  upstreamAuthHeaders: Record<string, string>;
};

export type Provider = {
  type: ProviderType;
  inferenceProviderId?: string;
  /**
   * The ChatGPT connection that serves this provider. Set only on the delegated
   * "Sign in with ChatGPT" route, and it names the exact connection that paid
   * for the request.
   */
  chatGptOwner?: OpenAiChatGptOwner;
  /**
   * The Claude billing connection that serves this provider. Set only on the
   * Claude billing route; it names whose Claude organization pays.
   */
  claudeBillingOwner?: ClaudeBillingOwner;
  /** Anthropic's user profile for `claudeBillingOwner`; every billed request names it. */
  claudeBillingUserProfileId?: string;
  claudeBillingConnectedAt?: string;
  apiUrl: string;
  apiUrlOverrides: ProviderApiUrlOverrides;
  disableUrlSuffix: boolean;
  apiKey: string;
  /** Uses bearer authorization unless the provider requires an x-api-key header. */
  apiKeyHeader: 'x-api-key' | null;
  /**
   * Sends the request through apps/ai-gateway-secure-proxy. `apiUrl` and
   * `disableUrlSuffix` then describe the upstream behind the proxy, and
   * `apiKey` is the proxy's shared secret.
   */
  secureProxy?: SecureProxyRoute;
  /** Signs each request with AWS SigV4 for Amazon Bedrock; `apiKey` is then unused. */
  awsBedrock?: CustomLlmAwsBedrockCredentials;
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>;
  responseTransforms: ProviderResponseTransforms | null;
  transformRequest(context: TransformRequestContext): Promise<void>;
};

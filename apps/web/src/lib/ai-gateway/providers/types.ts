import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { FraudDetectionHeaders } from '@/lib/utils';
import type { OpenAiChatGptOwner } from '@/lib/ai-gateway/openai-chatgpt/store';
import {
  ReasoningDetailsTransform,
  type ReasoningDetailsTransform as ReasoningDetailsTransformType,
} from '@kilocode/db';

export { ReasoningDetailsTransform };

export type ProviderId =
  | 'openrouter'
  | 'direct-byok'
  | 'inception'
  | 'martian'
  | 'mistral'
  | 'vercel'
  | 'openai-chatgpt'
  | 'custom'
  | 'dev-tools';

export type BYOKResult = {
  decryptedAPIKey: string;
  providerId: UserByokProviderId;
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

export type ProviderApiUrlOverrides = Readonly<Partial<Record<GatewayChatApiKind, string>>>;

export type ProviderResponseTransforms = ReasoningDetailsTransformType;

export type Provider = {
  id: ProviderId;
  /**
   * The ChatGPT connection that serves this provider. Set only on the delegated
   * "Sign in with ChatGPT" route, and it names the exact connection that paid
   * for the request.
   */
  chatGptOwner?: OpenAiChatGptOwner;
  apiUrl: string;
  apiUrlOverrides: ProviderApiUrlOverrides;
  disableUrlSuffix: boolean;
  apiKey: string;
  /** Uses bearer authorization unless the provider requires an x-api-key header. */
  apiKeyHeader: 'x-api-key' | null;
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>;
  responseTransforms: ProviderResponseTransforms | null;
  transformRequest(context: TransformRequestContext): Promise<void>;
};

import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { FraudDetectionHeaders } from '@/lib/utils';
import {
  ReasoningDetailsTransform,
  type ReasoningDetailsTransform as ReasoningDetailsTransformType,
} from '@kilocode/db';

export { ReasoningDetailsTransform };

export type ProviderId =
  | 'openrouter'
  | 'alibaba'
  | 'seed'
  | 'direct-byok'
  | 'inception'
  | 'longcat'
  | 'martian'
  | 'mistral'
  | 'friendli'
  | 'perplexity'
  | 'streamlake'
  | 'vercel'
  | 'custom'
  | 'experiment'
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
  apiUrl: string;
  apiUrlOverrides: ProviderApiUrlOverrides;
  apiKey: string;
  /** Uses bearer authorization unless the provider requires an x-api-key header. */
  apiKeyHeader: 'x-api-key' | null;
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>;
  responseTransforms: ProviderResponseTransforms | null;
  transformRequest(context: TransformRequestContext): Promise<void>;
};

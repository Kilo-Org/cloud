import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { FraudDetectionHeaders } from '@/lib/utils';

export type ProviderId =
  | 'openrouter'
  | 'alibaba'
  | 'seed'
  | 'direct-byok'
  | 'inception'
  | 'martian'
  | 'mistral'
  | 'morph'
  | 'vercel'
  | 'custom'
  | 'dev-tools';

export type BYOKResult = {
  decryptedAPIKey: string;
  providerId: UserByokProviderId;
};

export type TransformRequestContext = {
  model: string;
  request: GatewayRequest;
  originalHeaders: FraudDetectionHeaders;
  extraHeaders: Record<string, string>;
  userByok: BYOKResult[] | null;
};

export type GatewayChatApiKind = GatewayRequest['kind'];

export type Provider = {
  id: ProviderId;
  apiUrl: string;
  apiKey: string;
  supportedChatApis: ReadonlyArray<GatewayChatApiKind>;
  transformRequest(context: TransformRequestContext): void;
};

import type { DirectByokProviderMetaId } from '@/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import type {
  GatewayChatApiKind,
  ProviderApiUrlOverrides,
  TransformRequestContext,
} from '@/lib/ai-gateway/providers/types';
import type { CustomLlmProvider } from '@kilocode/db';
import type { DirectByokModel } from '@kilocode/db/schema-types';

export {
  DirectByokModelFlagSchema,
  DirectByokModelSchema,
  DirectByokModelArraySchema,
  type DirectByokModelFlag,
  type DirectByokModel,
} from '@kilocode/db/schema-types';

export type DirectByokProvider = {
  id: DirectByokProviderMetaId;
  base_url: string;
  base_url_overrides: ProviderApiUrlOverrides;
  models: () => Promise<ReadonlyArray<DirectByokModel>>;
  supported_chat_apis: ReadonlyArray<GatewayChatApiKind>;
  default_ai_sdk_provider: CustomLlmProvider;
  transformRequest(context: TransformRequestContext): void;
};

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';

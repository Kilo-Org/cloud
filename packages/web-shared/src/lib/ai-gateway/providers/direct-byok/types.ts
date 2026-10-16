import type { DirectByokProviderMetaId } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import type {
  GatewayChatApiKind,
  ProviderApiUrlOverrides,
  ProviderResponseTransforms,
  TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
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
  reasoning_details_transform: ProviderResponseTransforms | null;
  transformRequest(context: TransformRequestContext): void;
};

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';

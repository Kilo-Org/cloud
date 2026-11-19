import { isByokPrivateModelId } from '@kilocode/web-shared/lib/ai-gateway/byok-private-provider';
import { getDirectByokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';

/** Private provider and bespoke direct BYOK ids, which the key's owner pays for whatever their name. */
export async function isOwnerByokModelId(modelId: string): Promise<boolean> {
  return isByokPrivateModelId(modelId) || (await getDirectByokModel(modelId)).provider !== null;
}

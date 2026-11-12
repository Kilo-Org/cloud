import { EnkryptUsageWriteSchema, type EnkryptUsageQueueMessage } from '@kilocode/usage-contracts';
import type { Env } from './publish-usage';
import { handlePublishTaggedUsage, type TaggedUsageIngress } from './publish-tagged-usage';
import { flatRecordRejectionDetails } from './rejection-diagnostics';

/** An Enkrypt record is a few hundred bytes, so its envelope stays far below the queue limit. */
export const MAX_ENKRYPT_USAGE_BYTES = 8_192;

const enkryptFields: readonly string[] = Object.keys(EnkryptUsageWriteSchema.shape);

const enkryptIngress: TaggedUsageIngress<EnkryptUsageQueueMessage> = {
  kind: 'enkrypt_usage',
  maxBytes: MAX_ENKRYPT_USAGE_BYTES,
  toMessage(value) {
    const result = EnkryptUsageWriteSchema.safeParse(value);
    return result.success
      ? { message: { kind: 'enkrypt_usage', v: 1, record: result.data } }
      : { rejection: flatRecordRejectionDetails(result.error, enkryptFields) };
  },
};

/**
 * The gateway, the only Enkrypt producer, already holds the LLM publish secret, so accepting it
 * here adds no new secret holder.
 */
export function handlePublishEnkryptUsage(
  request: Request,
  env: Env,
  entryAtMs: number
): Promise<Response> {
  return handlePublishTaggedUsage(request, env, entryAtMs, enkryptIngress);
}

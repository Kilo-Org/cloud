import { EnkryptUsageWriteSchema, type EnkryptUsageQueueMessage } from '@kilocode/usage-contracts';
import type { Env } from './publish-usage';
import {
  handlePublishTaggedUsage,
  MAX_TAGGED_USAGE_BYTES,
  type TaggedUsageIngress,
} from './publish-tagged-usage';
import { enkryptSchemaRejectionDetails } from './rejection-diagnostics';

export const MAX_ENKRYPT_USAGE_BYTES = MAX_TAGGED_USAGE_BYTES;

/**
 * The gateway, the only Enkrypt producer, already holds the LLM publish secret, so accepting it
 * here adds no new secret holder.
 */
const ENKRYPT_USAGE_INGRESS: TaggedUsageIngress<EnkryptUsageQueueMessage> = {
  kind: 'enkrypt_usage',
  secret: env => env.USAGE_INGEST_PUBLISH_SECRET,
  parse: value => EnkryptUsageWriteSchema.safeParse(value),
  rejectionDetails: enkryptSchemaRejectionDetails,
};

export function handlePublishEnkryptUsage(
  request: Request,
  env: Env,
  entryAtMs: number
): Promise<Response> {
  return handlePublishTaggedUsage(request, env, entryAtMs, ENKRYPT_USAGE_INGRESS);
}

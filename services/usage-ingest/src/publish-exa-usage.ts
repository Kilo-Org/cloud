import { ExaUsageRecordSchema, type ExaUsageQueueMessage } from '@kilocode/usage-contracts';
import type { Env } from './publish-usage';
import {
  handlePublishTaggedUsage,
  MAX_TAGGED_USAGE_BYTES,
  type TaggedUsageIngress,
} from './publish-tagged-usage';
import { exaSchemaRejectionDetails } from './rejection-diagnostics';

export const MAX_EXA_USAGE_BYTES = MAX_TAGGED_USAGE_BYTES;

/**
 * The Exa route on `kilocode-app` is a different producer from the gateway, so it gets its own
 * publish secret instead of the LLM one.
 */
const EXA_USAGE_INGRESS: TaggedUsageIngress<ExaUsageQueueMessage> = {
  kind: 'exa_usage',
  secret: env => env.USAGE_INGEST_EXA_PUBLISH_SECRET,
  parse: value => ExaUsageRecordSchema.safeParse(value),
  rejectionDetails: exaSchemaRejectionDetails,
};

export function handlePublishExaUsage(
  request: Request,
  env: Env,
  entryAtMs: number
): Promise<Response> {
  return handlePublishTaggedUsage(request, env, entryAtMs, EXA_USAGE_INGRESS);
}

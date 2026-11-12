import { ExaUsageRecordSchema, type ExaUsageQueueMessage } from '@kilocode/usage-contracts';
import type { Env } from './publish-usage';
import { handlePublishTaggedUsage, type TaggedUsageIngress } from './publish-tagged-usage';
import { flatRecordRejectionDetails } from './rejection-diagnostics';

/** An Exa record is a few hundred bytes, so its envelope stays far below the queue limit. */
export const MAX_EXA_USAGE_BYTES = 8_192;

const exaFields: readonly string[] = Object.keys(ExaUsageRecordSchema.shape);

const exaIngress: TaggedUsageIngress<ExaUsageQueueMessage> = {
  kind: 'exa_usage',
  maxBytes: MAX_EXA_USAGE_BYTES,
  toMessage(value) {
    const result = ExaUsageRecordSchema.safeParse(value);
    return result.success
      ? { message: { kind: 'exa_usage', v: 1, record: result.data } }
      : { rejection: flatRecordRejectionDetails(result.error, exaFields) };
  },
};

/**
 * The web app, the only Exa producer, already holds `INTERNAL_API_SECRET`, which writes usage
 * directly to the writer routes, so also holding the LLM publish secret adds little.
 */
export function handlePublishExaUsage(
  request: Request,
  env: Env,
  entryAtMs: number
): Promise<Response> {
  return handlePublishTaggedUsage(request, env, entryAtMs, exaIngress);
}

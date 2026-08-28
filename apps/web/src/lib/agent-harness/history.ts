import { LegacyMessageSchema } from '@kilocode/agent-harness/contracts';
import {
  QuickChatAuthorityError,
  QuickChatAuthoritySchema,
  type QuickChatAuthority,
  type createQuickChatRuntime,
} from '@kilocode/db/quick-chat-runtime';
import { z } from 'zod';

export const DurableImportReceiptSchema = QuickChatAuthoritySchema.extend({
  messageId: z.uuid(),
  durable: z.literal(true),
}).strict();
export type DurableImportReceipt = z.infer<typeof DurableImportReceiptSchema>;
export type LegacyHistoryImport = {
  authority: QuickChatAuthority;
  message: z.output<typeof LegacyMessageSchema>;
};

// The importer must commit UUID deduplication and text together before returning this receipt.
// This boundary does not implement SQLite or turn historical text into runnable work.
export type LegacyHistoryImporter = (input: LegacyHistoryImport) => Promise<unknown>;
type HistorySource = Pick<ReturnType<typeof createQuickChatRuntime>, 'claimPending' | 'withClaim'>;
export type HistoryDelivery = { id: string; status: 'acknowledged' | 'retry' | 'rejected' };

/** Drain one bounded batch for a request (scoped authority) or cron (all registered conversations). */
export async function drainLegacyHistory(
  source: HistorySource,
  importer: LegacyHistoryImporter,
  options: Parameters<HistorySource['claimPending']>[0] = {}
): Promise<HistoryDelivery[]> {
  const deliveries: HistoryDelivery[] = [];
  for (const claim of await source.claimPending(options)) {
    try {
      const acknowledged = await source.withClaim(claim, async acknowledge => {
        const authority = QuickChatAuthoritySchema.parse(claim);
        // Old rows contain caller-authored text, including assistant text. Discard attached authority.
        // Keep this fallback until old append writers and historical records are gone.
        const message = LegacyMessageSchema.parse({
          id: claim.id,
          role: claim.role,
          content: claim.content,
          clientId: claim.clientId,
          createdAt: new Date(claim.createdAt).toISOString(),
        });
        const receipt = DurableImportReceiptSchema.parse(await importer({ authority, message }));
        if (
          receipt.messageId !== claim.id ||
          receipt.threadId !== claim.threadId ||
          receipt.userId !== claim.userId ||
          receipt.organizationId !== claim.organizationId ||
          receipt.generation !== claim.generation
        ) {
          throw new Error('Mismatched durable import receipt');
        }
        return acknowledge();
      });
      deliveries.push({ id: claim.id, status: acknowledged ? 'acknowledged' : 'retry' });
    } catch (error) {
      deliveries.push({
        id: claim.id,
        status: error instanceof QuickChatAuthorityError ? 'rejected' : 'retry',
      });
    }
  }
  return deliveries;
}

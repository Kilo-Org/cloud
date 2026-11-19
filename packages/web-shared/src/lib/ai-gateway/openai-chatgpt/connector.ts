import 'server-only';
import { readDb, type db } from '@kilocode/web-shared/lib/drizzle';
import { resolveConnectionConnector } from '@kilocode/web-shared/lib/ai-gateway/connector';
import type { OpenAiChatGptStoredConnection } from './store';

/**
 * Whether the person recorded as an organization's shared-services ChatGPT
 * connection is gone: the account row is missing, the account is soft-deleted
 * or being deleted, or it holds no usable email. The shared-services row is the
 * organization's connection, so a dead connector does not revoke it: the row
 * and its credential stay, and an organization owner reconnects it. A row that
 * records no connector keeps serving.
 */
export async function openAiChatGptConnectorGone(
  stored: Pick<OpenAiChatGptStoredConnection, 'createdBy'>,
  fromDb: typeof db = readDb
): Promise<boolean> {
  const createdBy = stored.createdBy.trim();
  if (!createdBy) return false;
  return (await resolveConnectionConnector(createdBy, fromDb)).kind === 'gone';
}

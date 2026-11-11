import 'server-only';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isClaudeOperatorConfigured } from './operator';
import { resolveClaudeBillingModel } from './routing';
import { getGrantedClaudeBillingConnection, type ClaudeBillingOwner } from './store';

/**
 * Returns `models` with the Claude models a linked Claude organization pays for
 * marked BYOK-available, so clients show the BYOK badge as they do for Sign in
 * with ChatGPT. The list is unchanged when the owner has no connected link.
 */
export async function tagClaudeBillingByokModels<
  T extends { id: string; hasUserByokAvailable?: boolean },
>(owner: ClaudeBillingOwner, models: T[]): Promise<T[]> {
  if (!isClaudeOperatorConfigured()) return models;
  const connection = await getGrantedClaudeBillingConnection(owner, readDb);
  if (connection?.status !== ClaudeBillingConnectionStatus.Connected) return models;

  return await Promise.all(
    models.map(async model =>
      model.hasUserByokAvailable === true || (await resolveClaudeBillingModel(model.id)) === null
        ? model
        : { ...model, hasUserByokAvailable: true }
    )
  );
}

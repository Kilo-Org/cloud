import 'server-only';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { markByokAvailable } from '@kilocode/web-shared/lib/ai-gateway/byok/available-model';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isClaudeOperatorConfigured } from './operator';
import { resolveClaudeBillingModel } from './routing';
import { getGrantedClaudeBillingConnection, type ClaudeBillingOwner } from './store';

/**
 * Returns `models` with the Claude models a linked Claude organization pays for
 * marked BYOK-available, so clients show the BYOK badge as they do for Sign in
 * with ChatGPT. A marked model comes back with `hasUserByokAvailable: true` and
 * `isFree: false`; one it does not mark is returned unchanged. The list is
 * unchanged when the owner has no connected link. The caller runs it after
 * `addUserByokAvailability`.
 */
export async function tagClaudeBillingByokModels<
  T extends { id: string; hasUserByokAvailable?: boolean; isFree?: boolean },
>(owner: ClaudeBillingOwner, models: T[]): Promise<T[]> {
  if (!isClaudeOperatorConfigured()) return models;
  // Deliberate: this runs on the hot models-list path and the badge is recomputed
  // on later page loads, so a lagging replica only delays the badge. payer-state.ts
  // reads the primary because a stale absent row there would switch payer.
  const connection = await getGrantedClaudeBillingConnection(owner, readDb);
  if (connection?.status !== ClaudeBillingConnectionStatus.Connected) return models;

  return await Promise.all(
    models.map(async model => {
      if (model.hasUserByokAvailable === true) return markByokAvailable(model);
      const served = (await resolveClaudeBillingModel(model.id)) !== null;
      return served ? markByokAvailable(model) : model;
    })
  );
}

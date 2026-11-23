import type { ChatPlace } from '../scope';
import { setBanner } from './sync-banners';
import { depsFor } from './sync-deps';
import { admitTurn } from './sync-pull';
import { chatSyncSourceId } from './sync-settings';
import { syncRecordOf } from './sync-store';
import { modelOfSession } from '../store';
import { pullOpenedChat } from './sync-service';

/**
 * Admitting one send (H6): pull, then run the turn here, relay it to a live
 * runner, or refuse with the reason the banner names.
 */

export type SendDecision =
  | { readonly kind: 'local' }
  | { readonly kind: 'relayed' }
  | { readonly kind: 'blocked'; readonly reason: 'busy' | 'diverged' | 'deleted' | 'unavailable' };

/** H6 before a turn: pull, then run locally, relay to a live runner, or block. */
export async function prepareSend(
  place: ChatPlace,
  sessionId: string,
  text: string
): Promise<SendDecision> {
  try {
    const { deps, client, db } = await depsFor(place);
    const record = syncRecordOf(db, sessionId);
    if (record === null || record.serverSessionId === null || record.phase === 'local') {
      return { kind: 'local' };
    }
    const live = await client.probeLive(record.serverSessionId);
    const admission = await admitTurn(deps, {
      sessionId,
      sourceId: await chatSyncSourceId(place.chatScope),
      modelId: modelOfSession(db, sessionId) ?? '',
      liveElsewhere: live,
    });
    switch (admission.kind) {
      case 'local-turn': {
        setBanner(sessionId, { kind: 'none' });
        return { kind: 'local' };
      }
      case 'live-elsewhere': {
        setBanner(sessionId, { kind: 'live' });
        const sent = await client.sendLiveMessage(record.serverSessionId, text);
        if (sent) {
          void pullOpenedChat(place, sessionId);
          return { kind: 'relayed' };
        }
        return { kind: 'blocked', reason: 'unavailable' };
      }
      case 'busy': {
        setBanner(sessionId, { kind: 'busy' });
        return { kind: 'blocked', reason: 'busy' };
      }
      case 'diverged': {
        setBanner(sessionId, { kind: 'diverged' });
        return { kind: 'blocked', reason: 'diverged' };
      }
      case 'deleted': {
        return { kind: 'blocked', reason: 'deleted' };
      }
      case 'unavailable': {
        return { kind: 'blocked', reason: 'unavailable' };
      }
    }
  } catch {
    return { kind: 'blocked', reason: 'unavailable' };
  }
}


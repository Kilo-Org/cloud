import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

/** Internal creation titles are placeholders, not user-facing chat names. */
export function getChatDisplayTitle(title: string | null | undefined): string {
  return title?.trim() && !isDefaultSessionTitle(title) ? title : 'New chat';
}

import { classifyKiloChatError } from '@kilocode/kilo-chat';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

// Copy is chosen from the stable classifier kind. Web still reads the shared
// English strings in packages/kilo-chat, so mobile maps each kind to a catalog
// key and translates at toast time. The map holds keys, never English.
const ERROR_KEY_BY_KIND = {
  'not-allowed': 'chat.errors.notAllowed',
  'message-too-long': 'chat.errors.messageTooLong',
  'title-too-long': 'chat.errors.titleTooLong',
  'message-empty': 'chat.errors.messageEmpty',
} satisfies Record<string, string>;

export function formatMobileKiloChatError(err: unknown, fallback: string): string {
  const kind = classifyKiloChatError(err);
  if (kind.kind === 'not-allowed' || kind.kind === 'message-empty') {
    return i18n.t(ERROR_KEY_BY_KIND[kind.kind]);
  }
  if (kind.kind === 'message-too-long' || kind.kind === 'title-too-long') {
    return i18n.t(ERROR_KEY_BY_KIND[kind.kind], {
      limit: formatNumber(kind.limit, i18n.language),
    });
  }
  if (kind.kind === 'server') {
    // The server phrased this one; showing the caller's fallback instead would
    // drop what actually went wrong.
    return kind.message;
  }
  return fallback;
}

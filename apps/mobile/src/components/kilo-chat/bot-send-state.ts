import { i18n } from '@/i18n';

type BotPresence = {
  online: boolean;
  lastAt: number;
};

type BotDisplayState = 'online' | 'idle' | 'offline' | 'unknown';

type BotDisplay = {
  state: BotDisplayState;
  label: string;
};

type MessageInputAvailability = {
  botDisplay: BotDisplay;
  disabled: boolean;
  disabledReason: string | null;
  showInstanceCta: boolean;
  submitDisabled: boolean;
};

function computeMobileBotDisplay(params: {
  instanceStatus: string | null;
  presence: BotPresence | undefined;
  now: number;
}): BotDisplay {
  if (params.instanceStatus !== null && params.instanceStatus !== 'running') {
    return { state: 'offline', label: i18n.t('chat.botStatus.offline') };
  }
  if (!params.presence) {
    return { state: 'unknown', label: i18n.t('chat.botStatus.unknown') };
  }
  if (!params.presence.online) {
    return { state: 'offline', label: i18n.t('chat.botStatus.offline') };
  }
  const elapsed = params.now - params.presence.lastAt;
  if (elapsed > 90_000) {
    return { state: 'offline', label: i18n.t('chat.botStatus.offline') };
  }
  if (elapsed > 30_000) {
    return { state: 'idle', label: i18n.t('chat.botStatus.idle') };
  }
  return { state: 'online', label: i18n.t('chat.botStatus.online') };
}

export function resolveMobileMessageInputAvailability(params: {
  currentUserId: string | null;
  instanceStatus: string | null;
  presence: BotPresence | undefined;
  now: number;
  pendingMutation: boolean;
  editing: boolean;
}): MessageInputAvailability {
  const botDisplay = computeMobileBotDisplay({
    instanceStatus: params.instanceStatus,
    presence: params.presence,
    now: params.now,
  });

  if (params.currentUserId === null) {
    return {
      botDisplay,
      disabled: true,
      disabledReason: i18n.t('chat.botStatus.loadingUser'),
      showInstanceCta: false,
      submitDisabled: true,
    };
  }

  if (params.editing) {
    return {
      botDisplay,
      disabled: false,
      disabledReason: null,
      showInstanceCta: false,
      submitDisabled: params.pendingMutation,
    };
  }

  if (botDisplay.state === 'online' || botDisplay.state === 'idle') {
    return {
      botDisplay,
      disabled: false,
      disabledReason: null,
      showInstanceCta: false,
      submitDisabled: params.pendingMutation,
    };
  }

  return {
    botDisplay,
    disabled: true,
    disabledReason:
      botDisplay.state === 'unknown'
        ? i18n.t('chat.botStatus.waitingForStatus')
        : i18n.t('chat.botStatus.offlineMessage'),
    // Only a confirmed 'offline' surfaces the CTA. 'unknown' is the cold-cache
    // gap before the WS connects and the first bot-status round-trip resolves
    // (see useBotStatus) — every conversation open passes through it, so
    // treating it like offline fired the CTA on every open.
    showInstanceCta: botDisplay.state === 'offline',
    submitDisabled: true,
  };
}

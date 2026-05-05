type BotPresence = {
  online: boolean;
  lastAt: number;
};

type BotDisplayState = 'online' | 'idle' | 'offline' | 'unknown';

type BotDisplay = {
  state: BotDisplayState;
  label: 'Online' | 'Idle' | 'Offline' | 'Unknown';
};

type MessageInputAvailability = {
  botDisplay: BotDisplay;
  disabled: boolean;
  disabledReason: string | null;
  submitDisabled: boolean;
};

function computeMobileBotDisplay(params: {
  instanceStatus: string | null;
  presence: BotPresence | undefined;
  now: number;
}): BotDisplay {
  if (params.instanceStatus !== null && params.instanceStatus !== 'running') {
    return { state: 'offline', label: 'Offline' };
  }
  if (!params.presence) {
    return { state: 'unknown', label: 'Unknown' };
  }
  if (!params.presence.online) {
    return { state: 'offline', label: 'Offline' };
  }
  const elapsed = params.now - params.presence.lastAt;
  if (elapsed > 90_000) {
    return { state: 'offline', label: 'Offline' };
  }
  if (elapsed > 30_000) {
    return { state: 'idle', label: 'Idle' };
  }
  return { state: 'online', label: 'Online' };
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
      disabledReason: 'Loading user...',
      submitDisabled: true,
    };
  }

  if (params.editing) {
    return {
      botDisplay,
      disabled: false,
      disabledReason: null,
      submitDisabled: params.pendingMutation,
    };
  }

  if (botDisplay.state === 'online' || botDisplay.state === 'idle') {
    return {
      botDisplay,
      disabled: false,
      disabledReason: null,
      submitDisabled: params.pendingMutation,
    };
  }

  return {
    botDisplay,
    disabled: true,
    disabledReason:
      botDisplay.state === 'unknown'
        ? 'Waiting for bot status...'
        : 'Bot is offline. Messages will resume when it reconnects.',
    submitDisabled: true,
  };
}

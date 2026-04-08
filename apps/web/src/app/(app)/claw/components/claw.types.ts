import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

export type ClawState = KiloClawDashboardStatus['status'];

export type ExecPreset = 'always-ask' | 'never-ask';

export type BotIdentity = {
  botName: string;
  botNature: string;
  botVibe: string;
  botEmoji: string;
};

export const DEFAULT_BOT_IDENTITY: BotIdentity = {
  botName: 'KiloClaw',
  botNature: 'AI executive assistant',
  botVibe: 'Helpful, calm, and proactive',
  botEmoji: '🦾',
};

export type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function execPresetToConfig(preset: ExecPreset): { security: string; ask: string } {
  switch (preset) {
    case 'never-ask':
      return { security: 'full', ask: 'off' };
    case 'always-ask':
    default:
      return { security: 'allowlist', ask: 'on-miss' };
  }
}

/** Reverse-map stored exec config values back to a preset, or null if unrecognised. */
export function configToExecPreset(security: string | null, ask: string | null): ExecPreset | null {
  if (security === 'full' && ask === 'off') return 'never-ask';
  if (security === 'allowlist' && ask === 'on-miss') return 'always-ask';
  return null;
}

/**
 * Build the openclaw.json config patch that enables a channel with its token(s).
 * The shape must match what the controller writes in config-writer.ts.
 *
 * Returns `null` when the tokens record is empty or null (user skipped).
 */
export function channelTokensToConfigPatch(
  tokens: Record<string, string> | null
): Record<string, unknown> | null {
  if (!tokens || Object.keys(tokens).length === 0) return null;

  const patch: Record<string, unknown> = { channels: {}, plugins: { entries: {} } };
  const channels = patch.channels as Record<string, unknown>;
  const plugins = (patch.plugins as Record<string, unknown>).entries as Record<string, unknown>;

  if (tokens.telegramBotToken) {
    channels.telegram = {
      botToken: tokens.telegramBotToken,
      enabled: true,
      dmPolicy: 'pairing',
    };
    plugins.telegram = { enabled: true };
  }

  if (tokens.discordBotToken) {
    channels.discord = {
      token: tokens.discordBotToken,
      enabled: true,
      dm: { policy: 'pairing' },
    };
    plugins.discord = { enabled: true };
  }

  if (tokens.slackBotToken && tokens.slackAppToken) {
    channels.slack = {
      botToken: tokens.slackBotToken,
      appToken: tokens.slackAppToken,
      enabled: true,
    };
    plugins.slack = { enabled: true };
  }

  // Nothing was actually mapped (e.g. tokens had unrecognized keys only)
  if (Object.keys(channels).length === 0) return null;

  return patch;
}

export const CLAW_STATUS_BADGE: Record<
  Exclude<ClawState, null>,
  { label: string; className: string }
> = {
  running: {
    label: 'Machine Online',
    className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  },
  starting: {
    label: 'Starting',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-400 animate-pulse',
  },
  restarting: {
    label: 'Restarting',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-400 animate-pulse',
  },
  recovering: {
    label: 'Recovering',
    className: 'border-orange-500/30 bg-orange-500/15 text-orange-400 animate-pulse',
  },
  stopped: {
    label: 'Machine Stopped',
    className: 'border-red-500/30 bg-red-500/15 text-red-400',
  },
  provisioned: {
    label: 'Provisioned',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
  },
  destroying: {
    label: 'Destroying',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-400 animate-pulse',
  },
  restoring: {
    label: 'Restoring',
    className: 'border-purple-500/30 bg-purple-500/15 text-purple-400 animate-pulse',
  },
};

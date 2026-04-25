import { formatBriefingMarkdownForMessage } from './briefing-utils';
import { type CommandCapableRuntime, isTimeoutExecutionError, runCommand } from './command-utils';
import { DELIVERY_CHANNELS, DELIVERY_REASONS, DELIVERY_STATUSES } from './delivery-constants';

export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

export type BriefingDeliveryResult = {
  channel: DeliveryChannel;
  status: DeliveryStatus;
  target?: string;
  accountId?: string;
  reason?: DeliveryReason;
  error?: string;
};

type DeliveryRoute = {
  channel: DeliveryChannel;
  target: string;
  accountId?: string;
};

type DeliveryApi = CommandCapableRuntime & {
  config: unknown;
  logger: { info?: (message: string) => void; warn?: (message: string) => void };
};

type SkipReason = Extract<DeliveryReason, 'missing_target' | 'ambiguous_target'>;

export type DeliveryRouteResolution = {
  configured: boolean;
  route: DeliveryRoute | null;
  skipReason?: SkipReason;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeDeliveryTarget(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function toEnabledObjectEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  const record = asObject(value);
  return Object.entries(record)
    .filter((entry): entry is [string, Record<string, unknown>] => {
      const [key, raw] = entry;
      if (key.trim() === '' || key === '*') {
        return false;
      }
      return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
    })
    .filter(([, raw]) => raw.enabled !== false);
}

function collectFallbackTargets(
  channel: DeliveryChannel,
  rawChannelConfig: Record<string, unknown>
): string[] {
  if (channel === 'telegram') {
    return toEnabledObjectEntries(rawChannelConfig.groups).map(([groupId]) => groupId);
  }

  if (channel === 'discord') {
    const guildEntries = toEnabledObjectEntries(rawChannelConfig.guilds);
    return guildEntries.flatMap(([, guildConfig]) => {
      const channels = toEnabledObjectEntries(guildConfig.channels);
      return channels.map(([channelId]) => `channel:${channelId}`);
    });
  }

  const channels = toEnabledObjectEntries(rawChannelConfig.channels);
  return channels.map(([channelId]) => `channel:${channelId}`);
}

export function resolveDeliveryRoute(params: {
  channel: DeliveryChannel;
  channelsConfig: Record<string, unknown>;
}): DeliveryRouteResolution {
  const rawChannelConfig = asObject(params.channelsConfig[params.channel]);
  if (Object.keys(rawChannelConfig).length === 0 || rawChannelConfig.enabled === false) {
    return { configured: false, route: null };
  }

  const accountsConfig = asObject(rawChannelConfig.accounts);
  const defaultAccount = asObject(accountsConfig.default);
  const defaultAccountTarget = normalizeDeliveryTarget(defaultAccount.defaultTo);
  if (defaultAccountTarget) {
    return {
      configured: true,
      route: {
        channel: params.channel,
        target: defaultAccountTarget,
        accountId: 'default',
      },
    };
  }

  const topLevelTarget = normalizeDeliveryTarget(rawChannelConfig.defaultTo);
  if (topLevelTarget) {
    return {
      configured: true,
      route: {
        channel: params.channel,
        target: topLevelTarget,
      },
    };
  }

  const fallbackTargets = collectFallbackTargets(params.channel, rawChannelConfig);
  if (fallbackTargets.length === 1) {
    return {
      configured: true,
      route: {
        channel: params.channel,
        target: fallbackTargets[0],
      },
    };
  }

  return {
    configured: true,
    route: null,
    skipReason: fallbackTargets.length > 1 ? 'ambiguous_target' : 'missing_target',
  };
}

function readChannelsConfigFromRuntimeConfig(config: unknown): Record<string, unknown> | null {
  const rawConfig = asObject(config);
  if (!Object.prototype.hasOwnProperty.call(rawConfig, 'channels')) {
    return null;
  }
  return asObject(rawConfig.channels);
}

async function readChannelsConfig(api: DeliveryApi): Promise<Record<string, unknown>> {
  const fromRuntimeConfig = readChannelsConfigFromRuntimeConfig(api.config);
  if (fromRuntimeConfig) {
    return fromRuntimeConfig;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await runCommand(
        api,
        ['openclaw', 'config', 'get', 'channels', '--json'],
        60_000
      );
      return asObject(JSON.parse(stdout));
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (errorText.includes('Config path not found: channels')) {
        return {};
      }
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return {};
}

function createSendCommand(params: { route: DeliveryRoute; messageText: string }): string[] {
  const argv = [
    'openclaw',
    'message',
    'send',
    '--channel',
    params.route.channel,
    '--target',
    params.route.target,
    '--message',
    params.messageText,
  ];
  if (params.route.accountId) {
    argv.push('--account', params.route.accountId);
  }
  return argv;
}

async function sendWithRetry(api: DeliveryApi, argv: string[]): Promise<void> {
  try {
    await runCommand(api, argv, 120_000);
    return;
  } catch (error) {
    if (!isTimeoutExecutionError(error)) {
      throw error;
    }
  }
  await runCommand(api, argv, 120_000);
}

function failedDeliveryForAllChannels(errorText: string): BriefingDeliveryResult[] {
  return DELIVERY_CHANNELS.map(channel => ({
    channel,
    status: 'failed',
    reason: 'config_unavailable',
    error: errorText,
  }));
}

function summarizeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;
    const openclawSendPrefix = 'openclaw message send';
    if (message.startsWith(openclawSendPrefix) && message.includes(' failed: ')) {
      const detail = message.slice(message.indexOf(' failed: ') + ' failed: '.length).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
    return message;
  }

  return String(error);
}

export function parseStoredDelivery(entries: unknown): BriefingDeliveryResult[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map(entry => asObject(entry))
    .map(entry => {
      const channel =
        entry.channel === 'telegram' || entry.channel === 'discord' || entry.channel === 'slack'
          ? entry.channel
          : null;
      const status =
        entry.status === 'sent' || entry.status === 'skipped' || entry.status === 'failed'
          ? entry.status
          : null;
      if (!channel || !status) {
        return null;
      }

      const reason =
        entry.reason === 'missing_target' ||
        entry.reason === 'ambiguous_target' ||
        entry.reason === 'send_failed' ||
        entry.reason === 'config_unavailable'
          ? entry.reason
          : undefined;

      return {
        channel,
        status,
        target: typeof entry.target === 'string' ? entry.target : undefined,
        accountId: typeof entry.accountId === 'string' ? entry.accountId : undefined,
        reason,
        error: typeof entry.error === 'string' ? entry.error : undefined,
      } satisfies BriefingDeliveryResult;
    })
    .filter((entry): entry is BriefingDeliveryResult => entry !== null);
}

export function formatDeliverySummary(delivery: BriefingDeliveryResult[]): string[] {
  if (delivery.length === 0) {
    return ['- delivery: no configured messaging channels found'];
  }

  return delivery.map(entry => {
    const targetSuffix = entry.target ? ` (${entry.target})` : '';
    if (entry.status === 'sent') {
      return `- delivery: ${entry.channel} sent${targetSuffix}`;
    }
    if (entry.status === 'skipped') {
      return `- delivery: ${entry.channel} skipped (${entry.reason ?? 'unknown'})`;
    }
    return `- delivery: ${entry.channel} failed${targetSuffix}${entry.error ? `: ${entry.error}` : ''}`;
  });
}

export function logDeliveryOutcomeEvents(
  api: Pick<DeliveryApi, 'logger'>,
  delivery: BriefingDeliveryResult[]
): void {
  for (const entry of delivery) {
    const reason = entry.reason ?? 'none';
    const target = entry.target ?? 'none';
    const eventLine =
      `event=morning_briefing_delivery_outcome` +
      ` outcome=${entry.status}` +
      ` channel=${entry.channel}` +
      ` reason=${reason}` +
      ` target=${target}`;
    api.logger.info?.(eventLine);
    if (entry.status === 'failed') {
      const detail = entry.error ?? 'unknown_error';
      api.logger.warn?.(
        `event=morning_briefing_delivery_failure channel=${entry.channel} detail=${detail}`
      );
    }
  }
}

export async function deliverBriefingToConfiguredChannels(
  api: DeliveryApi,
  markdown: string
): Promise<BriefingDeliveryResult[]> {
  const messageText = formatBriefingMarkdownForMessage(markdown);
  if (!messageText) {
    return [];
  }

  let channelsConfig: Record<string, unknown>;
  try {
    channelsConfig = await readChannelsConfig(api);
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    api.logger.warn?.(`Morning briefing delivery config read failed: ${errorText}`);
    return failedDeliveryForAllChannels(errorText);
  }

  const delivery: BriefingDeliveryResult[] = [];
  const routes: DeliveryRoute[] = [];

  for (const channel of DELIVERY_CHANNELS) {
    const resolution = resolveDeliveryRoute({ channel, channelsConfig });
    if (!resolution.configured) {
      continue;
    }

    if (!resolution.route) {
      delivery.push({
        channel,
        status: 'skipped',
        reason: resolution.skipReason ?? 'missing_target',
      });
      continue;
    }

    routes.push(resolution.route);
  }

  for (const route of routes) {
    const argv = createSendCommand({ route, messageText });
    try {
      await sendWithRetry(api, argv);
      delivery.push({
        channel: route.channel,
        status: 'sent',
        target: route.target,
        accountId: route.accountId,
      });
    } catch (error) {
      delivery.push({
        channel: route.channel,
        status: 'failed',
        reason: 'send_failed',
        target: route.target,
        accountId: route.accountId,
        error: summarizeDeliveryError(error),
      });
    }
  }

  return delivery;
}

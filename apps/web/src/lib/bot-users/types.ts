export type BotType =
  | 'code-review'
  | 'security-scan'
  | 'auto-triage'
  | 'slack-bot'
  | 'discord-bot'
  | 'webhook-bot';

/**
 * Bot user naming patterns
 */
const BOT_USER_PATTERNS = {
  'code-review': {
    idPrefix: 'bot-code-review',
    emailSuffix: 'code-review-bot',
    displayName: 'Code Review Bot',
  },
  'security-scan': {
    idPrefix: 'bot-security-scan',
    emailSuffix: 'security-scan-bot',
    displayName: 'Security Scan Bot',
  },
  'auto-triage': {
    idPrefix: 'bot-auto-triage',
    emailSuffix: 'auto-triage-bot',
    displayName: 'Auto Triage Bot',
  },
  'slack-bot': {
    idPrefix: 'bot-slack',
    emailSuffix: 'slack-bot',
    displayName: 'Slack Bot',
  },
  'discord-bot': {
    idPrefix: 'bot-discord',
    emailSuffix: 'discord-bot',
    displayName: 'Discord Bot',
  },
  'webhook-bot': {
    idPrefix: 'bot-webhook',
    emailSuffix: 'webhook-bot',
    displayName: 'Webhook Bot',
  },
} as const;

export function generateBotUserId(organizationId: string, botType: BotType): string {
  const pattern = BOT_USER_PATTERNS[botType];
  return `${pattern.idPrefix}-${organizationId}`;
}

export function generateBotUserEmail(organizationId: string, botType: BotType): string {
  const pattern = BOT_USER_PATTERNS[botType];
  return `${pattern.emailSuffix}-${organizationId}@kilocode.internal`;
}

export function getBotDisplayName(botType: BotType): string {
  return BOT_USER_PATTERNS[botType].displayName;
}

/** Internal bots are platform-owned workload users, not per-org product bots. */
export const INTERNAL_BOT_USER_ID_PREFIX = 'bot-internal-';
const INTERNAL_BOT_EMAIL_DOMAIN = 'kilocode.internal';
export const INTERNAL_BOT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function internalBotUserId(slug: string): string {
  return `${INTERNAL_BOT_USER_ID_PREFIX}${slug}`;
}

export function internalBotUserEmail(slug: string): string {
  return `${slug}-internal-bot@${INTERNAL_BOT_EMAIL_DOMAIN}`;
}

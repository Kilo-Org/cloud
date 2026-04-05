export type BotType =
  | 'code-review'
  | 'security-scan'
  | 'auto-triage'
  | 'auto-fix'
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
  'auto-fix': {
    idPrefix: 'bot-auto-fix',
    emailSuffix: 'auto-fix-bot',
    displayName: 'Auto Fix Bot',
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

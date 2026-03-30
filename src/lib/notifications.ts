import { type User } from '@kilocode/db/schema';
import { type BalanceForUser, getBalanceForUser } from './user.balance';
import { FIRST_TOPUP_BONUS_AMOUNT, APP_URL } from '@/lib/constants';
import { getUserOrganizationsWithSeats } from '@/lib/organizations/organizations';
import type { UserOrganizationWithSeats } from '@/lib/organizations/organization-types';
import { summarizeUserPayments } from '@/lib/creditTransactions';
import { hasOrganizationEverPaid, hasUserEverPaid } from '@/lib/creditTransactions';
import { cachedPosthogQuery } from '@/lib/posthog-query';
import * as z from 'zod';
import { subDays } from 'date-fns';
import { hasReceivedPromotion } from '@/lib/promotionalCredits';

import { fromMicrodollars } from '@/lib/utils';
import { KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto-model';

/** Pre-fetched data shared across notification generators to avoid duplicate DB queries. */
type NotificationContext = {
  userOrganizations: UserOrganizationWithSeats[];
  isInTeam: boolean;
  balance: BalanceForUser;
};

export type KiloNotification = {
  id: string;
  title: string;
  message: string;
  action?: {
    actionText: string;
    actionURL: string;
  };
  suggestModelId?: string;
  // When showIn is specified this can be used to target specific apps. When not specified all apps with notification support will show it:
  // CAUTION: use extension-native sparingly since it shows up as a native VSCode notification and is spammy
  showIn?: ('extension' | 'extension-native' | 'cli')[];
  // ISO 8601 timestamp after which this notification should no longer be shown
  expiresAt?: string;
};

const normalUnconditionalNotifications: KiloNotification[] = [
  //If you need to check or personalize the notification, see examples at the bottom of this file
  //if you just want a simple straightforward global message, add it here.
  {
    id: 'kilo-cli-jan-5',
    title: 'Kilo CLI',
    message: 'Prefer the terminal? Install the Kilo CLI with npm install -g @kilocode/cli',
    action: {
      actionText: 'Learn more',
      actionURL: 'https://kilo.ai/docs/cli',
    },
    showIn: ['extension'],
  },
  {
    id: 'kilo-cloud-agents-jan-15',
    title: 'Kilo Cloud Agents',
    message: 'You can use Kilo in the browser - no local machine required. Try it here.',
    action: {
      actionText: 'Cloud Agents',
      actionURL: 'https://app.kilo.ai/cloud',
    },
    showIn: ['extension', 'cli'],
  },
  {
    id: 'app-builder-promo-mar-6',
    title: 'Try App Builder',
    message: "Don't feel like coding? Try App Builder to build with natural language from the web",
    action: {
      actionText: 'Try App Builder',
      actionURL: 'https://app.kilo.ai/app-builder',
    },
    showIn: ['extension'],
    expiresAt: '2026-03-09T08:00:00Z',
  },
  {
    id: 'nvidia-nemotron-3-super-launch-mar-11',
    title: 'NVIDIA Nemotron 3 Super is live in Kilo!',
    message:
      'NVIDIA Nemotron 3 Super is now free to use for a limited time in Kilo — 120B parameter model with 256k context window!',
    action: {
      actionText: 'Learn more',
      actionURL: 'https://blog.kilo.ai/nvidia-nemotron-3-super-launch',
    },
    suggestModelId: 'nvidia/nemotron-3-super-120b-a12b:free',
    showIn: ['extension', 'cli'],
    expiresAt: '2026-03-25T08:00:00Z',
  },
];

export async function generateUserNotifications(user: User): Promise<KiloNotification[]> {
  // Pre-fetch shared data once to avoid duplicate DB queries across generators.
  // This eliminates ~5 redundant queries per request (2× userHasOrganizations,
  // 3× getUserOrganizationsWithSeats, 2× getBalanceForUser → 1+1 queries).
  const [userOrganizations, balance] = await Promise.all([
    getUserOrganizationsWithSeats(user.id),
    getBalanceForUser(user),
  ]);
  const ctx: NotificationContext = {
    userOrganizations,
    // Replaces the old userHasOrganizations() LIMIT-1 existence check; acceptable
    // because getUserOrganizationsWithSeats is already needed by other generators.
    isInTeam: userOrganizations.length > 0,
    balance,
  };

  const conditionalNotifications: ((
    user: User,
    ctx: NotificationContext
  ) => Promise<KiloNotification[]>)[] = [
    generateTeamsTrialNotification,
    generateLowCreditNotification,
    generateAutoTopUpNotification,
    generateAutoTopUpOrgsNotification,
    generateByokProvidersNotification,
    generateMiniMaxNoLongerFreeNotification,
    generateFirstDayWelcomeNotification,
    generateKiloPassNotification,
  ];

  const resolvedConditionalNotifications = (
    await Promise.all(conditionalNotifications.map(f => f(user, ctx)))
  ).flat();

  const now = new Date();
  return [...resolvedConditionalNotifications, ...normalUnconditionalNotifications].filter(
    n => !n.expiresAt || new Date(n.expiresAt) > now
  );
}

async function generateLowCreditNotification(
  user: User,
  ctx: NotificationContext
): Promise<KiloNotification[]> {
  // For now, let's not confuse users when they're on a team
  if (ctx.isInTeam) return [];

  const { balance } = ctx.balance;

  if (balance >= 2) return [];
  const payments = await summarizeUserPayments(user.id);

  const message = !payments.payments_count
    ? `Your credit balance is low. Top up now and get $${FIRST_TOPUP_BONUS_AMOUNT()} extra on your first purchase! Add any amount of credits and we'll add $${FIRST_TOPUP_BONUS_AMOUNT()} on top instantly.`
    : 'Your credit balance is low. Add credits to continue using the service without interruption.';

  return [
    {
      id: 'low-credit-warning',
      title: 'Low Credit Balance',
      message,
      action: {
        actionText: !payments.payments_count
          ? `Add Credits & Get $${FIRST_TOPUP_BONUS_AMOUNT()} Free`
          : 'Add Credits',
        actionURL: `${APP_URL}/profile`,
      },
    },
  ];
}

async function generateAutoTopUpNotification(
  user: User,
  ctx: NotificationContext
): Promise<KiloNotification[]> {
  if (!(await hasUserEverPaid(user.id))) {
    return [];
  }

  for (const org of ctx.userOrganizations) {
    if (await hasOrganizationEverPaid(org.organizationId)) {
      return [];
    }
  }

  return [
    {
      id: 'auto-top-up-dec-19',
      title: 'New: Auto Top-Ups',
      message:
        "Set your top-up amount once—we'll automatically add credits when you drop below $5. First 200 users to trigger it get $20 bonus credits.",
      action: {
        actionText: 'Enable Auto Top-Ups',
        actionURL: 'https://app.kilo.ai/credits',
      },
      showIn: ['cli', 'extension'],
    },
  ];
}

async function generateAutoTopUpOrgsNotification(
  _user: User,
  ctx: NotificationContext
): Promise<KiloNotification[]> {
  const isOwnerOrAdmin = ctx.userOrganizations.some(org => org.role === 'owner');
  if (!isOwnerOrAdmin) return [];

  return [
    {
      id: 'auto-top-up-orgs-march-10',
      title: 'New: Auto Top-Ups For Organizations',
      message:
        "Set your top-up amount once—we'll automatically add credits to your organization's balance when it drops below $50.",
      action: {
        actionText: 'Enable Auto Top-Ups',
        actionURL: 'https://app.kilo.ai/',
      },
      showIn: ['cli', 'extension'],
    },
  ];
}

async function generateTeamsTrialNotification(
  _user: User,
  ctx: NotificationContext
): Promise<KiloNotification[]> {
  // Only show teams notification if user is NOT already in a team
  if (ctx.isInTeam) return [];

  return [
    {
      id: 'teams-free-trial-oct-17',
      title: 'Try Kilo with Your Team — Free for 14 Days',
      message:
        'Get usage analytics, centralized billing, shared context, and other features you need to scale AI coding across your org.',
      action: {
        actionText: 'Get Started',
        actionURL: 'https://app.kilocode.ai/get-started/teams',
      },
      showIn: ['cli', 'extension'],
    },
  ];
}

async function generateMiniMaxNoLongerFreeNotification(
  user: User,
  _ctx: NotificationContext
): Promise<KiloNotification[]> {
  try {
    const users = await cachedPosthogQuery(
      z.array(z.tuple([z.string()]).transform(([userId]) => userId))
    )(
      'minimax-no-longer-free-users',
      'select kilo_user_id from notification_mar_23_minimax_no_longer_free limit 5e5'
    );

    if (!users.includes(user.id)) {
      console.debug(
        '[generateMiniMaxNoLongerFreeNotification] user has not used MiniMax M2.5 free'
      );
      return [];
    }

    console.debug('[generateMiniMaxNoLongerFreeNotification] user has used MiniMax M2.5 free');
    return [
      {
        id: 'minimax-no-longer-free-mar-23',
        title: 'MiniMax M2.5 Free ending soon',
        message:
          'The MiniMax M2.5 free promotion ends soon. Please switch to Kilo Auto Free or another free model.',
        action: {
          actionText: 'Learn more',
          actionURL: 'https://kilo.ai/docs/contributing/architecture/auto-model-tiers',
        },
        suggestModelId: KILO_AUTO_FREE_MODEL.id,
        showIn: ['cli', 'extension'],
      },
    ];
  } catch (e) {
    console.error('[generateMiniMaxNoLongerFreeNotification]', e);
    return [];
  }
}

async function generateByokProvidersNotification(
  user: User,
  _ctx: NotificationContext
): Promise<KiloNotification[]> {
  try {
    const byokProviderUsers = await cachedPosthogQuery(
      z.array(
        z.tuple([z.string(), z.string()]).transform(([userId, provider]) => ({ userId, provider }))
      )
    )(
      'byok-provider-usage-users',
      'select id, apiProvider from notification_byok_providers_jan_19 limit 5e5'
    );

    const provider = byokProviderUsers.find(p => p.userId === user.id)?.provider;
    if (!provider) {
      console.debug('[generateByokProvidersNotification] not using a BYOK supported provider');
      return [];
    }

    const names = {
      anthropic: 'Claude API Key',
      bedrock: 'Amazon Bedrock',
      gemini: 'Google AI API Key',
      'openai-native': 'OpenAI API Key',
      minimax: 'MiniMax Coding Plan',
      mistral: 'Mistral AI API Key',
      xai: 'xAI API Key',
      zai: 'GLM Coding Plan',
    } as Record<string, string>;

    console.debug(
      `[generateByokProvidersNotification] has used BYOK supported provider ${provider}`
    );
    return [
      {
        id: 'byok-providers-jan-19',
        title: 'Try BYOK for Kilo Gateway',
        message: `BYOK now supported for your ${names[provider]}, allowing faster model support, Kilo platform features, and more!`,
        action: {
          actionText: 'Learn more',
          actionURL: 'https://kilo.ai/docs/basic-usage/byok',
        },
        showIn: ['cli', 'extension'],
      },
    ];
  } catch (e) {
    console.error('[generateByokProvidersNotification]', e);
    return [];
  }
}

async function generateFirstDayWelcomeNotification(
  user: User,
  ctx: NotificationContext
): Promise<KiloNotification[]> {
  // Check if user was created within the last day
  if (new Date(user.created_at) < subDays(new Date(), 1)) {
    return [];
  }

  // Check if user has received the signup bonus
  const hasReceivedBonus = await hasReceivedPromotion(user.id, 'automatic-welcome-credits');
  if (!hasReceivedBonus) {
    return [];
  }

  // Check if user still has credit balance
  if (ctx.balance.balance <= 1) {
    return [];
  }

  return [
    {
      id: 'first-day-welcome-jan-8',
      title: 'Welcome to Kilo Code!',
      message:
        'We added $2.50 to your balance to get started! If you want something to try, try asking Kilo to clone Kilo-Org/KiloMan and run it.',
      action: {
        actionText: 'Open Kilo-Org/KiloMan',
        actionURL: 'https://github.com/Kilo-Org/kiloman',
      },
      showIn: ['cli', 'extension'],
    },
  ];
}

async function generateKiloPassNotification(
  user: User,
  ctx: NotificationContext
): Promise<KiloNotification[]> {
  // Check if user belongs to an organization with balance > $5
  const hasHighBalanceOrg = ctx.userOrganizations.some(org => fromMicrodollars(org.balance) > 5);
  if (hasHighBalanceOrg) {
    return [];
  }

  return [
    {
      id: 'kilo-pass-announcement-jan-12',
      title: 'Introducing Kilo Pass',
      message: 'Subscribe to Kilo Pass and get up to 50% free bonus credits every month.',
      action: {
        actionText: 'Learn More',
        actionURL: 'https://blog.kilo.ai/p/introducing-kilo-pass',
      },
      showIn: ['cli', 'extension'],
    },
  ];
}

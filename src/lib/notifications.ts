import { type User } from '@kilocode/db/schema';
import { getBalanceForUser } from './user.balance';
import { FIRST_TOPUP_BONUS_AMOUNT, APP_URL } from '@/lib/constants';
import {
  getUserOrganizationsWithSeats,
  userHasOrganizations,
} from '@/lib/organizations/organizations';
import { summarizeUserPayments } from '@/lib/creditTransactions';
import { hasOrganizationEverPaid, hasUserEverPaid } from '@/lib/creditTransactions';
import { cachedPosthogQuery } from '@/lib/posthog-query';
import * as z from 'zod';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { db } from '@/lib/drizzle';
import { fromMicrodollars } from '@/lib/utils';
import { KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto-model';

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
  // Disabled: GLM-5 free period has long ended; no need to keep notifying users.
  // {
  //   id: 'feb-25-glm5-free-ended',
  //   title: 'GLM-5 Free Period Ended',
  //   message:
  //     'The free period for GLM-5 has ended. Try another free model like MiniMax M2.5 or Trinity Large Preview!',
  //   showIn: ['extension', 'cli'],
  // },
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
];

export async function generateUserNotifications(user: User): Promise<KiloNotification[]> {
  const conditionalNotifications: ((user: User) => Promise<KiloNotification[]>)[] = [
    generateTeamsTrialNotification,
    generateLowCreditNotification,
    generateAutoTopUpNotification,
    generateAutoTopUpOrgsNotification,
    generateByokProvidersNotification,
    generateKiloPassNotification,
    generateKimiFreeEndingNotification,
  ];

  const resolvedConditionalNotifications = (
    await Promise.all(conditionalNotifications.map(f => f(user)))
  ).flat();

  const now = new Date();
  return [...resolvedConditionalNotifications, ...normalUnconditionalNotifications].filter(
    n => !n.expiresAt || new Date(n.expiresAt) > now
  );
}

async function generateLowCreditNotification(user: User): Promise<KiloNotification[]> {
  const isInTeam = await userHasOrganizations(user.id);
  // For now, let's not confuse users when they're on a team
  if (isInTeam) return [];

  const { balance } = await getBalanceForUser(user);

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

async function generateAutoTopUpNotification(user: User): Promise<KiloNotification[]> {
  if (!(await hasUserEverPaid(user.id))) {
    return [];
  }

  for (const org of await getUserOrganizationsWithSeats(user.id)) {
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

async function generateAutoTopUpOrgsNotification(user: User): Promise<KiloNotification[]> {
  const orgs = await getUserOrganizationsWithSeats(user.id);
  const isOwnerOrAdmin = orgs.some(org => org.role === 'owner');
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

async function generateTeamsTrialNotification(user: User): Promise<KiloNotification[]> {
  // Only show teams notification if user is NOT already in a team
  const isInTeam = await userHasOrganizations(user.id);
  if (isInTeam) return [];

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

async function generateByokProvidersNotification(user: User): Promise<KiloNotification[]> {
  try {
    const byokProviderUsers = await cachedPosthogQuery(
      z.array(
        z.tuple([z.string(), z.string()]).transform(([userId, provider]) => ({ userId, provider }))
      )
    )(
      'byok-provider-usage-users',
      `
        select u.id, ev.properties.apiProvider
        from events ev
        join postgres.kilocode_users u on u.google_user_email = ev.distinct_id
        where ev.event = 'LLM Completion'
          and ev.properties.apiProvider in (
            'anthropic'
            , 'gemini'
            , 'openai-native'
            , 'minimax'
            , 'mistral'
            , 'xai'
            , 'zai'
          )
          and ev.timestamp >= now() - interval 14 day
        group by u.id, ev.properties.apiProvider
        having count(ev.distinct_id) >= 10
        order by max(ev.timestamp) desc
        limit 1e5
      `
    );

    const provider = byokProviderUsers.find(p => p.userId === user.id)?.provider;
    if (!provider) {
      console.debug('[generateByokProvidersNotification] not using a BYOK supported provider');
      return [];
    }

    const names = {
      anthropic: 'Claude API Key',
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

async function generateKiloPassNotification(user: User): Promise<KiloNotification[]> {
  // Exclude users who already have a Kilo Pass
  const kiloPassState = await getKiloPassStateForUser(db, user.id);
  if (kiloPassState) {
    return [];
  }

  // Check if user belongs to an organization with balance > $5
  const orgs = await getUserOrganizationsWithSeats(user.id);
  const hasHighBalanceOrg = orgs.some(org => fromMicrodollars(org.balance) > 5);
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

async function generateKimiFreeEndingNotification(user: User): Promise<KiloNotification[]> {
  try {
    const kimiFreeUsers = await cachedPosthogQuery(
      z.array(z.tuple([z.string()]).transform(([userId]) => userId))
    )(
      'kimi-k25-free-users',
      `
        select u.id
        from events ev
        join postgres.kilocode_users u on u.google_user_email = ev.distinct_id
        where ev.event = 'LLM Completion'
          and ev.properties.model = 'moonshotai/kimi-k2.5:free'
          and ev.timestamp >= now() - interval 30 day
        group by u.id
        order by max(ev.timestamp) desc
        limit 1e5
      `
    );

    if (!kimiFreeUsers.includes(user.id)) {
      return [];
    }

    return [
      {
        id: 'kimi-k25-free-ending-mar-5',
        title: 'Kimi K2.5 Free Promotion Ending Soon',
        message:
          'We hope you enjoyed free use of Kimi K2.5! The promotion will be ending soon. You can switch to Kilo: Auto free mode or keep using Kimi with credits.',
        suggestModelId: KILO_AUTO_FREE_MODEL.id,
        action: {
          actionText: 'Switch to Kilo: Auto Free',
          actionURL: `${APP_URL}/credits`,
        },
        showIn: ['cli', 'extension'],
      },
    ];
  } catch (e) {
    console.error('[generateKimiFreeEndingNotification]', e);
    return [];
  }
}

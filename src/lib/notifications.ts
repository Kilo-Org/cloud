import { type User, microdollar_usage } from '@/db/schema';
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
import { subDays } from 'date-fns';
import { hasReceivedPromotion } from '@/lib/promotionalCredits';
import { readDb } from '@/lib/drizzle';
import { and, eq, inArray, gte } from 'drizzle-orm';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { db } from '@/lib/drizzle';
import { fromMicrodollars } from '@/lib/utils';

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
};

const normalUnconditionalNotifications: KiloNotification[] = [
  //If you need to check or personalize the notification, see examples at the bottom of this file
  //if you just want a simple straightforward global message, add it here.
  {
    id: 'feb-12-free-glm-5',
    title: 'GLM-5 is free (for a limited time)',
    message: 'Get Opus-level performance, for free.',
    action: {
      actionText: 'Learn More',
      actionURL: 'https://blog.kilo.ai/p/glm-5-free-limited-time',
    },
    suggestModelId: 'z-ai/glm-5:free',
    showIn: ['extension', 'cli'],
  },
  {
    id: 'kilo-cli-jan-5',
    title: 'Kilo CLI',
    message: 'Prefer the terminal? Install the Kilo CLI with npm install -g @kilocode/cli',
    action: {
      actionText: 'Learn more',
      actionURL: 'https://kilo.ai/docs/cli',
    },
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
];

export async function generateUserNotifications(user: User): Promise<KiloNotification[]> {
  const conditionalNotifications: ((user: User) => Promise<KiloNotification[]>)[] = [
    generateTeamsTrialNotification,
    generateLowCreditNotification,
    generateAutoTopUpNotification,
    generateByokProvidersNotification,
    generateFirstDayWelcomeNotification,
    generateAutocompleteNotification,
    generateKiloPassNotification,
  ];

  const resolvedConditionalNotifications = (
    await Promise.all(conditionalNotifications.map(f => f(user)))
  ).flat();

  return [...resolvedConditionalNotifications, ...normalUnconditionalNotifications];
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

async function generateTeamsTrialNotification(user: User): Promise<KiloNotification[]> {
  // Only show teams notification if user is NOT already in a team
  const isInTeam = await userHasOrganizations(user.id);
  if (isInTeam) return [];

  return [
    {
      id: 'teams-free-trial-oct-17',
      title: 'Try Kilo with Your Team — Free for 30 Days',
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

async function generateFirstDayWelcomeNotification(user: User): Promise<KiloNotification[]> {
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
  const { balance } = await getBalanceForUser(user);
  if (balance <= 1) {
    return [];
  }

  return [
    {
      id: 'first-day-welcome-jan-8',
      title: 'Welcome to Kilo Code!',
      message:
        'We added $5 to your balance to get started! If you want something to try, try asking Kilo to clone Kilo-Org/KiloMan and run it.',
      action: {
        actionText: 'Open Kilo-Org/KiloMan',
        actionURL: 'https://github.com/Kilo-Org/kiloman',
      },
      showIn: ['cli', 'extension'],
    },
  ];
}

async function generateAutocompleteNotification(user: User): Promise<KiloNotification[]> {
  try {
    // Query the database directly for this specific user instead of fetching all users
    const codestralModels = ['codestral-2508', 'mistralai/codestral-2508'];
    const result = await readDb
      .select({ kilo_user_id: microdollar_usage.kilo_user_id })
      .from(microdollar_usage)
      .where(
        and(
          eq(microdollar_usage.kilo_user_id, user.id),
          inArray(microdollar_usage.model, codestralModels),
          gte(microdollar_usage.created_at, '2025-01-01')
        )
      )
      .limit(1);

    if (result.length > 0) {
      console.debug(
        '[generateAutocompleteNotification] user has used autocomplete through gateway'
      );
      return [];
    }
  } catch (e) {
    console.error('[generateAutocompleteNotification]', e);
    return [];
  }

  console.debug(
    '[generateAutocompleteNotification] user has not used autocomplete through gateway'
  );
  return [
    {
      id: 'autocomplete-free-jan-14',
      title: 'How to use autocomplete for 100% free',
      message:
        'Integrate Mistrals Codestral with a generous free tier and use inline & prompt autocomplete for free',
      action: {
        actionText: 'See how',
        actionURL: 'https://kilo.ai/docs/basic-usage/autocomplete/mistral-setup',
      },
      showIn: ['cli', 'extension'],
    },
  ];
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

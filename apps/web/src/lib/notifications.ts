import { type User } from '@kilocode/db/schema';
import { type BalanceForUser, getBalanceForUser } from '@/lib/user/balance';
import { FIRST_TOPUP_BONUS_AMOUNT, APP_URL } from '@/lib/constants';
import { getUserOrganizationsWithSeats } from '@/lib/organizations/organizations';
import type { UserOrganizationWithSeats } from '@/lib/organizations/organization-types';
import { summarizeUserPayments } from '@/lib/creditTransactions';
import { hasOrganizationEverPaid, hasUserEverPaid } from '@/lib/creditTransactions';
import {
  getByokProviderNotificationLabel,
  getByokProvidersForUser,
} from '@/lib/notifications/byok-provider-cache';

import { fromMicrodollars } from '@/lib/utils';

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
  // When true, only show to the legacy ("Roo-based") Kilo Code extension, identified by
  // its axios User-Agent. Used to target end-of-life notices at legacy-extension users.
  showOnlyOnLegacyExtension?: boolean;
};

/**
 * Decide whether a legacy-targeted notification should be shown to a client.
 * Notifications flagged showOnlyOnLegacyExtension are shown only when the request
 * came from the legacy extension (detected via its axios User-Agent).
 */
export function passesLegacyExtensionGate(
  notification: Pick<KiloNotification, 'showOnlyOnLegacyExtension'>,
  isLegacyExtension: boolean
): boolean {
  if (!notification.showOnlyOnLegacyExtension) return true;
  return isLegacyExtension;
}

const normalUnconditionalNotifications: KiloNotification[] = [
  //If you need to check or personalize the notification, see examples at the bottom of this file
  //if you just want a simple straightforward global message, add it here.
  {
    id: 'mercury-edit-2-extension-july-24',
    title: 'Free Mercury Edit 2 access extended',
    message: 'Free access to Mercury Edit 2 has been extended until Friday, July 24 at 12 PM ET.',
    showIn: ['extension'],
    expiresAt: '2026-07-24T16:00:00Z',
  },
  {
    id: 'legacy-upgrade-june-2026',
    title: 'Kilo Code 5.x: End of Life July 31, 2026',
    message:
      'Kilo Code extension version 5.x reaches end of life on July 31, 2026. After that date, it will no longer receive updates, bug fixes, or security patches. Upgrade to the latest version for continued support.',
    action: {
      actionText: 'See End of Life Notice',
      actionURL: 'https://github.com/Kilo-Org/kilocode-legacy#legacy-ide-extensions-end-of-life',
    },
    showIn: ['extension'],
    showOnlyOnLegacyExtension: true,
  },
  {
    id: 'stealth-opus-discount-may-25',
    title: 'Claude Opus 4.7 at 20% Off — Only in Kilo Code!',
    message:
      'A stealth provider is offering Claude Opus 4.7 at 20% off list price, exclusively in Kilo Code.',
    suggestModelId: 'stealth/claude-opus-4.7',
    expiresAt: '2026-06-08T08:00:00Z',
  },
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
    id: 'kilo-console-beta',
    title: 'Try Kilo Console (Beta)',
    message: 'Manage git worktrees, sessions, and all CLI settings from a browser-based UI.',
    action: {
      actionText: 'How to install',
      actionURL:
        'https://blog.kilo.ai/p/kilo-console-beta-is-live?utm_source=kilo-cli&utm_medium=notifications&utm_campaign=cli-tips',
    },
    showIn: ['cli'],
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

export async function generateUserNotifications(
  user: User,
  { isLegacyExtension = false }: { isLegacyExtension?: boolean } = {}
): Promise<KiloNotification[]> {
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
    generateKiloPassNotification,
    generateKiloPassPromoMay29Notification,
  ];

  const resolvedConditionalNotifications = (
    await Promise.all(conditionalNotifications.map(f => f(user, ctx)))
  ).flat();

  const now = new Date();
  return [...resolvedConditionalNotifications, ...normalUnconditionalNotifications].filter(n => {
    if (n.expiresAt && new Date(n.expiresAt) <= now) return false;
    if (!passesLegacyExtensionGate(n, isLegacyExtension)) return false;
    return true;
  });
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

  const message =
    !payments.payments_count && FIRST_TOPUP_BONUS_AMOUNT > 0
      ? `Your credit balance is low. Top up now and get $${FIRST_TOPUP_BONUS_AMOUNT} extra on your first purchase! Add any amount of credits and we'll add $${FIRST_TOPUP_BONUS_AMOUNT} on top instantly.`
      : 'Your credit balance is low. Add credits to continue using the service without interruption.';

  return [
    {
      id: 'low-credit-warning',
      title: 'Low Credit Balance',
      message,
      action: {
        actionText:
          !payments.payments_count && FIRST_TOPUP_BONUS_AMOUNT > 0
            ? `Add Credits & Get $${FIRST_TOPUP_BONUS_AMOUNT} Free`
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
        "Set your top-up amount once—we'll automatically add credits when you drop below $5.",
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

async function generateByokProvidersNotification(
  user: User,
  _ctx: NotificationContext
): Promise<KiloNotification[]> {
  try {
    // Per-user provider ids are written daily to Redis by the
    // `sync-byok-provider-notifications` cron, so this read is tiny.
    const providers = await getByokProvidersForUser(user.id);
    if (providers.length === 0) {
      console.debug('[generateByokProvidersNotification] not using a BYOK supported provider');
      return [];
    }

    // A user may have used several providers; show the first one we have a label for.
    const providerName = providers
      .map(provider => getByokProviderNotificationLabel(provider))
      .find(name => Boolean(name));
    if (!providerName) {
      console.debug(
        `[generateByokProvidersNotification] no BYOK supported provider among ${providers.join(', ')}`
      );
      return [];
    }

    console.debug(
      `[generateByokProvidersNotification] has used BYOK supported provider(s) ${providers.join(', ')}`
    );
    return [
      {
        id: 'byok-providers-jan-19',
        title: 'Try BYOK for Kilo Gateway',
        message: `BYOK now supported for your ${providerName}, allowing faster model support, Kilo platform features, and more!`,
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

async function generateKiloPassPromoMay29Notification(
  user: User,
  _ctx: NotificationContext
): Promise<KiloNotification[]> {
  if (!(await hasUserEverPaid(user.id))) {
    return [];
  }

  return [
    {
      id: 'kilo-pass-promo-may-29',
      title: 'Get more from every dollar with Kilo Pass',
      message: 'A monthly AI token subscription with up to 50% bonus credits included.',
      action: {
        actionText: 'Explore Kilo Pass',
        actionURL: 'https://kilo.ai/pricing/kilo-pass',
      },
      showIn: ['cli', 'extension'],
      expiresAt: '2026-06-30T08:00:00Z',
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

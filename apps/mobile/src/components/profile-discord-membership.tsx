import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';
import { Shield, ShieldCheck } from '@/components/ui/icons';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { parseTimestamp } from '@/lib/utils';

/** The row's handle for native E2E scripts, in every state it renders. */
const ROW_TEST_ID = 'discord-membership-row';

/** Where the app links a Discord account: the sign-in methods screen. */
const LOGIN_METHODS_HREF = '/(app)/(tabs)/(3_profile)/login-methods' as Href;

type DiscordGuildStatus = inferRouterOutputs<MobileRouter>['user']['getDiscordGuildStatus'];

/**
 * What the Discord row answers, one arm at a time: the linked account's server
 * membership, or the two ways the row has no answer (no link, no read).
 */
type DiscordMembershipView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unlinked' }
  | { readonly kind: 'member'; readonly verifiedAt: string }
  | { readonly kind: 'notMember' }
  | { readonly kind: 'readFailed' };

/**
 * The row's one answer, from the linked-accounts read and the membership read
 * over it. A read that failed over data it retained keeps the data's answer:
 * the last known membership is still true, and the row's only false claim
 * would be either direction of membership.
 */
function discordMembershipView(
  hasDiscordLinked: boolean,
  status: DiscordGuildStatus | undefined,
  failed: boolean
): DiscordMembershipView {
  if (!hasDiscordLinked) {
    return { kind: 'unlinked' };
  }
  if (status === undefined) {
    return failed ? { kind: 'readFailed' } : { kind: 'loading' };
  }
  const verifiedAt = status.discord_server_membership_verified_at;
  return verifiedAt === null ? { kind: 'notMember' } : { kind: 'member', verifiedAt };
}

/**
 * Why a verify attempt refused. The two refusals differ in what can repair
 * them — a link that is gone, or a verification that did not complete — so the
 * row keeps them apart even though it shows one sentence for both. The copy
 * travels inside the failure, so a message cannot exist without its kind.
 */
type DiscordVerifyFailure =
  | { readonly kind: 'not-linked'; readonly message: string }
  | { readonly kind: 'verification-refused'; readonly message: string };

/** The server's code for a verify attempt on an account with no Discord link. */
const DISCORD_NOT_LINKED_CODE = 'BAD_REQUEST';

/** A verify rejection as the failure the row reports. */
function discordVerifyFailure(error: unknown, message: string): DiscordVerifyFailure {
  const kind =
    readTrpcErrorField(error, 'code') === DISCORD_NOT_LINKED_CODE
      ? 'not-linked'
      : 'verification-refused';
  return { kind, message };
}

/** The copy a failed verify paints, in the row's single message slot. */
function verifyFailureMessage(failure: DiscordVerifyFailure): string {
  switch (failure.kind) {
    case 'not-linked':
    case 'verification-refused': {
      return failure.message;
    }
    default: {
      return assertSurfaceFailureHandled(failure);
    }
  }
}

type DiscordMembershipRowProps = Readonly<{
  /** The account is signed in, so its membership can be read. */
  isAuthenticated: boolean;
  /** The screen's idle latch: deferred reads wait out the first paint. */
  afterIdle: boolean;
  /** The linked-accounts read lists a Discord provider for this account. */
  hasDiscordLinked: boolean;
}>;

/**
 * The account's Kilo Discord server membership, as one row of the Profile tab's
 * Linked accounts group.
 *
 * An account with no Discord link gets the way to add one instead of a
 * membership read: the status query stays disabled in that state, so the row
 * never asks the server about a provider it already knows is absent. With a
 * link, the row reports the verification date the server holds, the Verify
 * action while it holds none, and the retry for a read that failed.
 *
 * Verifying re-reads the status rather than trusting the mutation's answer:
 * membership is a stored fact about the account (web's profile panel reads it
 * the same way), and the invalidation hands this row the server's sentence. A
 * failed verify therefore keeps the membership the row already showed and turns
 * the failure into the row's subtitle, its one message slot — no toast repeats
 * it, and the action stays reachable for another attempt.
 */
export function DiscordMembershipRow({
  isAuthenticated,
  afterIdle,
  hasDiscordLinked,
}: DiscordMembershipRowProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { feedback, failure, begin } = useSurfaceFeedback<DiscordVerifyFailure>();
  /** A verify attempt settled on this mount, so the action offers a re-check. */
  const [attempted, setAttempted] = useState(false);

  const status = useQuery({
    ...trpc.user.getDiscordGuildStatus.queryOptions(),
    enabled: isAuthenticated && afterIdle && hasDiscordLinked,
    // A paused read leaves the row with neither a date nor a retry.
    ...SETTLE_WHILE_OFFLINE,
  });

  const verify = useMutation(
    trpc.user.verifyDiscordGuildMembership.mutationOptions({
      onSuccess: () => {
        // The stored verification belongs to the account, so both reads that
        // report it are stale: the membership row and the provider list.
        void queryClient.invalidateQueries({
          queryKey: trpc.user.getDiscordGuildStatus.queryKey(),
        });
        void queryClient.invalidateQueries({ queryKey: trpc.user.getAuthProviders.queryKey() });
      },
    })
  );

  const view = discordMembershipView(hasDiscordLinked, status.data, status.isError);
  const failureMessage = failure === null ? null : verifyFailureMessage(failure);
  const verifying = feedback.status === 'pending';

  const onVerify = () => {
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    void (async () => {
      try {
        await verify.mutateAsync();
        if (attempt.owns()) {
          setAttempted(true);
          // The refreshed read is the outcome this row renders, so the attempt
          // leaves nothing behind for it.
          attempt.abandon();
        }
      } catch (error) {
        if (attempt.owns()) {
          setAttempted(true);
          attempt.fail(discordVerifyFailure(error, t('profile.discord.verifyFailed')));
        }
      }
    })();
  };

  switch (view.kind) {
    case 'loading': {
      return (
        <View testID={ROW_TEST_ID}>
          <RowSkeleton tile subtitle />
        </View>
      );
    }
    case 'unlinked': {
      return (
        <ConfigureRow
          icon={Shield}
          title={t('profile.discord.title')}
          subtitle={t('profile.discord.linkPrompt')}
          hue="moss"
          testID={ROW_TEST_ID}
          onPress={() => {
            router.push(LOGIN_METHODS_HREF);
          }}
        />
      );
    }
    case 'member': {
      return (
        <ConfigureRow
          icon={ShieldCheck}
          title={t('profile.discord.memberTitle')}
          subtitle={t('profile.discord.memberSubtitle', {
            date: formatDate(parseTimestamp(view.verifiedAt), i18n.language),
          })}
          hue="moss"
          testID={ROW_TEST_ID}
        />
      );
    }
    case 'notMember': {
      return (
        <ConfigureRow
          icon={Shield}
          title={t('profile.discord.notMemberTitle')}
          subtitle={failureMessage ?? undefined}
          subtitleNumberOfLines={2}
          hue="moss"
          testID={ROW_TEST_ID}
          trailing={renderRowTrailing({
            kind: 'action',
            label: t(attempted ? 'profile.discord.reverify' : 'profile.discord.verify'),
            onPress: onVerify,
            disabled: verifying,
            accessibilityState: verifying ? { busy: true } : undefined,
          })}
        />
      );
    }
    case 'readFailed': {
      return (
        <ConfigureRow
          icon={Shield}
          title={t('profile.discord.title')}
          subtitle={failureMessage ?? t('profile.discord.loadFailed')}
          subtitleNumberOfLines={2}
          hue="moss"
          testID={ROW_TEST_ID}
          trailing={renderRowTrailing({
            kind: 'action',
            label: t('common.retry'),
            onPress: () => {
              void status.refetch();
            },
            disabled: status.isFetching,
          })}
        />
      );
    }
    default: {
      return assertSurfaceFailureHandled(view);
    }
  }
}

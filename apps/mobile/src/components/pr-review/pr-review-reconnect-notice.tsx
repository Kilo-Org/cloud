import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { useReviewerPermission } from '@/lib/hooks/use-reviewer-permission';
import {
  gitlabInstanceMismatch,
  selectPrReviewConnectAction,
} from '@/lib/pr-review/pr-review-connect-gate-view';
import { type ProviderPrPlatform, useProviderPrScopeOrNull } from '@/lib/pr-review/provider-pr-ref';
import { useCheckGitHubConnection } from '@/lib/pr-review/use-check-github-connection';
import { useCheckProviderConnection } from '@/lib/pr-review/use-check-provider-connection';
import { useReconnectHandoff } from '@/lib/pr-review/use-reconnect-handoff';

/**
 * The mid-session recovery notice for an expired provider connection. The
 * surface that caught the precondition failure renders it; this component
 * decides WHICH connection to re-check. A detail route publishes its provider
 * scope and this reads it — the GitHub route publishes none, so the GitHub arm
 * (and the original copy) is that fallback. A provider-neutral surface (the
 * merged inbox) has no route scope at all, so it passes the failing provider
 * and its organization explicitly. A GitLab or Bitbucket arm re-checks its own
 * integration status, because a GitHub retry can never fix an expired GitLab
 * connection.
 *
 * The notice also reports the settled outcome to the surface that owns the
 * latch: a check that ends with a connection able to serve the open item calls
 * `onConnectionRestored`. Failure stays the hook's own toast, so the notice
 * renders no error of its own.
 */
type PrReviewReconnectNoticeProps = {
  /**
   * The provider whose connection failed. Omitted on surfaces that publish a
   * route provider scope (the detail routes); the provider-neutral inbox has
   * no route scope, so it names the failing provider explicitly.
   */
  platform?: ProviderPrPlatform;
  /** The organization scope of that provider; null means the personal scope. */
  organizationId?: string | null;
  /**
   * Called once a check this notice started settles with a connection that can
   * serve the open item. Absent on surfaces whose latch the check does not
   * clear.
   */
  onConnectionRestored?: () => void;
  /**
   * Whether the mounting surface has no connect gate of its own, so a check
   * that leaves the connection unusable offers the reconnection here instead
   * of returning the reader to a card with nothing to press.
   */
  offerReconnect?: boolean;
};

type NoticeArm = { kind: 'check' } | { kind: 'reconnect' };

export function PrReviewReconnectNotice({
  platform: explicitPlatform,
  organizationId: explicitOrganizationId,
  onConnectionRestored,
  offerReconnect = false,
}: Readonly<PrReviewReconnectNoticeProps> = {}) {
  const connection = useCheckGitHubConnection();
  const providerConnection = useCheckProviderConnection();
  const scope = useProviderPrScopeOrNull();
  const platform = explicitPlatform ?? scope?.ref.platform ?? 'github';
  const organizationId =
    explicitOrganizationId !== undefined ? explicitOrganizationId : (scope?.organizationId ?? null);
  const providerPlatform = platform === 'github' ? null : platform;
  const [arm, setArm] = useState<NoticeArm>({ kind: 'check' });
  const { t } = useTranslation();

  let title = t('prReview.reconnectNotice.title');
  if (platform === 'gitlab') {
    title = t('prReview.reconnectNotice.gitlabTitle');
  } else if (platform === 'bitbucket') {
    title = t('prReview.reconnectNotice.bitbucketTitle');
  }
  // Both arms name their provider in the title above, so the description is
  // the same key on either side: the title says which connection expired and
  // the sentence below only says what to do about it.
  const message = t('prReview.reconnectNotice.message');

  function offerReconnectHere() {
    if (offerReconnect) {
      setArm({ kind: 'reconnect' });
    }
  }

  async function checkConnection() {
    try {
      if (!providerPlatform) {
        const answer = await connection.mutateAsync();
        if (answer.connected) {
          onConnectionRestored?.();
          return;
        }
        offerReconnectHere();
        return;
      }
      const status = await providerConnection.mutateAsync({
        platform: providerPlatform,
        organizationId,
      });
      if (!status.connected) {
        offerReconnectHere();
        return;
      }
      // A connected GitLab instance still cannot read a merge request that
      // lives on another instance, so that answer is not a usable connection
      // for this item: the server refuses the read exactly as the gate does.
      if (
        providerPlatform === 'gitlab' &&
        scope?.ref.platform === 'gitlab' &&
        gitlabInstanceMismatch({
          instanceHint: scope.ref.instanceHint,
          connectedInstanceUrl: status.instanceUrl ?? undefined,
        }) !== null
      ) {
        return;
      }
      onConnectionRestored?.();
    } catch {
      // The check's hook already toasts its failure, so the notice owns no
      // error of its own and a rejected check never reports a connection.
    }
  }

  return (
    <Card>
      <Text className="text-sm font-medium text-foreground">{title}</Text>
      <Text className="text-sm text-muted-foreground">{message}</Text>
      {arm.kind === 'reconnect' ? (
        <ReconnectOffer
          platform={platform}
          organizationId={organizationId}
          onRecheck={() => {
            void checkConnection();
          }}
        />
      ) : (
        <Button
          variant="outline"
          onPress={() => {
            void checkConnection();
          }}
          loading={providerPlatform ? providerConnection.isPending : connection.isPending}
          accessibilityLabel={t('prReview.checkConnection')}
        >
          <Text>{t('prReview.checkConnection')}</Text>
        </Button>
      )}
    </Card>
  );
}

/**
 * The offer a surface without its own connect gate shows once its check still
 * finds no usable connection. Which control it may show follows the providers'
 * one rule: Bitbucket Cloud is organization-context only, and an organization
 * connect is a billing-role action the server refuses for anyone else.
 */
function ReconnectOffer({
  platform,
  organizationId,
  onRecheck,
}: Readonly<{
  platform: ProviderPrPlatform;
  organizationId: string | null;
  onRecheck: () => void;
}>) {
  const { t } = useTranslation();
  const permission = useReviewerPermission(organizationId ?? PERSONAL_SCOPE);
  const handoff = useReconnectHandoff({
    platform,
    organizationId,
    onReturn: onRecheck,
  });

  if (platform === 'bitbucket' && organizationId === null) {
    return <Text variant="muted">{t('agentChat.newSession.bitbucketOrganizationsOnly')}</Text>;
  }

  if (platform !== 'github') {
    const action = selectPrReviewConnectAction({
      platform,
      view: 'reconnect',
      organizationId,
      canManageOrganizationBilling: permission.status === 'ready' ? permission.canEdit : null,
    });
    if (action === 'organization-admin-only') {
      return (
        <Text variant="muted">
          {platform === 'gitlab'
            ? t('prReview.connect.reconnectAdminOnlyDescription')
            : t('prReview.connect.bitbucketAdminOnlyDescription')}
        </Text>
      );
    }
  }

  let label = t('prReview.connect.reconnectTitle');
  if (platform === 'gitlab') {
    label = t('prReview.connect.reconnectTitleGitLab');
  } else if (platform === 'bitbucket') {
    label = t('prReview.connect.reconnectTitleBitbucket');
  }

  return (
    <Button
      className="w-full"
      loading={handoff.busy}
      disabled={handoff.busy}
      onPress={() => {
        handoff.reconnect();
      }}
    >
      <Text>{label}</Text>
    </Button>
  );
}

import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';
import { type CodeReviewActionRequiredReason } from '@kilocode/app-shared/code-review';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { ACTION_REQUIRED_KEYS } from '@/components/code-reviewer/action-required-keys';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { providerKeyScope, providerKeysHref } from '@/lib/byok/provider-key-scope';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { getGitLabIntegrationUrl } from '@/lib/integration-urls';
import {
  openAuthorizationAndWaitForReturn,
  reportLateLaunchFailure,
} from '@/lib/pr-review/connect-gate-platform';
import { trpcClient } from '@/lib/trpc';

// Where each reason's recovery label takes the user. Every destination exists:
// the two GitHub App reasons and the GitLab reason reuse the integration pages
// the reviewer and integrations screens already open, BYOK opens the app's
// provider-keys screen for the scope, and the reviewer's model is edited in
// place on this screen.
type RecoveryKind = 'github-app' | 'gitlab-integration' | 'byok' | 'model' | 'support';

const RECOVERY_KIND = {
  github_installation_required: 'github-app',
  github_ip_allow_list: 'support',
  gitlab_project_access_required: 'gitlab-integration',
  byok_invalid_key: 'byok',
  selected_model_unavailable: 'model',
  repeated_repository_clone_timeout: 'support',
} satisfies Record<CodeReviewActionRequiredReason, RecoveryKind>;

/**
 * The needs-attention banner for a reviewer the server disabled. The recovery
 * label is the instruction's control: pressing it opens the fix for that
 * reason, and coming back re-reads the config so a fixed reviewer clears the
 * banner — from the browser for the integration reasons, and on the next focus
 * of this screen for the key edited in the app. A member who cannot edit the
 * config keeps the label as plain text — the screen's who-can-fix note explains
 * who can act.
 */
export function ActionRequiredBanner({
  scope,
  reason,
  canEdit,
  onRefreshConfig,
  onOpenModelPicker,
}: Readonly<{
  scope: string;
  reason: CodeReviewActionRequiredReason;
  canEdit: boolean;
  onRefreshConfig: () => void;
  onOpenModelPicker: () => void;
}>) {
  const { t } = useTranslation();
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const keys = ACTION_REQUIRED_KEYS[reason];
  const recoveryLabel = t(keys.recoveryLabel);
  const organizationId = scope === PERSONAL_SCOPE ? undefined : scope;

  // The key is fixed on the app's provider-keys screen, so nothing leaves the
  // app and there is no browser return to wait on. The banner records the push
  // and reads the config again when this screen regains focus, which is the
  // moment a fixed key can clear it. The callback goes through a ref so the
  // focus effect does not resubscribe on every render of the parent's arrow.
  const awaitingFixRef = useRef(false);
  const refreshConfigRef = useRef(onRefreshConfig);
  refreshConfigRef.current = onRefreshConfig;
  useFocusEffect(
    useCallback(() => {
      if (!awaitingFixRef.current) {
        return;
      }
      awaitingFixRef.current = false;
      refreshConfigRef.current();
    }, [])
  );

  const recoveryUrl = async () => {
    const kind = RECOVERY_KIND[reason];
    if (kind === 'github-app') {
      try {
        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
          organizationId,
          returnTo: '/cloud/sessions',
        });
        return getGitHubIntegrationUrl(WEB_BASE_URL, organizationId, token);
      } catch {
        // Minting needs owner/admin rights, which are narrower than the edit
        // permission that shows this control, and an organization that already
        // has an installation refuses a second one. The integration page still
        // opens the install/manage flow, so the label never becomes a dead end.
        return getGitHubIntegrationUrl(WEB_BASE_URL, organizationId);
      }
    }
    return getGitLabIntegrationUrl(WEB_BASE_URL, organizationId);
  };

  const openBrowser = async () => {
    setOpening(true);
    try {
      const url = await recoveryUrl();
      const wait = await openAuthorizationAndWaitForReturn(url);
      // A launch that fails after the app's own return edge ended the wait never
      // reaches the catch below, and the user saw no browser.
      reportLateLaunchFailure(wait, {
        onFailure: () => {
          toast.error(t('authErrors.couldNotOpenBrowser'));
        },
      });
      // Back from the browser: the fix may be in place, so re-read the config.
      onRefreshConfig();
    } catch {
      toast.error(t('authErrors.couldNotOpenBrowser'));
    } finally {
      setOpening(false);
    }
  };

  const recover = async () => {
    const kind = RECOVERY_KIND[reason];
    if (kind === 'model') {
      onOpenModelPicker();
      return;
    }
    if (kind === 'support') {
      await openExternalUrl(`mailto:${SUPPORT_EMAIL}`, { label: SUPPORT_EMAIL });
      return;
    }
    if (kind === 'byok') {
      awaitingFixRef.current = true;
      router.push(providerKeysHref(providerKeyScope(organizationId)));
      return;
    }
    await openBrowser();
  };

  return (
    <View className="rounded-lg bg-warn-tile-bg p-4">
      <Text className="text-sm font-medium">{t(keys.title)}</Text>
      <Text variant="muted" className="text-xs">
        {t(keys.description)}
      </Text>
      {canEdit ? (
        <Button
          variant="link"
          size="sm"
          className="mt-1 self-start px-0"
          accessibilityLabel={recoveryLabel}
          disabled={opening}
          onPress={recover}
        >
          <Text>{recoveryLabel}</Text>
        </Button>
      ) : (
        <Text className="mt-1 text-xs font-medium">{recoveryLabel}</Text>
      )}
    </View>
  );
}

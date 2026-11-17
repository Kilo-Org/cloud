import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import {
  BITBUCKET_TOKEN_MAX_LENGTH,
  bitbucketConnectionFailure,
  type BitbucketFailure,
  readBitbucketToken,
} from '@/lib/code-reviewer-bitbucket';
import { openExternalUrl } from '@/lib/external-link';
import { useConnectBitbucket, useReplaceBitbucketToken } from '@/lib/hooks/use-bitbucket';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';

/** Where Bitbucket sends a workspace admin to mint the token Kilo asks for. */
const CREATE_WORKSPACE_TOKEN_URL =
  'https://support.atlassian.com/bitbucket-cloud/docs/create-a-workspace-access-token/';

/**
 * The token a person pastes. `integrationId` decides whether this creates the
 * organizations's connection or replaces the token of the one it already has,
 * because `connect` refuses a second integration for the same organization.
 */
export function BitbucketConnectForm({
  scope,
  integrationId,
  onConnected,
}: Readonly<{
  scope: string;
  integrationId: string | null;
  onConnected: () => void;
}>) {
  const { t } = useTranslation();
  // iOS never lets a controlled `value` hold the caret, so the token lives in a
  // ref and the state below only tracks whether submit can run.
  const tokenRef = useRef('');
  const [hasToken, setHasToken] = useState(false);
  const { feedback, begin, clearWhere } = useSurfaceFeedback<BitbucketFailure>();
  const connect = useConnectBitbucket(scope);
  const replaceToken = useReplaceBitbucketToken(scope);
  const submitting = feedback.status === 'pending';

  const onSubmit = () => {
    const field = readBitbucketToken(tokenRef.current);
    if (field.kind !== 'ready') {
      return;
    }
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    // The sheet closes on success, so the outcome is its dismissal rather than a
    // phase this form keeps rendering.
    void (async () => {
      try {
        await (integrationId === null
          ? connect.mutateAsync({ accessToken: field.token })
          : replaceToken.mutateAsync({ integrationId, accessToken: field.token }));
        if (attempt.owns()) {
          attempt.abandon();
          onConnected();
        }
      } catch (error) {
        if (attempt.owns()) {
          attempt.fail(bitbucketConnectionFailure(error, t));
        }
      }
    })();
  };

  const failure = feedback.status === 'failed' ? feedback.failure : null;
  // A refused token is worth another submit once a different one is pasted; a
  // lost role or a changed connection is not, so submit waits for a reopen.
  const blockedByFailure = failure !== null && !repairNeedsAnotherToken(failure.kind);

  return (
    <View className="gap-5">
      <View className="gap-2">
        <Text variant="muted" className="text-sm">
          {t('codeReviewer.bitbucketConnect.description')}
        </Text>
        <Text variant="muted" className="text-sm">
          {t('codeReviewer.bitbucketConnect.scopes')}
        </Text>
      </View>

      <Button
        variant="outline"
        size="sm"
        onPress={() => {
          void openExternalUrl(CREATE_WORKSPACE_TOKEN_URL, {
            label: t('common.openInBrowser'),
          });
        }}
      >
        <Text>{t('common.openInBrowser')}</Text>
      </Button>

      <FormField
        label={t('codeReviewer.bitbucketConnect.tokenPlaceholder')}
        required
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={BITBUCKET_TOKEN_MAX_LENGTH}
        disabled={submitting}
        onChangeText={value => {
          tokenRef.current = value;
          setHasToken(readBitbucketToken(value).kind === 'ready');
          // Only a failure another token can repair is what a new one answers;
          // a lost role or a connection that changed underneath keeps the submit
          // disabled until the sheet is reopened.
          clearWhere(settled => repairNeedsAnotherToken(settled.kind));
        }}
      />

      <AccessibleStatus message={failure?.message ?? null} className="text-sm" />

      {failure?.kind === 'connection-changed' ? (
        <Text variant="muted" className="text-sm">
          {t('codeReviewer.bitbucketConnect.managedOnWeb')}
        </Text>
      ) : null}

      <Button
        disabled={submitting || !hasToken || blockedByFailure}
        loading={submitting}
        onPress={onSubmit}
      >
        <Text>
          {integrationId === null
            ? t('common.connect')
            : t('prReview.connect.reconnectTitleBitbucket')}
        </Text>
      </Button>
    </View>
  );
}

/**
 * Whether the failure leaves this form a next step: a rejected token can be
 * replaced in the field below. Neither other kind can, so an edit keeps them on
 * screen: a lost role needs the sheet reopened with one, and a connection that
 * changed underneath is managed on the page beside its message.
 */
function repairNeedsAnotherToken(kind: BitbucketFailure['kind']): boolean {
  switch (kind) {
    case 'token-refused':
    case 'retryable': {
      return true;
    }
    case 'role-refused':
    case 'connection-changed': {
      return false;
    }
    default: {
      return assertSurfaceFailureHandled(kind);
    }
  }
}

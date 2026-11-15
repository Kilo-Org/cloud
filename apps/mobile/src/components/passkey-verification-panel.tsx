import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { type PasskeyVerificationState } from '@/lib/passkeys/passkey-verification-state';

type Props = {
  state: Exclude<PasskeyVerificationState, { phase: 'closed' }>;
  onChoosePasskey: () => void;
  onChooseEmail: () => void;
  onChooseSso: () => void;
  onReopenApproval: () => void;
  onSubmitCode: (code: string) => void;
  onResendCode: () => void;
  onCancel: () => void;
};

/**
 * Fresh primary verification for passkey management, in the app.
 *
 * The panel is the screen's explanation for why a change needs the person's
 * own sign-in factor right now, and the place that proof is given: a passkey
 * when the account has one, or a code to the address the account already owns.
 * It renders from one phase union, so exactly one set of controls is live, and
 * every phase keeps the same card, title and explanation, so the panel does not
 * jump as the attempt moves between phases.
 */
export function PasskeyVerificationPanel({
  state,
  onChoosePasskey,
  onChooseEmail,
  onChooseSso,
  onReopenApproval,
  onSubmitCode,
  onResendCode,
  onCancel,
}: Readonly<Props>) {
  const { t } = useTranslation();

  return (
    <View className="gap-3 rounded-lg border border-border bg-card p-3">
      <Text className="text-base font-semibold">{t('profile.passkeyVerifyTitle')}</Text>
      <Text className="text-sm text-muted-foreground">{t('profile.passkeyVerifyDescription')}</Text>

      {state.phase === 'choose' && (
        <>
          {state.notice && (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {t(state.notice)}
            </Text>
          )}
          {state.passkeyOffered && (
            <Button onPress={onChoosePasskey}>
              <Text>{t('profile.passkeyVerifyWithPasskey')}</Text>
            </Button>
          )}
          <Button variant={state.passkeyOffered ? 'outline' : 'default'} onPress={onChooseEmail}>
            <Text>{t('profile.passkeyVerifySendCode')}</Text>
          </Button>
          <Button variant="outline" onPress={onCancel}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </>
      )}

      {state.phase === 'sending-code' && (
        <>
          {/* The pending control holds the slot its answer takes, so the panel
              does not resize between asking for a code and offering the field. */}
          <Button loading disabled>
            <Text>{t('profile.passkeyVerifySendingCode')}</Text>
          </Button>
          <Button variant="outline" onPress={onCancel}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </>
      )}

      {state.phase === 'asserting' && (
        <>
          <Text className="text-sm text-muted-foreground">
            {t('profile.passkeyVerifyPasskeyPrompt')}
          </Text>
          <Button variant="outline" onPress={onCancel}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </>
      )}

      {state.phase === 'authorizing' && (
        <>
          <Button loading disabled>
            <Text>{t('profile.passkeyVerifyChecking')}</Text>
          </Button>
        </>
      )}

      {state.phase === 'sso-starting' && (
        <>
          <Button loading disabled>
            <Text>{t('profile.passkeyVerifySsoStarting')}</Text>
          </Button>
          <Button variant="outline" onPress={onCancel}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </>
      )}

      {state.phase === 'sso-approval' && (
        <>
          <Text className="text-sm text-muted-foreground">
            {t('profile.passkeyVerifySsoRequired')}
          </Text>
          {state.error ? (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {t(state.error)}
            </Text>
          ) : (
            state.waiting && (
              <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
                {t('profile.passkeyVerifySsoWaiting')}
              </Text>
            )
          )}
          {state.approvalUrl !== '' && (
            <Button variant="outline" onPress={onReopenApproval}>
              <Text>{t('profile.passkeyVerifySsoOpen')}</Text>
            </Button>
          )}
          {state.error && (
            <Button onPress={onChooseSso}>
              <Text>{t('common.retry')}</Text>
            </Button>
          )}
          <Button variant="outline" onPress={onCancel}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </>
      )}

      {state.phase === 'enter-code' && (
        <CodeEntry
          email={state.email}
          error={state.error === null ? undefined : t(state.error)}
          retrying={state.retrying}
          onSubmit={onSubmitCode}
          onResend={onResendCode}
          onCancel={onCancel}
        />
      )}

      {state.phase === 'blocked' && (
        <>
          <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
            {t(state.message)}
          </Text>
          <Button variant="outline" onPress={onCancel}>
            <Text>{t('common.close')}</Text>
          </Button>
        </>
      )}
    </View>
  );
}

/**
 * The emailed-code step: one field, its submit, and the two ways out — send a
 * new code, or stop. The field is uncontrolled (apps/mobile/AGENTS.md): the
 * text lives in a ref and only the derived submit enablement is state.
 */
function CodeEntry({
  email,
  error,
  retrying,
  onSubmit,
  onResend,
  onCancel,
}: Readonly<{
  email: string;
  error: string | undefined;
  retrying: boolean;
  onSubmit: (code: string) => void;
  onResend: () => void;
  onCancel: () => void;
}>) {
  const { t } = useTranslation();
  const codeRef = useRef('');
  const [canSubmit, setCanSubmit] = useState(false);

  return (
    <>
      <Text className="text-sm text-muted-foreground">
        {t('profile.passkeyVerifyCodeSent', { email })}
      </Text>
      <FormField
        label={t('profile.confirmationCode')}
        placeholder={t('profile.confirmationCodePlaceholder')}
        keyboardType="number-pad"
        // Android only: keep the IME docked to the number pad instead of its
        // full-screen extract editor, which would cover the controls below.
        disableFullscreenUI
        error={error}
        editable={!retrying}
        onChangeText={value => {
          codeRef.current = value;
          setCanSubmit(value.trim().length > 0);
        }}
      />
      <Button
        loading={retrying}
        disabled={retrying || !canSubmit}
        onPress={() => {
          onSubmit(codeRef.current);
        }}
      >
        <Text>{t('login.verifyCode')}</Text>
      </Button>
      <Button variant="outline" disabled={retrying} onPress={onResend}>
        <Text>{t('login.resendCode')}</Text>
      </Button>
      <Button variant="outline" disabled={retrying} onPress={onCancel}>
        <Text>{t('common.cancel')}</Text>
      </Button>
    </>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ProviderButtons } from '@/components/login/provider-buttons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type PendingLinkOffer } from '@/lib/auth/native-auth-contract';
import {
  type PendingLinkFailure,
  type PendingLinkOptions,
  resolvePendingLinkView,
} from '@/lib/auth/pending-link';
import { providerLabel } from '@/lib/auth/provider-label';
import { type BusyAction } from '@/lib/auth/use-native-auth';

/** True from `expiresAt` on. The caller keys the screen by offer, so one timer serves one offer. */
function useExpired(expiresAt: number): boolean {
  const [expired, setExpired] = useState(() => Date.now() >= expiresAt);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setExpired(true);
      },
      Math.max(0, expiresAt - Date.now())
    );
    return () => {
      clearTimeout(timer);
    };
  }, [expiresAt]);
  return expired;
}

/**
 * The account that owns the new sign-in's email has to prove itself before the new provider is
 * attached: every control here signs in to that account with the pending link's token. An
 * expired link, or one no control can resolve, leaves only Start again.
 */
export function PendingLinkAuth({
  offer,
  options,
  busy,
  browserStarting,
  refused,
  failure,
  onApple,
  onGoogle,
  onPasskey,
  onEmailCode,
  onBrowser,
  onStartAgain,
}: Readonly<{
  offer: PendingLinkOffer;
  options: PendingLinkOptions;
  busy: BusyAction;
  browserStarting: boolean;
  /** The server already refused this link as no longer live, ahead of `expiresAt`. */
  refused: boolean;
  failure: PendingLinkFailure | undefined;
  onApple: () => void;
  onGoogle: () => void;
  onPasskey: () => void;
  onEmailCode: () => void;
  onBrowser: () => void;
  onStartAgain: () => void;
}>) {
  const { t } = useTranslation();
  const expired = useExpired(offer.expiresAt) || refused;
  const view = resolvePendingLinkView({ offer, options, expired, failure });
  const disabled = busy !== undefined || browserStarting;

  if (view.kind !== 'options') {
    return (
      <View className="gap-3">
        <Text className="text-center" accessibilityLiveRegion="polite">
          {view.message}
        </Text>
        <Button
          size="lg"
          disabled={disabled}
          onPress={onStartAgain}
          accessibilityLabel={t('pendingLink.startAgain')}
        >
          <Text className="text-[17px]">{t('pendingLink.startAgain')}</Text>
        </Button>
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Text className="text-center">
        {t('pendingLink.description', {
          email: offer.email,
          provider: providerLabel(offer.provider),
        })}
      </Text>
      {view.error ? (
        <Text className="text-center text-sm text-destructive" accessibilityLiveRegion="polite">
          {view.error}
        </Text>
      ) : null}
      <ProviderButtons
        showApple={options.apple}
        showGoogle={options.google}
        showPasskey={options.passkey}
        busy={busy}
        disabled={disabled}
        onApple={onApple}
        onGoogle={onGoogle}
        onPasskey={onPasskey}
      />
      {options.emailCode && (
        <Button
          variant="outline"
          size="lg"
          disabled={disabled}
          loading={busy === 'otp-send'}
          onPress={onEmailCode}
          accessibilityLabel={t('pendingLink.emailCode')}
        >
          <Text className="text-[17px] font-medium">{t('pendingLink.emailCode')}</Text>
        </Button>
      )}
      {options.browser && (
        <Button
          variant="outline"
          size="lg"
          disabled={disabled}
          loading={browserStarting}
          onPress={onBrowser}
          accessibilityLabel={t('pendingLink.continueInBrowser')}
        >
          <Text className="text-[17px] font-medium">{t('pendingLink.continueInBrowser')}</Text>
        </Button>
      )}
      <Button
        variant="ghost"
        disabled={disabled}
        onPress={onStartAgain}
        accessibilityLabel={t('pendingLink.startAgain')}
      >
        <Text>{t('pendingLink.startAgain')}</Text>
      </Button>
    </View>
  );
}

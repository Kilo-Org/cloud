import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { SshPublicKeyBlock } from '@/components/ssh/public-key-block';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { setCreatedKeyId } from '@/lib/ssh/created-key';
import { generatedKeyInput } from '@/lib/ssh/key-input';
import { sshPackage } from '@/lib/ssh/native';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { useSshKeyMutations } from '@/lib/ssh/use-ssh';

type GeneratedState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'generating' }
  | { readonly kind: 'ready'; readonly publicKey: string; readonly fingerprint: string }
  | { readonly kind: 'failed' };

/** Generates an ed25519 key in the native core and stores it on this device. */
export function SshKeyCreateScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const label = useRef('');
  const { create } = useSshKeyMutations();
  const [state, setState] = useState<GeneratedState>({ kind: 'idle' });
  // The screen can be left while the native key generation is still running;
  // a result that arrives afterwards has no screen to render it.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );

  const busy = state.kind === 'generating' || create.isPending;

  function leave() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(SSH_HOSTS_ROUTE);
  }

  async function generate() {
    setState({ kind: 'generating' });
    try {
      const ssh = await sshPackage();
      const name = label.current.trim() || t('ssh.editor.key');
      const generated = await ssh.default.generateEd25519Key(name);
      const created = await create.mutateAsync(generatedKeyInput(name, generated));
      // The created key still reaches the editor that pushed this screen, even
      // when this screen has already gone.
      setCreatedKeyId(created.id);
      if (!alive.current) {
        return;
      }
      setState({
        kind: 'ready',
        publicKey: generated.publicKeyOpenssh,
        fingerprint: generated.fingerprintSha256,
      });
    } catch {
      if (alive.current) {
        setState({ kind: 'failed' });
      }
    }
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={state.kind === 'ready' ? t('ssh.keys.createdTitle') : t('ssh.keys.generateTitle')}
        backFallback={SSH_HOSTS_ROUTE}
      />
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-sm text-muted-foreground">
          {state.kind === 'ready'
            ? t('ssh.keys.createdDescription')
            : t('ssh.keys.generateDescription')}
        </Text>
        {state.kind === 'ready' ? (
          <SshPublicKeyBlock
            name={label.current}
            publicKey={state.publicKey}
            fingerprint={state.fingerprint}
          />
        ) : (
          <FormField
            label={t('ssh.keys.name')}
            placeholder={t('ssh.editor.key')}
            defaultValue=""
            disabled={busy}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={value => {
              label.current = value;
            }}
          />
        )}
      </DetailScreenScrollView>
      <View className="gap-2 px-4 pb-4 pt-3">
        {state.kind === 'ready' ? (
          <Button className={STATE_ACTION_CLASS} onPress={leave}>
            <Text>{t('common.done')}</Text>
          </Button>
        ) : (
          <Button
            className={STATE_ACTION_CLASS}
            loading={busy}
            disabled={busy}
            onPress={() => void generate()}
          >
            <Text>{state.kind === 'failed' ? t('common.tryAgain') : t('ssh.keys.generate')}</Text>
          </Button>
        )}
      </View>
    </View>
  );
}

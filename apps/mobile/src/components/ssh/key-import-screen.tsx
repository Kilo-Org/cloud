import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput, View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { SshPublicKeyBlock } from '@/components/ssh/public-key-block';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { FileText } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { setCreatedKeyId } from '@/lib/ssh/created-key';
import { importedKeyInput } from '@/lib/ssh/key-input';
import { nativeErrorCode, sshPackage } from '@/lib/ssh/native';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { useSshKeyMutations } from '@/lib/ssh/use-ssh';

const PEM_LINES = 8;

type ImportState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'needsPassphrase' }
  | { readonly kind: 'ready'; readonly publicKey: string; readonly fingerprint: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Reads an OpenSSH or PEM private key with the native core and stores it.
 *
 * The passphrase field only appears once the core has said the key is
 * encrypted: asking for one up front would be a guess, and a wrong guess is
 * indistinguishable from a wrong key until it is tried.
 */
export function SshKeyImportScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { create } = useSshKeyMutations();
  const pemRef = useRef('');
  const labelRef = useRef('');
  const passphraseRef = useRef('');
  const inputRef = useRef<TextInput | null>(null);
  const [hasText, setHasText] = useState(false);
  const [state, setState] = useState<ImportState>({ kind: 'idle' });

  const busy = state.kind === 'busy' || create.isPending;

  function leave() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(SSH_HOSTS_ROUTE);
  }

  async function pickFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: '*/*',
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset === undefined) {
        return;
      }
      const text = await new File(asset.uri).text();
      pemRef.current = text;
      inputRef.current?.setNativeProps({ text });
      setHasText(text.trim().length > 0);
      setState({ kind: 'idle' });
    } catch {
      setState({ kind: 'failed', message: t('ssh.import.unreadableFile') });
    }
  }

  async function runImport() {
    const pem = pemRef.current.trim();
    if (pem.length === 0) {
      return;
    }
    setState({ kind: 'busy' });
    try {
      const ssh = await sshPackage();
      const passphrase = passphraseRef.current.length === 0 ? null : passphraseRef.current;
      const parsed = ssh.parsePrivateKey(pem, passphrase ?? undefined);
      const name = labelRef.current.trim() || t('ssh.editor.key');
      const created = await create.mutateAsync(
        importedKeyInput({ label: name, pem, parsed, passphrase })
      );
      setCreatedKeyId(created.id);
      setState({
        kind: 'ready',
        publicKey: created.publicKeyOpenssh,
        fingerprint: created.fingerprintSha256,
      });
    } catch (error) {
      if (nativeErrorCode(error) === 'WrongPassphrase') {
        setState({ kind: 'needsPassphrase' });
        return;
      }
      setState({
        kind: 'failed',
        message: t(
          nativeErrorCode(error) === 'UnsupportedAlgorithm'
            ? 'ssh.keys.unsupported'
            : 'ssh.keys.unreadable'
        ),
      });
    }
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('ssh.keys.importTitle')} backFallback={SSH_HOSTS_ROUTE} />
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-sm text-muted-foreground">{t('ssh.keys.importDescription')}</Text>
        {state.kind === 'ready' ? (
          <SshPublicKeyBlock publicKey={state.publicKey} fingerprint={state.fingerprint} />
        ) : (
          <>
            <FormField
              label={t('ssh.keys.name')}
              placeholder={t('ssh.editor.key')}
              defaultValue=""
              disabled={busy}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={value => {
                labelRef.current = value;
              }}
            />
            <View className="gap-1.5">
              <FormFieldLabel label={t('ssh.editor.privateKey')} />
              <Input
                ref={inputRef}
                multiline
                numberOfLines={PEM_LINES}
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-[140px] rounded-md border border-input bg-background text-sm text-foreground dark:bg-[#FFFFFF0A]"
                onChangeText={value => {
                  pemRef.current = value;
                  setHasText(value.trim().length > 0);
                  setState({ kind: 'idle' });
                }}
              />
            </View>
            {state.kind === 'needsPassphrase' ? (
              <FormField
                label={t('ssh.session.passphrase')}
                placeholder={t('ssh.session.passphrase')}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                disabled={busy}
                error={t('ssh.session.reason.wrongPassphrase')}
                onChangeText={value => {
                  passphraseRef.current = value;
                }}
              />
            ) : null}
            <AccessibleStatus
              message={state.kind === 'failed' ? state.message : null}
              className="text-sm"
            />
            <Button
              variant="outline"
              className={STATE_ACTION_CLASS}
              disabled={busy}
              onPress={() => void pickFile()}
            >
              <FileText size={16} />
              <Text>{t('ssh.import.chooseFile')}</Text>
            </Button>
          </>
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
            disabled={busy || !hasText}
            onPress={() => void runImport()}
          >
            <Text>
              {state.kind === 'needsPassphrase' || state.kind === 'failed'
                ? t('common.tryAgain')
                : t('ssh.keys.import')}
            </Text>
          </Button>
        )}
      </View>
    </View>
  );
}

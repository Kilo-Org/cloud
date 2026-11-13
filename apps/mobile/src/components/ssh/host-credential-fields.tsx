import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PickerField } from '@/components/ssh/picker-field';
import { SwitchField } from '@/components/ssh/switch-field';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type SshKey } from '@/lib/ssh/keys';
import { SSH_KEY_IMPORT_ROUTE, SSH_KEY_NEW_ROUTE } from '@/lib/ssh/routes';
import { cn } from '@/lib/utils';

type HostPasswordFieldsProps = Readonly<{
  /** What the host holds today; the field keeps later edits in its own ref. */
  password: string;
  savePassword: boolean;
  disabled: boolean;
  onPasswordChange: (value: string) => void;
  onSavePasswordChange: (save: boolean) => void;
}>;

/** The password a host signs in with, and whether the device keeps it. */
export function HostPasswordFields({
  password,
  savePassword,
  disabled,
  onPasswordChange,
  onSavePasswordChange,
}: HostPasswordFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
      <FormField
        label={t('ssh.editor.password')}
        placeholder={t('ssh.editor.passwordPlaceholder')}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="password"
        defaultValue={password}
        disabled={disabled}
        onChangeText={onPasswordChange}
      />
      <SwitchField
        label={t('ssh.editor.savePassword')}
        hint={t('ssh.editor.savePasswordHint')}
        value={savePassword}
        onValueChange={onSavePasswordChange}
      />
    </>
  );
}

type HostKeyFieldsProps = Readonly<{
  keys: readonly SshKey[];
  selectedKey: SshKey | null;
  disabled: boolean;
  onChoose: () => void;
}>;

/**
 * The key a host signs in with, and the two screens that put one in the store.
 * They push over the editor, so the editor picks the new key up when focus
 * returns (`takeCreatedKeyId`).
 */
export function HostKeyFields({ keys, selectedKey, disabled, onChoose }: HostKeyFieldsProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const none = keys.length === 0;

  return (
    <>
      <PickerField
        label={t('ssh.editor.privateKey')}
        value={none ? t('ssh.editor.noKeys') : (selectedKey?.label ?? null)}
        placeholder={t('ssh.editor.chooseKey')}
        disabled={none || disabled}
        onPress={onChoose}
      />
      <View className="flex-row gap-2">
        <Button
          variant="outline"
          className={cn(STATE_ACTION_CLASS, 'flex-1')}
          disabled={disabled}
          onPress={() => {
            router.push(SSH_KEY_NEW_ROUTE);
          }}
        >
          <Text>{t('ssh.keys.generate')}</Text>
        </Button>
        <Button
          variant="outline"
          className={cn(STATE_ACTION_CLASS, 'flex-1')}
          disabled={disabled}
          onPress={() => {
            router.push(SSH_KEY_IMPORT_ROUTE);
          }}
        >
          <Text>{t('ssh.keys.import')}</Text>
        </Button>
      </View>
    </>
  );
}

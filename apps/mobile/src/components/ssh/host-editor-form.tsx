import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { PickerField } from '@/components/ssh/picker-field';
import { SwitchField } from '@/components/ssh/switch-field';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { MenuSheet, type MenuSheetOption } from '@/components/ui/menu-sheet';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import {
  type HostFormErrorKind,
  type HostFormIssue,
  hostFormIssue,
  hostFormValuesOf,
  jumpHostCandidates,
  type SshAuthMethod,
  toHostInput,
  validateHostInput,
} from '@/lib/ssh/host-form';
import { type SshHost, type SshHostInput, SshJumpHostCycleError } from '@/lib/ssh/hosts';
import { type SshKey } from '@/lib/ssh/keys';

type HostEditorFormProps = Readonly<{
  host: SshHost | null;
  /** Every stored host; the jump picker offers all but this one. */
  hosts: readonly SshHost[];
  keys: readonly SshKey[];
  saving: boolean;
  /** The store's refusal of the last save, when it refused one. */
  saveError?: unknown;
  onSubmit: (input: SshHostInput) => void;
}>;

type OpenPicker = 'key' | 'jump' | null;

export function HostEditorForm({
  host,
  hosts,
  keys,
  saving,
  saveError,
  onSubmit,
}: HostEditorFormProps) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const initial = hostFormValuesOf(host);

  // iOS: the text lives in the ref its field writes to; state only holds what
  // the layout and the choices show (apps/mobile/AGENTS.md).
  const labelRef = useRef(initial.label);
  const hostnameRef = useRef(initial.hostname);
  const portRef = useRef(initial.portText);
  const usernameRef = useRef(initial.username);
  const passwordRef = useRef(initial.password);
  const sessionRef = useRef(initial.tmuxSessionName);

  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(initial.authMethod);
  const [savePassword, setSavePassword] = useState(initial.savePassword);
  const [keyId, setKeyId] = useState<string | null>(initial.keyId);
  const [jumpHostId, setJumpHostId] = useState<string | null>(initial.jumpHostId);
  const [tmuxAttach, setTmuxAttach] = useState(initial.tmuxAttach);
  const [issues, setIssues] = useState<readonly HostFormIssue[]>([]);
  const [picker, setPicker] = useState<OpenPicker>(null);

  const jumpCycle = saveError instanceof SshJumpHostCycleError;
  const otherHosts = jumpHostCandidates(hosts, host?.id ?? null);
  const selectedKey = keys.find(key => key.id === keyId) ?? null;
  const selectedJump = otherHosts.find(candidate => candidate.id === jumpHostId) ?? null;

  function errorMessage(kind: HostFormErrorKind | undefined): string | undefined {
    if (kind === undefined) {
      return undefined;
    }
    return kind === 'invalidPort' ? t('ssh.errors.invalidPort') : t('profiles.valueRequired');
  }

  const authOptions: { value: SshAuthMethod; label: string }[] = [
    { value: 'password', label: t('ssh.editor.password') },
    { value: 'key', label: t('ssh.editor.key') },
    { value: 'keyboard_interactive', label: t('ssh.editor.interactive') },
  ];

  const jumpOptions: MenuSheetOption[] = [
    { label: t('ssh.editor.directConnection'), selected: jumpHostId === null },
    ...otherHosts.map(candidate => ({
      label: candidate.label,
      selected: candidate.id === jumpHostId,
    })),
  ];

  const keyOptions: MenuSheetOption[] = keys.map(key => ({
    label: key.label,
    selected: key.id === keyId,
  }));

  function save() {
    const input = toHostInput({
      label: labelRef.current,
      hostname: hostnameRef.current,
      portText: portRef.current,
      username: usernameRef.current,
      authMethod,
      password: passwordRef.current,
      savePassword,
      keyId,
      jumpHostId,
      tmuxAttach,
      tmuxSessionName: sessionRef.current,
    });
    const found = validateHostInput(input);
    setIssues(found);
    if (found.length > 0) {
      return;
    }
    onSubmit(input);
  }

  return (
    <>
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <FormField
          label={t('ssh.editor.label')}
          placeholder={t('ssh.editor.labelPlaceholder')}
          defaultValue={initial.label}
          disabled={saving}
          error={errorMessage(hostFormIssue(issues, 'label'))}
          onChangeText={value => {
            labelRef.current = value;
          }}
        />
        <FormField
          label={t('ssh.editor.hostname')}
          placeholder={t('ssh.editor.hostnamePlaceholder')}
          defaultValue={initial.hostname}
          disabled={saving}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          error={errorMessage(hostFormIssue(issues, 'hostname'))}
          onChangeText={value => {
            hostnameRef.current = value;
          }}
        />
        <FormField
          label={t('ssh.editor.port')}
          defaultValue={initial.portText}
          disabled={saving}
          keyboardType="number-pad"
          maxLength={5}
          error={errorMessage(hostFormIssue(issues, 'port'))}
          onChangeText={value => {
            portRef.current = value;
          }}
        />
        <FormField
          label={t('ssh.editor.username')}
          defaultValue={initial.username}
          disabled={saving}
          autoCapitalize="none"
          autoCorrect={false}
          error={errorMessage(hostFormIssue(issues, 'username'))}
          onChangeText={value => {
            usernameRef.current = value;
          }}
        />

        <View className="gap-1.5">
          <FormFieldLabel label={t('ssh.editor.authMethod')} />
          <SegmentedControl
            accessibilityLabel={t('ssh.editor.authMethod')}
            options={authOptions}
            value={authMethod}
            onChange={setAuthMethod}
          />
        </View>

        {authMethod === 'password' ? (
          <>
            <FormField
              label={t('ssh.editor.password')}
              placeholder={t('ssh.editor.passwordPlaceholder')}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="password"
              defaultValue={initial.password}
              disabled={saving}
              onChangeText={value => {
                passwordRef.current = value;
              }}
            />
            <SwitchField
              label={t('ssh.editor.savePassword')}
              hint={t('ssh.editor.savePasswordHint')}
              value={savePassword}
              onValueChange={setSavePassword}
            />
          </>
        ) : null}

        {authMethod === 'key' ? (
          <PickerField
            label={t('profiles.keyLabel')}
            value={keys.length === 0 ? t('ssh.editor.noKeys') : (selectedKey?.label ?? null)}
            placeholder={t('ssh.editor.chooseKey')}
            disabled={keys.length === 0 || saving}
            onPress={() => {
              setPicker('key');
            }}
          />
        ) : null}

        <PickerField
          label={t('ssh.editor.jumpHost')}
          value={selectedJump?.label ?? t('ssh.editor.directConnection')}
          placeholder={t('ssh.editor.directConnection')}
          error={jumpCycle ? t('ssh.errors.jumpCycle') : undefined}
          disabled={saving}
          onPress={() => {
            setPicker('jump');
          }}
        />

        <SwitchField
          label={t('ssh.editor.tmuxAttach')}
          value={tmuxAttach}
          onValueChange={setTmuxAttach}
        />
        {tmuxAttach ? (
          <FormField
            label={t('ssh.editor.tmuxSession')}
            defaultValue={initial.tmuxSessionName}
            disabled={saving}
            autoCapitalize="none"
            autoCorrect={false}
            error={errorMessage(hostFormIssue(issues, 'tmuxSessionName'))}
            onChangeText={value => {
              sessionRef.current = value;
            }}
          />
        ) : null}
      </DetailScreenScrollView>

      <View className="gap-2 px-4 pt-3" style={{ paddingBottom: bottom + 16 }}>
        <AccessibleStatus
          message={saveError === undefined || jumpCycle ? null : t('ssh.editor.saveFailed')}
          className="text-sm"
        />
        <Button className={STATE_ACTION_CLASS} loading={saving} disabled={saving} onPress={save}>
          <Text>{t('common.save')}</Text>
        </Button>
      </View>

      <MenuSheet
        visible={picker === 'key'}
        title={t('ssh.editor.key')}
        options={keyOptions}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setPicker(null);
        }}
        onSelect={index => {
          const key = keys[index];
          if (key) {
            setKeyId(key.id);
          }
          setPicker(null);
        }}
      />

      <MenuSheet
        visible={picker === 'jump'}
        title={t('ssh.editor.jumpHost')}
        options={jumpOptions}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setPicker(null);
        }}
        onSelect={index => {
          if (index === 0) {
            setJumpHostId(null);
          } else {
            const candidate = otherHosts[index - 1];
            if (candidate) {
              setJumpHostId(candidate.id);
            }
          }
          setPicker(null);
        }}
      />
    </>
  );
}

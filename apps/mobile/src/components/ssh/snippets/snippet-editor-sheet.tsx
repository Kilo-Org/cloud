import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PickerField } from '@/components/ssh/picker-field';
import { SwitchField } from '@/components/ssh/switch-field';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { MenuSheet, type MenuSheetOption } from '@/components/ui/menu-sheet';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type SshHost } from '@/lib/ssh/hosts';
import { type SshSnippet } from '@/lib/ssh/snippets';

export type SnippetValues = Readonly<{
  label: string;
  command: string;
  appendNewline: boolean;
  /** The snippet's host, or null for one every host offers. */
  hostId: string | null;
}>;

type SnippetEditorSheetProps = Readonly<{
  visible: boolean;
  /** The snippet being edited; null creates one. */
  snippet: SshSnippet | null;
  hosts: readonly SshHost[];
  saving: boolean;
  onSave: (values: SnippetValues) => void;
  onClose: () => void;
}>;

/**
 * A snippet's name, the command it sends, whether it runs on tap, and the host
 * it belongs to. Keyed by the snippet it edits, so opening another one starts
 * from that snippet's values rather than the previous one's.
 */
export function SnippetEditorSheet({
  visible,
  snippet,
  hosts,
  saving,
  onSave,
  onClose,
}: SnippetEditorSheetProps) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  // iOS keeps text in refs: state holds only what the layout and choices show.
  const labelRef = useRef(snippet?.label ?? '');
  const commandRef = useRef(snippet?.command ?? '');
  const [appendNewline, setAppendNewline] = useState(snippet?.appendNewline ?? true);
  const [hostId, setHostId] = useState<string | null>(snippet?.hostId ?? null);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [missing, setMissing] = useState<{ label: boolean; command: boolean }>({
    label: false,
    command: false,
  });

  const hostOptions: MenuSheetOption[] = [
    { label: t('ssh.snippets.everyHost'), selected: hostId === null },
    ...hosts.map(host => ({ label: host.label, selected: host.id === hostId })),
  ];
  const hostLabel = hosts.find(host => host.id === hostId)?.label ?? t('ssh.snippets.everyHost');

  function save() {
    const label = labelRef.current.trim();
    const command = commandRef.current.trim();
    const missingFields = { label: label.length === 0, command: command.length === 0 };
    setMissing(missingFields);
    if (missingFields.label || missingFields.command) {
      return;
    }
    onSave({ label, command, appendNewline, hostId });
  }

  return (
    <Sheet visible={visible} onClose={onClose} dismissGestures={false}>
      <View className="gap-5 px-4 pb-4 pt-2" style={{ paddingBottom: bottom + 16 }}>
        <Text className="text-center text-base font-semibold text-foreground">
          {snippet === null ? t('ssh.snippets.newTitle') : t('ssh.snippets.edit')}
        </Text>
        <View className="gap-4">
          <FormField
            label={t('ssh.snippets.name')}
            placeholder={t('ssh.snippets.namePlaceholder')}
            defaultValue={snippet?.label}
            disabled={saving}
            error={missing.label ? t('ssh.editor.fieldRequired') : undefined}
            onChangeText={value => {
              labelRef.current = value;
            }}
          />
          <FormField
            label={t('ssh.snippets.command')}
            placeholder={t('ssh.snippets.commandPlaceholder')}
            defaultValue={snippet?.command}
            disabled={saving}
            multiline
            numberOfLines={3}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-[88px]"
            error={missing.command ? t('ssh.editor.fieldRequired') : undefined}
            onChangeText={value => {
              commandRef.current = value;
            }}
          />
          <PickerField
            label={t('ssh.snippets.host')}
            value={hostLabel}
            placeholder={t('ssh.snippets.everyHost')}
            disabled={saving}
            onPress={() => {
              setHostPickerOpen(true);
            }}
          />
          <SwitchField
            label={t('ssh.snippets.appendNewline')}
            hint={t('ssh.snippets.appendNewlineHint')}
            value={appendNewline}
            disabled={saving}
            onValueChange={setAppendNewline}
          />
        </View>
        <Button className={STATE_ACTION_CLASS} loading={saving} disabled={saving} onPress={save}>
          <Text>{t('common.save')}</Text>
        </Button>
      </View>

      <MenuSheet
        visible={hostPickerOpen}
        title={t('ssh.snippets.host')}
        options={hostOptions}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setHostPickerOpen(false);
        }}
        onSelect={index => {
          setHostId(index === 0 ? null : (hosts[index - 1]?.id ?? null));
          setHostPickerOpen(false);
        }}
      />
    </Sheet>
  );
}

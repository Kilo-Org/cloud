import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';

type FileNameDialogProps = Readonly<{
  title: string;
  /** The value the field starts with: the old name, or empty for a new folder. */
  initialValue: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}>;

/** One name, entered over the file list: a rename, or a new folder. */
export function FileNameDialog({
  title,
  initialValue,
  confirmLabel,
  busy,
  onCancel,
  onSubmit,
}: FileNameDialogProps) {
  const { t } = useTranslation();
  const nameRef = useRef(initialValue);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const name = nameRef.current.trim();
    if (name.length === 0) {
      setError(t('ssh.files.nameRequired'));
      return;
    }
    if (name.includes('/')) {
      setError(t('ssh.files.nameHasSlash'));
      return;
    }
    onSubmit(name);
  }

  return (
    <DialogCard onClose={onCancel}>
      <View className="gap-4">
        <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
          {title}
        </Text>
        <FormField
          label={t('ssh.files.newNameLabel')}
          defaultValue={initialValue}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          error={error ?? undefined}
          onChangeText={value => {
            nameRef.current = value;
            setError(null);
          }}
        />
        <View className="flex-row justify-end gap-2">
          <Button variant="outline" className={STATE_ACTION_CLASS} onPress={onCancel}>
            <Text>{t('common.cancel')}</Text>
          </Button>
          <Button className={STATE_ACTION_CLASS} loading={busy} disabled={busy} onPress={submit}>
            <Text>{confirmLabel}</Text>
          </Button>
        </View>
      </View>
    </DialogCard>
  );
}

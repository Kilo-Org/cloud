import { useTranslation } from 'react-i18next';
import { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Sheet } from '@/components/ui/sheet';
import { SwitchField } from '@/components/ssh/switch-field';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { forwardLabel, type SshForward } from '@/lib/ssh/forwards';
import { useSshForwardMutations } from '@/lib/ssh/use-forwards';

type ForwardEditorSheetProps = Readonly<{
  visible: boolean;
  hostId: string;
  /** The forward being edited; null creates one. */
  forward: SshForward | null;
  onClose: () => void;
}>;

const DEFAULT_BIND_HOST = '127.0.0.1';

/** The form behind one stored forward. A draft stays until it is saved or discarded. */
export function ForwardEditorSheet({ visible, hostId, forward, onClose }: ForwardEditorSheetProps) {
  const { t } = useTranslation();
  const { save, remove } = useSshForwardMutations();
  const { confirm, dialog } = useConfirmDialog();

  const [direction, setDirection] = useState<'local' | 'remote'>(forward?.direction ?? 'local');
  const [autoStart, setAutoStart] = useState(forward?.autoStart ?? false);
  const [issue, setIssue] = useState<string | null>(null);
  const bindHostRef = useRef(forward?.bindHost ?? DEFAULT_BIND_HOST);
  const bindPortRef = useRef(forward === null ? '' : String(forward.bindPort));
  const destinationHostRef = useRef(forward?.destinationHost ?? 'localhost');
  const destinationPortRef = useRef(
    forward === null ? '' : String(forward.destinationPort)
  );
  const labelRef = useRef(forward?.label ?? '');

  function submit() {
    const bindPort = Number(bindPortRef.current.trim());
    const destinationPort = Number(destinationPortRef.current.trim());
    const bindHost = bindHostRef.current.trim();
    const destinationHost = destinationHostRef.current.trim();
    if (!isPort(bindPort) || !isPort(destinationPort)) {
      setIssue(t('ssh.errors.invalidPort'));
      return;
    }
    if (bindHost.length === 0 || destinationHost.length === 0) {
      setIssue(t('ssh.forwards.hostRequired'));
      return;
    }
    setIssue(null);
    const label = labelRef.current.trim();
    save.mutate(
      {
        id: forward?.id ?? null,
        forward: {
          hostId,
          direction,
          bindHost,
          bindPort,
          destinationHost,
          destinationPort,
          autoStart,
          label: label.length === 0 ? null : label,
        },
      },
      { onSuccess: onClose }
    );
  }

  function confirmDelete() {
    if (forward === null) {
      return;
    }
    confirm({
      title: t('ssh.forwards.deleteTitle', { name: forwardLabel(forward) }),
      message: t('ssh.forwards.deleteMessage'),
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        remove.mutate(forward.id, { onSuccess: onClose });
      },
    });
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      dismissGestures={false}
      onRequestDismiss={() => {
        confirm({
          title: t('common.discardChangesTitle'),
          message: t('common.discardChangesMessage'),
          confirmLabel: t('common.discard'),
          cancelLabel: t('common.continue'),
          onConfirm: onClose,
        });
        return false;
      }}
    >
      <View className="gap-4 px-4 pb-6">
        <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
          {forward === null ? t('ssh.forwards.addTitle') : t('ssh.forwards.editTitle')}
        </Text>

        <ScrollView
          className="max-h-[420px]"
          contentContainerClassName="gap-4"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-1.5">
            <FormFieldLabel label={t('ssh.forwards.direction')} />
            <SegmentedControl
              accessibilityLabel={t('ssh.forwards.direction')}
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'local', label: t('ssh.forwards.local') },
                { value: 'remote', label: t('ssh.forwards.remote') },
              ]}
            />
            <Text className="text-xs text-muted-foreground">
              {direction === 'local' ? t('ssh.forwards.localHint') : t('ssh.forwards.remoteHint')}
            </Text>
          </View>

          <FormField
            label={t('ssh.forwards.bindHost')}
            defaultValue={bindHostRef.current}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={value => {
              bindHostRef.current = value;
            }}
          />
          <FormField
            label={t('ssh.forwards.bindPort')}
            defaultValue={bindPortRef.current}
            keyboardType="number-pad"
            maxLength={5}
            error={issue ?? undefined}
            onChangeText={value => {
              bindPortRef.current = value;
              setIssue(null);
            }}
          />
          <FormField
            label={t('ssh.forwards.destinationHost')}
            defaultValue={destinationHostRef.current}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={value => {
              destinationHostRef.current = value;
            }}
          />
          <FormField
            label={t('ssh.forwards.destinationPort')}
            defaultValue={destinationPortRef.current}
            keyboardType="number-pad"
            maxLength={5}
            onChangeText={value => {
              destinationPortRef.current = value;
              setIssue(null);
            }}
          />
          <FormField
            label={t('ssh.forwards.label')}
            placeholder={t('ssh.forwards.labelPlaceholder')}
            defaultValue={labelRef.current}
            onChangeText={value => {
              labelRef.current = value;
            }}
          />
          <SwitchField
            label={t('ssh.forwards.autoStart')}
            value={autoStart}
            onValueChange={setAutoStart}
          />
        </ScrollView>

        <Button
          className={STATE_ACTION_CLASS}
          loading={save.isPending}
          disabled={save.isPending}
          onPress={submit}
        >
          <Text>{t('common.save')}</Text>
        </Button>
        {forward === null ? null : (
          <Button
            variant="outline"
            className={STATE_ACTION_CLASS}
            disabled={remove.isPending}
            loading={remove.isPending}
            onPress={confirmDelete}
          >
            <Text className="text-destructive">{t('common.delete')}</Text>
          </Button>
        )}
      </View>
      {dialog}
    </Sheet>
  );
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

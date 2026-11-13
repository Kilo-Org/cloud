import { type LucideIcon, Bell, BellOff, ChevronRight, FolderOpen, Plug } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useIdleNotify } from '@/lib/ssh/session/idle-notify';

type SshSessionMenuProps = Readonly<{
  visible: boolean;
  sessionId: string;
  /** A shell has to exist before a finish can be watched for. */
  shellId: string | null;
  onOpenFiles: () => void;
  onOpenForwards: () => void;
  onNotifyChange: (next: boolean) => void;
  onClose: () => void;
}>;

/** What the terminal's header menu offers beyond the key bar. */
export function SshSessionMenu({
  visible,
  sessionId,
  shellId,
  onOpenFiles,
  onOpenForwards,
  onNotifyChange,
  onClose,
}: SshSessionMenuProps) {
  const { t } = useTranslation();
  const notify = useIdleNotify(sessionId);

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View className="gap-1 pb-4">
        <Text accessibilityRole="header" className="px-4 py-2 text-sm font-semibold text-muted-foreground">
          {t('ssh.session.menuTitle')}
        </Text>
        <MenuRow
          icon={FolderOpen}
          label={t('ssh.files.openAction')}
          onPress={() => {
            onClose();
            onOpenFiles();
          }}
        />
        <MenuRow
          icon={Plug}
          label={t('ssh.forwards.title')}
          onPress={() => {
            onClose();
            onOpenForwards();
          }}
        />
        <View className={`${ROW_TARGET_CLASS} flex-row items-center gap-3 px-4`}>
          <NotifyRow
            enabled={notify}
            disabled={shellId === null}
            label={t('ssh.session.notifyWhenIdle')}
            hint={t('ssh.session.notifyWhenIdleHint')}
            onValueChange={onNotifyChange}
          />
        </View>
      </View>
    </Sheet>
  );
}

function NotifyRow({
  enabled,
  disabled,
  label,
  hint,
  onValueChange,
}: Readonly<{
  enabled: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  onValueChange: (next: boolean) => void;
}>) {
  const colors = useThemeColors();
  const Icon = enabled ? Bell : BellOff;
  const flip = () => {
    onValueChange(!enabled);
  };
  // The row is the large target and the switch is what a screen reader uses;
  // the row's own text stays out of the tree so the control is announced once.
  return (
    <>
      <Pressable
        className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
        disabled={disabled}
        onPress={flip}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <Icon size={18} color={disabled ? colors.mutedForeground : colors.foreground} />
        <Text
          className={
            disabled
              ? 'min-w-0 flex-1 py-3 text-sm font-medium text-muted-foreground'
              : 'min-w-0 flex-1 py-3 text-sm font-medium text-foreground'
          }
        >
          {label}
        </Text>
      </Pressable>
      <Switch
        value={enabled}
        disabled={disabled}
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled, checked: enabled }}
        onValueChange={flip}
      />
    </>
  );
}

function MenuRow({
  icon: Icon,
  label,
  onPress,
}: Readonly<{ icon: LucideIcon; label: string; onPress: () => void }>) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`${ROW_TARGET_CLASS} flex-row items-center gap-3 px-4 active:bg-secondary`}
      onPress={onPress}
    >
      <Icon size={18} color={colors.foreground} />
      <Text className="min-w-0 flex-1 py-3 text-sm font-medium text-foreground">{label}</Text>
      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

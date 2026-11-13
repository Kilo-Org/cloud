import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Check, Plus } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { sessionStateLabel } from '@/lib/ssh/session/phase-copy';
import { type SshSession } from '@/lib/ssh/session/types';
import { cn } from '@/lib/utils';

type SshSessionSwitcherProps = Readonly<{
  visible: boolean;
  sessions: readonly SshSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onClose: () => void;
}>;

/**
 * Every session the app is holding, with the state each one is in, and the way
 * to start another. The list includes closed sessions, so the heading names
 * sessions rather than open ones, and the state keeps its own line end: a long
 * hostname truncates first.
 */
export function SshSessionSwitcher({
  visible,
  sessions,
  activeId,
  onSelect,
  onNewSession,
  onClose,
}: SshSessionSwitcherProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View className="gap-1 px-3 pb-4">
        <Text className="px-2 pb-3 text-center text-base font-semibold text-foreground">
          {t('ssh.session.switcherTitle')}
        </Text>
        {sessions.map(session => {
          const active = session.id === activeId;
          const state = sessionStateLabel(t, session.phase);
          return (
            <Pressable
              key={session.id}
              onPress={() => {
                onSelect(session.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={t('ssh.session.switchTo', { label: session.label, state })}
              accessibilityState={{ selected: active }}
              className={cn(
                ROW_TARGET_CLASS,
                'flex-row items-center gap-3 rounded-md px-2 active:opacity-70'
              )}
            >
              <View className="min-w-0 flex-1 justify-center">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {session.label}
                </Text>
                <View className="flex-row items-center gap-1.5">
                  <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
                    {session.target}
                  </Text>
                  <Text className="text-xs text-muted-foreground">·</Text>
                  <Text className="shrink-0 text-xs text-muted-foreground">{state}</Text>
                </View>
              </View>
              {active ? <Check size={16} color={colors.primary} /> : null}
            </Pressable>
          );
        })}
        <Pressable
          onPress={onNewSession}
          accessibilityRole="button"
          accessibilityLabel={t('common.newSession')}
          className={cn(
            ROW_TARGET_CLASS,
            'flex-row items-center gap-2 rounded-md px-2 active:opacity-70'
          )}
        >
          <Plus size={16} color={colors.foreground} />
          <Text className="text-sm text-foreground">{t('common.newSession')}</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

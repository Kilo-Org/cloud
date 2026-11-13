import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { ForwardEditorSheet } from '@/components/ssh/forwards/forward-editor-sheet';
import { Button } from '@/components/ui/button';
import { ChevronRight, Plus, Plug } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { forwardLabel, type SshForward } from '@/lib/ssh/forwards';
import { useSshForwards } from '@/lib/ssh/use-forwards';

type HostForwardsSectionProps = Readonly<{
  /** The host being edited; null until a new host is saved. */
  hostId: string | null;
  disabled: boolean;
}>;

/** The host editor's forward list: what connects when this host connects. */
export function HostForwardsSection({ hostId, disabled }: HostForwardsSectionProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const forwards = useSshForwards(hostId);
  const [editing, setEditing] = useState<{ forward: SshForward | null } | null>(null);

  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-2">
        <Text accessibilityRole="header" className="text-sm font-medium text-foreground">
          {t('ssh.forwards.title')}
        </Text>
      </View>

      {hostId === null ? (
        <Text className="text-xs text-muted-foreground">{t('ssh.forwards.saveHostFirst')}</Text>
      ) : forwards.isPending ? (
        <Skeleton className="h-14 rounded-xl" />
      ) : forwards.isError ? (
        <Text className="text-xs text-destructive">{t('ssh.forwards.loadFailed')}</Text>
      ) : forwards.data.length === 0 ? (
        <Text className="text-xs text-muted-foreground">{t('ssh.forwards.emptyDescription')}</Text>
      ) : (
        <View className="gap-2">
          {forwards.data.map(forward => (
            <Pressable
              key={forward.id}
              accessibilityRole="button"
              accessibilityLabel={t('ssh.forwards.editAction', { name: forwardLabel(forward) })}
              disabled={disabled}
              className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 active:opacity-70"
              onPress={() => {
                setEditing({ forward });
              }}
            >
              <Plug size={16} color={colors.mutedForeground} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm text-foreground" numberOfLines={1}>
                  {forwardLabel(forward)}
                </Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {forward.direction === 'local'
                    ? t('ssh.forwards.localLine')
                    : t('ssh.forwards.remoteLine')}
                  {forward.autoStart ? ` · ${t('ssh.forwards.autoStartShort')}` : ''}
                </Text>
              </View>
              <ChevronRight size={16} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      )}

      {hostId === null ? null : (
        <Button
          variant="outline"
          className={STATE_ACTION_CLASS}
          disabled={disabled}
          onPress={() => {
            setEditing({ forward: null });
          }}
        >
          <Plus size={16} color={colors.foreground} />
          <Text>{t('ssh.forwards.add')}</Text>
        </Button>
      )}

      {hostId === null ? null : (
        <ForwardEditorSheet
          visible={editing !== null}
          hostId={hostId}
          forward={editing?.forward ?? null}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </View>
  );
}

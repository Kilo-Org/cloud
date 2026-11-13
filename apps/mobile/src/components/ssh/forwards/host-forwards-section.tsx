import { type TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { ForwardEditorSheet } from '@/components/ssh/forwards/forward-editor-sheet';
import { Button } from '@/components/ui/button';
import { ChevronRight, Plug, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { forwardLabel, type SshForward } from '@/lib/ssh/forwards';
import { type SshForwardsQuery, useSshForwards } from '@/lib/ssh/use-forwards';

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

      <ForwardsBody
        hostId={hostId}
        forwards={forwards}
        disabled={disabled}
        onEdit={forward => {
          setEditing({ forward });
        }}
      />

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

type ForwardsBodyProps = Readonly<{
  hostId: string | null;
  forwards: SshForwardsQuery;
  disabled: boolean;
  onEdit: (forward: SshForward) => void;
}>;

function ForwardsBody({ hostId, forwards, disabled, onEdit }: ForwardsBodyProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  if (hostId === null) {
    return <Text className="text-xs text-muted-foreground">{t('ssh.forwards.saveHostFirst')}</Text>;
  }
  if (forwards.isPending) {
    return <Skeleton className="h-14 rounded-xl" />;
  }
  if (forwards.isError) {
    return <Text className="text-xs text-destructive">{t('ssh.forwards.loadFailed')}</Text>;
  }
  if (forwards.data.length === 0) {
    return (
      <Text className="text-xs text-muted-foreground">{t('ssh.forwards.emptyDescription')}</Text>
    );
  }
  return (
    <View className="gap-2">
      {forwards.data.map(forward => (
        <Pressable
          key={forward.id}
          accessibilityRole="button"
          accessibilityLabel={t('ssh.forwards.editAction', { name: forwardLabel(forward) })}
          disabled={disabled}
          className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 active:opacity-70"
          onPress={() => {
            onEdit(forward);
          }}
        >
          <Plug size={16} color={colors.mutedForeground} />
          <View className="min-w-0 flex-1">
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {forwardLabel(forward)}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {directionLine(t, forward)}
            </Text>
          </View>
          <ChevronRight size={16} color={colors.mutedForeground} />
        </Pressable>
      ))}
    </View>
  );
}

function directionLine(t: TFunction, forward: SshForward): string {
  const direction = t(
    forward.direction === 'local' ? 'ssh.forwards.localLine' : 'ssh.forwards.remoteLine'
  );
  return forward.autoStart ? `${direction} · ${t('ssh.forwards.autoStartShort')}` : direction;
}

import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Settings2 } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SshSnippet } from '@/lib/ssh/snippets';
import { useSshSnippets } from '@/lib/ssh/use-ssh';

/** The tallest the list may grow before it scrolls: six rows and their gaps. */
const LIST_MAX_HEIGHT_CLASS = 'max-h-[356px]';
const SKELETON_ROWS = [0, 1, 2];

type SnippetsSheetProps = Readonly<{
  visible: boolean;
  /** The host whose own snippets join the global ones; null on a sandbox terminal. */
  hostId: string | null;
  onSelect: (snippet: SshSnippet) => void;
  onManage: () => void;
  onClose: () => void;
}>;

/**
 * The key bar's snippets, as a list to send from: the global ones and the ones
 * this host carries, in the store's order. The list is bounded and scrolls, so
 * a long store cannot push the manage row off the sheet.
 */
export function SnippetsSheet({
  visible,
  hostId,
  onSelect,
  onManage,
  onClose,
}: SnippetsSheetProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const snippets = useSshSnippets();
  const offered = (snippets.data ?? []).filter(
    snippet => snippet.hostId === null || snippet.hostId === hostId
  );

  function renderBody() {
    if (snippets.isPending) {
      return (
        <View className="gap-1 px-2">
          {SKELETON_ROWS.map(row => (
            <Skeleton key={row} className="h-14 rounded-md" />
          ))}
        </View>
      );
    }
    if (snippets.isError) {
      return (
        <Text className="px-2 py-6 text-center text-sm text-muted-foreground">
          {t('ssh.storage.unavailableMessage')}
        </Text>
      );
    }
    if (offered.length === 0) {
      return (
        <View className="items-center gap-3 px-6 py-6">
          <Text className="text-center text-base font-semibold text-foreground">
            {t('ssh.snippets.emptyTitle')}
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            {t('ssh.snippets.emptyDescription')}
          </Text>
          <Button className={STATE_ACTION_CLASS} onPress={onManage}>
            <Text>{t('ssh.snippets.add')}</Text>
          </Button>
        </View>
      );
    }
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        className={LIST_MAX_HEIGHT_CLASS}
        contentContainerClassName="gap-1"
      >
        {offered.map(snippet => (
          <Pressable
            key={snippet.id}
            onPress={() => {
              onSelect(snippet);
            }}
            accessibilityRole="button"
            accessibilityLabel={t('ssh.snippets.send', { label: snippet.label })}
            accessibilityHint={snippet.command}
            className="h-14 justify-center rounded-md px-2 active:opacity-70"
          >
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {snippet.label}
            </Text>
            <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
              {snippet.command}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View className="gap-3 px-3 pb-4">
        <Text className="px-2 pb-1 text-center text-base font-semibold text-foreground">
          {t('ssh.snippets.title')}
        </Text>
        {renderBody()}
        <Pressable
          onPress={onManage}
          accessibilityRole="button"
          accessibilityLabel={t('ssh.snippets.manage')}
          className="min-h-[48px] flex-row items-center gap-2 rounded-md px-2 active:opacity-70"
        >
          <Settings2 size={16} color={colors.foreground} />
          <Text className="text-sm text-foreground">{t('ssh.snippets.manage')}</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

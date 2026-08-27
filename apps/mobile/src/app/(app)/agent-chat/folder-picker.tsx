import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Button } from '@/components/ui/button';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { FolderOpen } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type DirectoryEntry, useListDirectories } from '@/lib/hooks/use-list-directories';
import { folderPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';

const SKELETON_ROW_COUNT = 5;

/** One navigation step in the in-sheet drill/Back stack. */
type NavFrame = { path: string; title: string };

export default function FolderPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const [bridge] = useState(() => folderPickerSlot.get(UNFENCED_ROUTE_KEY));
  const bridgeRef = useRef(bridge);
  useRouteRegistry(UNFENCED_ROUTE_KEY);
  // Build the drill stack from the bridge so a reopen at a child shows the
  // child's name as the title and Back returns to its parent, while a reopen
  // at launch stays a single frame (Back hidden). The CLI returns each entry's
  // `path` as a POSIX-relative path whose last segment is its `name`, so the
  // segment is the correct frame title.
  const [stack, setStack] = useState<NavFrame[]>(() => {
    if (!bridge) {
      return [];
    }
    const frames: NavFrame[] = [{ path: '', title: bridge.projectName }];
    if (bridge.currentPath) {
      let prefix = '';
      for (const segment of bridge.currentPath.split('/')) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        frames.push({ path: prefix, title: segment });
      }
    }
    return frames;
  });
  const { state, list } = useListDirectories(bridge?.connectionId ?? null);

  // List the launch (or last confirmed) path once on mount. `bridge` and
  // `list` are both stable for this screen's lifetime, so this runs once.
  useEffect(() => {
    if (bridge) {
      list(bridge.currentPath);
    }
  }, [bridge, list]);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  const handleDone = useCallback(() => {
    void Haptics.selectionAsync();
    // Unsupported means the CLI cannot list this folder: Done keeps the launch
    // directory (`""`), never the listed path. Every other state confirms the
    // listed folder.
    const path = state?.phase === 'unsupported' ? '' : (stack.at(-1)?.path ?? '');
    bridgeRef.current?.onSelect(path);
    folderPickerSlot.clear(UNFENCED_ROUTE_KEY);
    bridgeRef.current = undefined;
    closePicker();
  }, [closePicker, stack, state]);

  const openChild = useCallback(
    (child: DirectoryEntry) => {
      setStack(prev => [...prev, { path: child.path, title: child.name }]);
      list(child.path);
    },
    [list]
  );

  const goBack = useCallback(() => {
    const parent = stack.at(-2);
    setStack(prev => (prev.length > 1 ? prev.slice(0, -1) : prev));
    if (parent) {
      // Restores the cached parent in-sheet and advances the generation so
      // any in-flight child listing is ignored. Never `router.back`.
      list(parent.path);
    }
  }, [list, stack]);

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.folderPicker.fieldLabel')}
        onDone={closePicker}
        scrollable={false}
        expired
      />
    );
  }

  const current = stack.at(-1);
  const isNested = stack.length > 1;
  const title = current?.title ?? bridge.projectName;
  const currentState = state?.path === current?.path ? state : null;

  let body: ReactNode = null;
  if (currentState === null || currentState.phase === 'skeleton') {
    body = (
      <View className="flex-1 bg-background" style={{ paddingBottom: bottom }}>
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <View key={i} className="px-4 py-3">
            <Skeleton className="h-6 w-2/3 rounded-md" />
          </View>
        ))}
      </View>
    );
  } else if (currentState.phase === 'retryable') {
    body = (
      <View className="flex-1 items-center justify-center" style={{ paddingBottom: bottom }}>
        <EmptyState
          icon={FolderOpen}
          placement="center"
          title={t('agentChat.folderPicker.retryableTitle')}
          description={t('agentChat.folderPicker.retryableDescription')}
          action={
            <Button
              variant="outline"
              onPress={() => {
                list(currentState.path);
              }}
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          }
        />
      </View>
    );
  } else if (currentState.phase === 'unsupported') {
    body = (
      <View className="flex-1 items-center justify-center" style={{ paddingBottom: bottom }}>
        <EmptyState
          icon={FolderOpen}
          placement="center"
          title={t('agentChat.folderPicker.unsupportedTitle')}
          description={t('agentChat.folderPicker.unsupportedDescription')}
        />
      </View>
    );
  } else {
    const directories = currentState.directories;
    body = (
      <FlatList
        className="flex-1 bg-background"
        data={directories}
        keyExtractor={entry => entry.path}
        contentContainerStyle={{ paddingBottom: bottom }}
        ListHeaderComponent={
          directories.length > 0 ? (
            <View className="px-4 pb-2 pt-3">
              <Text variant="muted" className="text-sm">
                {t('agentChat.folderPicker.tapToListHint')}
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View className="items-center justify-center px-6 pt-10">
            <EmptyState
              icon={FolderOpen}
              placement="top"
              title={t('agentChat.folderPicker.emptyTitle')}
              description={t('agentChat.folderPicker.emptyDescription')}
            />
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
            onPress={() => {
              openChild(item);
            }}
            accessibilityRole="button"
            accessibilityLabel={item.name}
            accessibilityHint={t('agentChat.folderPicker.tapToListHint')}
          >
            <View className="flex-1">
              <Text className="text-base text-foreground" numberOfLines={1}>
                {item.name}
              </Text>
            </View>
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <DirectionalChevronRight size={14} color={colors.mutedForeground} />
            </View>
          </Pressable>
        )}
      />
    );
  }

  return (
    <PickerSheet
      title={title}
      onDone={handleDone}
      onCancel={isNested ? goBack : undefined}
      cancelLabel={isNested ? t('common.back') : undefined}
      scrollable={false}
    >
      {body}
    </PickerSheet>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import {
  SnippetEditorSheet,
  type SnippetValues,
} from '@/components/ssh/snippets/snippet-editor-sheet';
import { SshStorageError } from '@/components/ssh/ssh-storage-error';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Code, Plus } from '@/components/ui/icons';
import { MenuSheet, type MenuSheetOption } from '@/components/ui/menu-sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { type SshSnippet } from '@/lib/ssh/snippets';
import { useSshHosts, useSshSnippetMutations, useSshSnippets } from '@/lib/ssh/use-ssh';

const SKELETON_ROWS = [0, 1, 2];

type EditorState = Readonly<{ snippet: SshSnippet | null }> | null;

type SnippetMenu = Readonly<{
  snippet: SshSnippet;
  options: readonly MenuSheetOption[];
  run: readonly (() => void)[];
}> | null;

/**
 * The stored snippets, in the order a terminal offers them: every global one,
 * then a host's own. Pressing a row edits it; the row's menu deletes it or
 * moves it one place, which is the order both lists read.
 */
export function SnippetsScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { confirm, dialog } = useConfirmDialog();
  const snippets = useSshSnippets();
  const hosts = useSshHosts();
  const { remove, reorder, save } = useSshSnippetMutations();
  const [editor, setEditor] = useState<EditorState>(null);
  const [menu, setMenu] = useState<SnippetMenu>(null);

  const stored = snippets.data ?? [];
  const hostLabels = new Map((hosts.data ?? []).map(host => [host.id, host.label]));
  const scopeLabel = (snippet: SshSnippet) =>
    snippet.hostId === null
      ? t('ssh.snippets.everyHost')
      : (hostLabels.get(snippet.hostId) ?? t('ssh.snippets.everyHost'));

  function move(snippet: SshSnippet, direction: -1 | 1) {
    const ids = stored.map(entry => entry.id);
    const from = ids.indexOf(snippet.id);
    const to = from + direction;
    const source = ids[from];
    const target = ids[to];
    if (source === undefined || target === undefined) {
      return;
    }
    ids[from] = target;
    ids[to] = source;
    reorder.mutate(ids);
  }

  function confirmDelete(snippet: SshSnippet) {
    confirm({
      title: t('common.deleteTitle', { label: snippet.label }),
      message: t('ssh.snippets.deleteMessage'),
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        remove.mutate(snippet.id);
      },
    });
  }

  function openMenu(snippet: SshSnippet) {
    const index = stored.findIndex(entry => entry.id === snippet.id);
    const options: MenuSheetOption[] = [{ label: t('ssh.snippets.edit') }];
    const run: (() => void)[] = [
      () => {
        setEditor({ snippet });
      },
    ];
    if (index > 0) {
      options.push({ label: t('ssh.snippets.moveUp') });
      run.push(() => {
        move(snippet, -1);
      });
    }
    if (index !== -1 && index < stored.length - 1) {
      options.push({ label: t('ssh.snippets.moveDown') });
      run.push(() => {
        move(snippet, 1);
      });
    }
    options.push({ label: t('common.delete'), destructive: true });
    run.push(() => {
      confirmDelete(snippet);
    });
    setMenu({ snippet, options, run });
  }

  function saveValues(values: SnippetValues) {
    save.mutate(
      {
        id: editor?.snippet?.id ?? null,
        ...values,
        sortOrder: editor?.snippet?.sortOrder ?? stored.length,
      },
      {
        onSuccess: () => {
          setEditor(null);
        },
      }
    );
  }

  function renderBody() {
    if (snippets.isPending) {
      return (
        <View className="gap-2 px-4 pt-4">
          {SKELETON_ROWS.map(row => (
            <Skeleton key={row} className="h-[64px] rounded-lg" />
          ))}
        </View>
      );
    }
    if (snippets.isError) {
      return (
        <SshStorageError
          error={snippets.error}
          onRetry={() => void snippets.refetch()}
          isRetrying={snippets.isFetching}
        />
      );
    }
    if (stored.length === 0) {
      return (
        <EmptyState
          icon={Code}
          title={t('ssh.snippets.emptyTitle')}
          description={t('ssh.snippets.emptyDescription')}
          action={
            <Button
              className={STATE_ACTION_CLASS}
              onPress={() => {
                setEditor({ snippet: null });
              }}
            >
              <Text>{t('ssh.snippets.add')}</Text>
            </Button>
          }
        />
      );
    }
    return (
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-2 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {stored.map(snippet => (
          <Pressable
            key={snippet.id}
            onPress={() => {
              setEditor({ snippet });
            }}
            onLongPress={() => {
              openMenu(snippet);
            }}
            accessibilityRole="button"
            accessibilityLabel={t('ssh.snippets.rowActions', { label: snippet.label })}
            accessibilityHint={snippet.command}
            className="min-h-[64px] justify-center gap-0.5 rounded-lg border border-border bg-card px-3 py-2 active:opacity-70"
          >
            <View className="flex-row items-center gap-2">
              <Text
                className="min-w-0 shrink text-sm font-medium text-foreground"
                numberOfLines={1}
              >
                {snippet.label}
              </Text>
              <Text className="shrink-0 text-xs text-muted-foreground" numberOfLines={1}>
                {scopeLabel(snippet)}
              </Text>
            </View>
            <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
              {snippet.command}
            </Text>
          </Pressable>
        ))}
      </DetailScreenScrollView>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('ssh.snippets.title')}
        subtitle={t('ssh.snippets.subtitle')}
        backFallback={SSH_HOSTS_ROUTE}
        headerRight={
          <IconButton
            accessibilityLabel={t('ssh.snippets.add')}
            onPress={() => {
              setEditor({ snippet: null });
            }}
          >
            <Plus size={20} color={colors.foreground} />
          </IconButton>
        }
      />
      {renderBody()}
      <SnippetEditorSheet
        key={editor?.snippet?.id ?? 'new'}
        visible={editor !== null}
        snippet={editor?.snippet ?? null}
        hosts={hosts.data ?? []}
        saving={save.isPending}
        onSave={saveValues}
        onClose={() => {
          setEditor(null);
        }}
      />
      <MenuSheet
        visible={menu !== null}
        title={menu?.snippet.label}
        options={menu?.options ?? []}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setMenu(null);
        }}
        onSelect={index => {
          const run = menu?.run[index];
          setMenu(null);
          run?.();
        }}
      />
      {dialog}
    </View>
  );
}

import { useRouter } from 'expo-router';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { HostListRow } from '@/components/ssh/host-list-row';
import { SshStorageError } from '@/components/ssh/ssh-storage-error';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Plus, Server, ShieldCheck } from '@/components/ui/icons';
import { MenuSheet, type MenuSheetOption } from '@/components/ui/menu-sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SshHost } from '@/lib/ssh/hosts';
import {
  SSH_HOST_IMPORT_ROUTE,
  SSH_HOST_NEW_ROUTE,
  SSH_KNOWN_HOSTS_ROUTE,
  sshHostPath,
} from '@/lib/ssh/routes';
import { useSshHostMutations, useSshHosts } from '@/lib/ssh/use-ssh';

const SKELETON_ROWS = [0, 1, 2];

/** The stored hosts, and the way to add, edit, delete or trust one. */
export function SshHostsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const { confirm, dialog } = useConfirmDialog();
  const hosts = useSshHosts();
  const { remove } = useSshHostMutations();
  const [menuHost, setMenuHost] = useState<SshHost | null>(null);

  // A menu row's action runs once the sheet is gone: an edit pushes a route and
  // a delete presents a confirm, and neither may start inside a dismissing
  // sheet. A sheet the person dismisses themselves runs nothing.
  const pendingActionRef = useRef<(() => void) | null>(null);
  const menuDismissedItselfRef = useRef(false);

  const hostsById = useMemo(
    () => new Map((hosts.data ?? []).map(host => [host.id, host])),
    [hosts.data]
  );

  function runPendingAction() {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    const dismissedItself = menuDismissedItselfRef.current;
    menuDismissedItselfRef.current = false;
    if (action && !dismissedItself) {
      action();
    }
  }

  function chooseAction(action: () => void) {
    pendingActionRef.current = action;
    menuDismissedItselfRef.current = false;
    setMenuHost(null);
  }

  function confirmDelete(host: SshHost) {
    confirm({
      title: t('ssh.hosts.deleteTitle', { label: host.label }),
      message: t('ssh.hosts.deleteMessage'),
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        remove.mutate(host.id, {
          onError: () => {
            toast.error(t('ssh.hosts.deleteFailed'));
          },
        });
      },
    });
  }

  function actionFor(host: SshHost, index: number): (() => void) | null {
    if (index === 0) {
      return () => {
        router.push(sshHostPath(host.id));
      };
    }
    if (index === 1) {
      return () => {
        confirmDelete(host);
      };
    }
    return null;
  }

  const showAdd = (hosts.data?.length ?? 0) > 0;
  let body: ReactNode = null;
  if (hosts.isPending) {
    body = (
      <View className="gap-2 px-4 pt-4">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-[74px] rounded-lg" />
        ))}
      </View>
    );
  } else if (hosts.isError) {
    body = (
      <SshStorageError
        error={hosts.error}
        onRetry={() => void hosts.refetch()}
        isRetrying={hosts.isFetching}
      />
    );
  } else if (hosts.data.length === 0) {
    body = (
      <EmptyState
        icon={Server}
        title={t('ssh.hosts.emptyTitle')}
        description={t('ssh.hosts.emptyDescription')}
        action={
          <View className="gap-2 self-stretch px-6">
            <Button
              className={STATE_ACTION_CLASS}
              onPress={() => {
                router.push(SSH_HOST_NEW_ROUTE);
              }}
            >
              <Plus size={16} color={colors.primaryForeground} />
              <Text>{t('ssh.hosts.addHost')}</Text>
            </Button>
            <Button
              variant="outline"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                router.push(SSH_HOST_IMPORT_ROUTE);
              }}
            >
              <Text>{t('ssh.hosts.importConfig')}</Text>
            </Button>
          </View>
        }
      />
    );
  } else {
    body = (
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-2 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {hosts.data.map(host => (
          <HostListRow
            key={host.id}
            host={host}
            jumpHost={host.jumpHostId === null ? null : (hostsById.get(host.jumpHostId) ?? null)}
            onPress={() => {
              setMenuHost(host);
            }}
            onLongPress={() => {
              setMenuHost(host);
            }}
          />
        ))}
      </DetailScreenScrollView>
    );
  }

  const menuOptions: MenuSheetOption[] =
    menuHost === null
      ? []
      : [{ label: t('ssh.editor.editTitle') }, { label: t('common.delete'), destructive: true }];

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('ssh.title')}
        headerRight={
          <View className="flex-row items-center">
            <IconButton
              accessibilityLabel={t('ssh.knownHosts.title')}
              onPress={() => {
                router.push(SSH_KNOWN_HOSTS_ROUTE);
              }}
            >
              <ShieldCheck size={20} color={colors.foreground} />
            </IconButton>
            {showAdd ? (
              <IconButton
                accessibilityLabel={t('ssh.hosts.addHost')}
                onPress={() => {
                  router.push(SSH_HOST_NEW_ROUTE);
                }}
              >
                <Plus size={20} color={colors.foreground} />
              </IconButton>
            ) : null}
          </View>
        }
        headerRightWidth={showAdd ? 96 : 48}
      />
      {body}
      <MenuSheet
        visible={menuHost !== null}
        title={menuHost?.label}
        options={menuOptions}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setMenuHost(null);
        }}
        onDismiss={runPendingAction}
        onRequestDismiss={() => {
          menuDismissedItselfRef.current = true;
          return true;
        }}
        onSelect={index => {
          if (menuHost === null) {
            return;
          }
          const action = actionFor(menuHost, index);
          if (action) {
            chooseAction(action);
          }
        }}
      />
      {dialog}
    </View>
  );
}

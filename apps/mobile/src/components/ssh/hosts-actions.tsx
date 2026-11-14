import { type Href, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { IconButton } from '@/components/ui/icon-button';
import { MoreHorizontal, Plus } from '@/components/ui/icons';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  SSH_BACKUP_EXPORT_ROUTE,
  SSH_BACKUP_IMPORT_ROUTE,
  SSH_HOST_IMPORT_ROUTE,
  SSH_HOST_NEW_ROUTE,
  SSH_KNOWN_HOSTS_ROUTE,
} from '@/lib/ssh/routes';

export function SshHostsActions({ showAdd }: { showAdd: boolean }) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const [open, setOpen] = useState(false);
  const pending = useRef<Href | null>(null);
  return (
    <View className="flex-row items-center">
      <IconButton
        accessibilityLabel={t('ssh.hosts.menuTitle')}
        onPress={() => {
          setOpen(true);
        }}
      >
        <MoreHorizontal size={20} color={colors.foreground} />
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
      <MenuSheet
        visible={open}
        title={t('ssh.hosts.menuTitle')}
        options={[
          { label: t('ssh.backup.exportTitle') },
          { label: t('ssh.backup.importTitle') },
          { label: t('ssh.knownHosts.title') },
          { label: t('ssh.hosts.importConfig') },
        ]}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setOpen(false);
        }}
        onDismiss={() => {
          const route = pending.current;
          pending.current = null;
          if (route !== null) {
            router.push(route);
          }
        }}
        onRequestDismiss={() => {
          pending.current = null;
          return true;
        }}
        onSelect={index => {
          pending.current =
            [
              SSH_BACKUP_EXPORT_ROUTE,
              SSH_BACKUP_IMPORT_ROUTE,
              SSH_KNOWN_HOSTS_ROUTE,
              SSH_HOST_IMPORT_ROUTE,
            ][index] ?? null;
          setOpen(false);
        }}
      />
    </View>
  );
}

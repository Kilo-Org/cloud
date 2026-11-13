import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Terminal } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';

/** The screen a session that is gone leaves behind: the way back to its hosts. */
export function SshTerminalClosed() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('ssh.session.closedTitle')} backFallback={SSH_HOSTS_ROUTE} />
      <EmptyState
        icon={Terminal}
        title={t('ssh.session.closedTitle')}
        description={t('ssh.session.closedDescription')}
        action={
          <Button
            className={STATE_ACTION_CLASS}
            onPress={() => {
              router.replace(SSH_HOSTS_ROUTE);
            }}
          >
            <Text>{t('ssh.session.backToHosts')}</Text>
          </Button>
        }
      />
    </View>
  );
}

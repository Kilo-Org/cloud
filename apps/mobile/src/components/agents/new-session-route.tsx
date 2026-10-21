import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { NewSessionModelProvider } from '@/components/agents/new-session-model-provider';
import { NewSessionScreenBody } from '@/components/agents/new-session-screen-body';
import { useNewSessionOrganization } from '@/components/agents/use-new-session-organization';
import { ScreenHeader } from '@/components/screen-header';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { useOrganization } from '@/lib/organization-context';

/**
 * The New-session composer with the caller's organization context. Rendered by
 * the `agent-chat/new` route and by the session-detail route when its
 * `session-id` param cannot be a session id.
 */
export function NewSessionRoute() {
  const { t } = useTranslation();
  const { organizationId, isResolved, usesActiveAccount } = useNewSessionOrganization();
  const { error, retry } = useOrganization();
  // Nothing account-scoped mounts before the account is known: the model
  // catalog, the repositories, the profiles and the create all take this value,
  // and an unresolved one reads as Personal. A stored organization or an
  // explicit Personal choice resolves from storage; with neither, the account
  // list decides, so the wait is a network round trip. A failed account list
  // falls back to Personal across the app, which is not a choice the user made:
  // when the active account is what decides this screen, that failure keeps the
  // form gated behind its retry instead of creating in the fallback.
  const accountPending = !isResolved || (usesActiveAccount && error === 'restore');
  if (accountPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.newSession')} />
        <View className="flex-1 items-center justify-center gap-3 px-4">
          {error === 'restore' ? (
            <>
              <Text className="text-center text-sm text-muted-foreground">
                {t('common.somethingWentWrong')}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('common.retry')}
                onPress={retry}
                className="min-h-11 flex-row items-center justify-center active:opacity-70"
              >
                <Text className="text-sm text-primary">{t('common.retry')}</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      </View>
    );
  }
  return (
    <NewSessionModelProvider organizationId={organizationId}>
      <NewSessionScreenBody />
    </NewSessionModelProvider>
  );
}
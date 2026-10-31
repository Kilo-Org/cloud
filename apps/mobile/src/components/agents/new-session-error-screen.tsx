import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';
import { cn } from '@/lib/utils';

type Props = {
  onRetry: () => void;
};

/**
 * The composer route's own failure screen, rendered by the `ErrorBoundary`
 * `src/app/(app)/agent-chat/new.tsx` exports. The app-root boundary replaces
 * the whole app with a Retry-only screen, which leaves the person with no way
 * back from a composer that cannot render. This one keeps a Back out of the
 * route, and Retry re-delivers a staged photo: the share payload a failed
 * delivery consumed is restored under the same route param.
 */
export function NewSessionErrorScreen({ onRetry }: Props) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 justify-center">
        <QueryError placement="static" className="w-full" onRetry={onRetry} />
      </View>
      <View className="px-4 pb-6">
        <Pressable
          className={cn(STATE_ACTION_CLASS, 'flex-row items-center justify-center active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace(AGENTS_SESSIONS_HREF);
          }}
        >
          <Text className="text-sm font-semibold text-foreground">{t('common.back')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

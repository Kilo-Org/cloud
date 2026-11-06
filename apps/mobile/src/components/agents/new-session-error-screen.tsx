import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QueryError } from '@/components/query-error';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';
import { clearSharePayload } from '@/lib/share-payload';
import { cn } from '@/lib/utils';

type Props = {
  onRetry: () => void;
};

/** Gap between the Back control and the safe-area edge; matches the screen's sides. */
const BACK_GAP = 16;

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
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ shareId?: string | string[] }>();
  const routeShareId = Array.isArray(params.shareId) ? params.shareId[0] : params.shareId;

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 justify-center">
        <QueryError placement="static" className="w-full" onRetry={onRetry} />
      </View>
      <View className="px-4" style={{ paddingBottom: insets.bottom + BACK_GAP }}>
        <Pressable
          className={cn(
            STATE_ACTION_CLASS,
            'flex-row items-center justify-center active:opacity-70'
          )}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={() => {
            // Leaving abandons whatever a failed delivery put back in the store:
            // the route is popped, so nothing could deliver it again.
            if (routeShareId !== undefined && routeShareId !== '') {
              clearSharePayload(routeShareId);
            }
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

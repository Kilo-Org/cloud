import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

// Mounted only once `data != null`, so useRef(initial) captures the real
// loaded value instead of the pre-fetch default.
function InstructionsEditor({
  initial,
  save,
  onSaved,
}: Readonly<{
  initial: string;
  save: ReturnType<typeof useSaveReviewConfig>;
  onSaved: () => void;
}>) {
  const valueRef = useRef(initial);
  const { t } = useTranslation();

  return (
    <Animated.View entering={FadeIn.duration(200)} className="gap-4">
      <Text className="text-sm text-muted-foreground">
        {t('codeReviewer.instructions.deprecation')}
      </Text>
      <TextInput
        className="h-32 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
        multiline
        textAlignVertical="top"
        placeholder={t('codeReviewer.instructions.placeholder')}
        defaultValue={initial}
        onChangeText={text => {
          valueRef.current = text;
        }}
      />
      <Button
        disabled={save.isPending}
        onPress={() => {
          save.mutate(
            { customInstructions: valueRef.current.trim() },
            {
              onSuccess: onSaved,
            }
          );
        }}
      >
        <Text>{t('common.save')}</Text>
      </Button>
    </Animated.View>
  );
}

export default function InstructionsRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const router = useRouter();
  const { data, isError, isFetching, refetch } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const { t } = useTranslation();

  // A failed first load is the whole body. Render it outside the page scroller
  // so QueryError's own centered ScrollView fills the screen; nested inside
  // TabScreenScrollView its `flex-1` collapses to zero height in the scroll
  // content's auto-height column, clipping the message and Retry (repos.tsx).
  const configFailed = data == null && isError;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('codeReviewer.instructions.title')} />
      {configFailed ? (
        <QueryError variant="server" onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : (
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName="px-6 pt-4"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View layout={LinearTransition} className="gap-4">
            {data == null && (
              <Animated.View exiting={FadeOut.duration(150)} className="gap-4">
                <Skeleton className="h-32 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-md" />
              </Animated.View>
            )}

            {data != null && (
              <InstructionsEditor
                initial={data.customInstructions ?? ''}
                save={save}
                onSaved={() => {
                  router.back();
                }}
              />
            )}
          </Animated.View>
        </TabScreenScrollView>
      )}
    </View>
  );
}

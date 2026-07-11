import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef } from 'react';
import { TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { parseReviewerPlatform, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { parseParam } from '@/lib/route-params';

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

  return (
    <Animated.View entering={FadeIn.duration(200)} className="gap-4">
      <TextInput
        className="h-32 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
        multiline
        textAlignVertical="top"
        placeholder="e.g. Enforce our error-handling conventions…"
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
        <Text>Save</Text>
      </Button>
    </Animated.View>
  );
}

export default function InstructionsRoute() {
  const { scope: rawScope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const scope = parseParam(rawScope);
  const platform = scope ? parseReviewerPlatform(scope, rawPlatform) : null;

  if (!scope || !platform) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <InstructionsRouteContent scope={scope} platform={platform} />;
}

function InstructionsRouteContent({
  scope,
  platform,
}: Readonly<{
  scope: string;
  platform: ReviewerPlatform;
}>) {
  const router = useRouter();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Custom Instructions" />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4"
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
    </View>
  );
}

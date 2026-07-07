import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

export default function InstructionsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  const router = useRouter();
  const { data } = useReviewConfig(scope);
  const save = useSaveReviewConfig(scope);
  const valueRef = useRef(data?.customInstructions ?? '');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Custom Instructions" />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4 pb-8"
        automaticallyAdjustKeyboardInsets
      >
        <Animated.View layout={LinearTransition} className="gap-4">
          {data == null && (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-4">
              <Skeleton className="h-32 w-full rounded-lg" />
              <Skeleton className="h-10 w-full rounded-md" />
            </Animated.View>
          )}

          {data != null && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-4">
              <TextInput
                className="h-32 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
                multiline
                textAlignVertical="top"
                placeholder="e.g. Enforce our error-handling conventions…"
                defaultValue={data.customInstructions ?? ''}
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
                      onSuccess: () => {
                        router.back();
                      },
                    }
                  );
                }}
              >
                <Text>Save</Text>
              </Button>
            </Animated.View>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

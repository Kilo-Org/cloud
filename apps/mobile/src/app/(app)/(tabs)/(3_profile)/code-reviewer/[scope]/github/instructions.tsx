import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';

export default function InstructionsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  const router = useRouter();
  const { data } = useReviewConfig(scope);
  const save = useSaveReviewConfig(scope);
  const valueRef = useRef(data?.customInstructions ?? '');

  if (data == null) {
    return <View className="flex-1 bg-background" />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Custom Instructions" />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="pt-4 pb-8 gap-4"
        automaticallyAdjustKeyboardInsets
      >
        <TextInput
          className="min-h-32 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
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
      </ScrollView>
    </View>
  );
}

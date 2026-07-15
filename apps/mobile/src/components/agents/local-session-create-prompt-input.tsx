import { TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';

type LocalSessionCreatePromptInputProps = {
  promptRef: { current: string };
  onChangePrompt: (text: string) => void;
  isSubmitting: boolean;
};

/**
 * Uncontrolled, multiline prompt input for the local-session create screen.
 *
 * The TextInput is intentionally uncontrolled: prompt content lives in a ref
 * passed by the parent and is snapshotted by the orchestrator at submit
 * time. The parent only mirrors a `hasPrompt` boolean into React state so
 * the "Start session" button can react without rebuilding the orchestrator
 * on every keystroke.
 *
 * The visible label "Prompt" is rendered above the input. The input uses
 * semantic card tokens (`bg-card`, `border-border`, `text-foreground`,
 * `placeholder:text-muted-foreground`), an explicit NativeWind line height
 * (`leading-6`), and a `min-h-32` so the input never collapses below a
 * tappable height before the user has typed anything.
 */
export function LocalSessionCreatePromptInput({
  promptRef,
  onChangePrompt,
  isSubmitting,
}: LocalSessionCreatePromptInputProps) {
  return (
    <View className="mt-4 rounded-2xl border border-border bg-card p-4">
      <Text className="mb-2 text-sm font-medium text-foreground">Prompt</Text>
      <TextInput
        editable={!isSubmitting}
        multiline
        defaultValue={promptRef.current}
        onChangeText={onChangePrompt}
        placeholder="Describe what you want the agent to do..."
        placeholderClassName="text-muted-foreground"
        className="min-h-32 rounded-lg bg-background px-3 py-2 text-base text-foreground leading-6"
        textAlignVertical="top"
        accessibilityLabel="Prompt"
      />
    </View>
  );
}

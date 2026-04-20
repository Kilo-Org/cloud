import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

// Types matching the SDK's QuestionState structure
type QuestionOption = {
  label: string;
  description: string;
  mode?: string;
};

type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

type QuestionCardProps = {
  questions: QuestionInfo[];
  onAnswer: (answers: string[][]) => void;
  onReject: () => void;
  isSubmitting?: boolean;
};

export function QuestionCard({
  questions,
  onAnswer,
  onReject,
  isSubmitting = false,
}: Readonly<QuestionCardProps>) {
  const colors = useThemeColors();
  const [selectedOptions, setSelectedOptions] = useState<Record<number, Set<number>>>({});
  const [customSelected, setCustomSelected] = useState<Record<number, boolean>>({});
  const customInputs = useRef<Record<number, string>>({});
  const [customHasText, setCustomHasText] = useState<Record<number, boolean>>({});

  function toggleOption(questionIndex: number, optionIndex: number, multiple: boolean | undefined) {
    setSelectedOptions(prev => {
      const prevSet = prev[questionIndex];
      const current = prevSet ? new Set(prevSet) : new Set<number>();
      if (multiple) {
        if (current.has(optionIndex)) {
          current.delete(optionIndex);
        } else {
          current.add(optionIndex);
        }
      } else {
        current.clear();
        current.add(optionIndex);
      }
      return { ...prev, [questionIndex]: current };
    });
    // Single select: deselect custom when a preset option is picked
    if (!multiple) {
      setCustomSelected(prev => ({ ...prev, [questionIndex]: false }));
    }
  }

  function toggleCustom(questionIndex: number, multiple: boolean | undefined) {
    setCustomSelected(prev => {
      const wasSelected = prev[questionIndex] ?? false;
      if (!multiple && !wasSelected) {
        // Single select: deselect preset options when custom is toggled on
        setSelectedOptions(p => ({ ...p, [questionIndex]: new Set<number>() }));
      }
      return { ...prev, [questionIndex]: !wasSelected };
    });
  }

  function handleCustomTextChange(questionIndex: number, text: string) {
    customInputs.current[questionIndex] = text;
    const hasText = text.trim().length > 0;
    setCustomHasText(prev =>
      prev[questionIndex] === hasText ? prev : { ...prev, [questionIndex]: hasText }
    );
    // Auto-select custom when the user starts typing
    if (text.trim().length > 0 && !customSelected[questionIndex]) {
      const question = questions[questionIndex];
      if (!question?.multiple) {
        // Single select: deselect preset options
        setSelectedOptions(prev => ({ ...prev, [questionIndex]: new Set<number>() }));
      }
      setCustomSelected(prev => ({ ...prev, [questionIndex]: true }));
    }
  }

  function buildAnswers(): string[][] {
    return questions.map((q, qIndex) => {
      const selected = selectedOptions[qIndex];
      const labels =
        selected && selected.size > 0
          ? [...selected].map(oIndex => {
              const option = q.options[oIndex];
              return option ? option.label : '';
            })
          : [];

      const isCustom = customSelected[qIndex] ?? false;
      const customText = isCustom ? (customInputs.current[qIndex] ?? '').trim() : '';
      return customText ? [...labels, customText] : labels;
    });
  }

  function handleSubmit() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answers = buildAnswers();

    const unanswered = answers.findIndex(a => a.length === 0);
    if (unanswered !== -1) {
      Alert.alert('Please Answer All Questions', `Question ${unanswered + 1} needs an answer.`);
      return;
    }

    onAnswer(answers);
  }

  function handleReject() {
    Alert.alert('Skip Questions?', 'The agent will skip this step.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Skip', style: 'destructive', onPress: onReject },
    ]);
  }

  const hasOptionSelected = Object.values(selectedOptions).some(s => s.size > 0);
  const hasCustomAnswer = Object.entries(customSelected).some(
    ([idx, selected]) => selected && customHasText[Number(idx)]
  );
  const hasAnyAnswer = hasOptionSelected || hasCustomAnswer;

  return (
    <View className="mx-4 my-2 overflow-hidden rounded-xl border border-border bg-card">
      <View className="border-b border-border bg-secondary px-4 py-3">
        <Text className="text-sm font-medium">Agent Needs Input</Text>
      </View>

      <ScrollView className="max-h-96" keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-4">
          {questions.map((question, qIndex) => {
            const allowCustom = question.custom !== false;
            const isCustomActive = customSelected[qIndex] ?? false;
            return (
              <View key={qIndex} className="gap-2">
                <Text className="text-sm font-medium text-foreground">{question.question}</Text>
                {question.multiple && (
                  <Text className="text-xs text-muted-foreground">Select all that apply</Text>
                )}
                <View className="gap-1">
                  {question.options.map((option, oIndex) => {
                    const isSelected = selectedOptions[qIndex]?.has(oIndex) ?? false;
                    return (
                      <Button
                        key={oIndex}
                        variant={isSelected ? 'default' : 'outline'}
                        size="sm"
                        onPress={() => {
                          toggleOption(qIndex, oIndex, question.multiple);
                        }}
                        disabled={isSubmitting}
                        accessibilityRole="button"
                        accessibilityLabel={`${option.label}${isSelected ? ', selected' : ''}`}
                        className={cn(
                          'h-auto justify-start py-2.5',
                          isSelected ? 'bg-primary' : 'bg-background'
                        )}
                      >
                        <Text
                          className={cn(
                            'text-left text-sm',
                            isSelected ? 'text-primary-foreground' : 'text-foreground'
                          )}
                        >
                          {option.label}
                        </Text>
                      </Button>
                    );
                  })}
                  {allowCustom && (
                    <Pressable
                      onPress={() => {
                        toggleCustom(qIndex, question.multiple);
                      }}
                      disabled={isSubmitting}
                      className={cn(
                        'flex-row items-center rounded-md border px-3 py-2.5 shadow-sm shadow-black/5',
                        isCustomActive
                          ? 'border-primary bg-primary'
                          : 'border-border bg-background dark:border-neutral-700 dark:bg-secondary',
                        isSubmitting && 'opacity-50'
                      )}
                    >
                      <TextInput
                        defaultValue=""
                        onChangeText={text => {
                          handleCustomTextChange(qIndex, text);
                        }}
                        placeholder="Type your own answer…"
                        placeholderTextColor={colors.mutedForeground}
                        editable={!isSubmitting}
                        className={cn(
                          'flex-1 py-0.5 text-sm',
                          isCustomActive ? 'text-primary-foreground' : 'text-foreground'
                        )}
                      />
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>

      <View className="flex-row gap-2 border-t border-border p-3">
        <Button variant="outline" className="flex-1" onPress={handleReject} disabled={isSubmitting}>
          <Text className="text-sm">Skip</Text>
        </Button>
        <Button className="flex-1" onPress={handleSubmit} disabled={!hasAnyAnswer || isSubmitting}>
          {isSubmitting ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : null}
          <Text className={cn('text-sm', isSubmitting ? 'ml-2' : '')}>
            {isSubmitting ? 'Submitting…' : 'Submit'}
          </Text>
        </Button>
      </View>
    </View>
  );
}

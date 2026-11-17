import { useRef, useState } from 'react';
import { type TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { type NativePendingQuestion } from '@kilocode/cloud-agent-sdk';

type QuestionField = NativePendingQuestion['fields'][number];

export function NativeRemoteQuestion({
  question,
  disabled,
  reply,
  reject,
}: {
  question: NativePendingQuestion;
  disabled: boolean;
  reply: (answers: string[][]) => void;
  reject: () => void;
}) {
  const { t } = useTranslation();
  const answers = useRef<string[][]>(question.fields.map(() => []));
  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <Text accessibilityRole="header">{question.title ?? t('agentChat.questionCard.title')}</Text>
      {question.fields.map((field, index) => (
        <NativeQuestionField
          key={field.key}
          field={field}
          disabled={disabled}
          onChange={value => {
            answers.current[index] = value;
          }}
        />
      ))}
      <View className="flex-row flex-wrap gap-2">
        <Button
          disabled={disabled}
          onPress={() => {
            reply(answers.current);
          }}
        >
          <Text>{t('common.reply')}</Text>
        </Button>
        <Button variant="outline" disabled={disabled} onPress={reject}>
          <Text>{t('agentChat.questionCard.skip')}</Text>
        </Button>
      </View>
    </View>
  );
}

function NativeQuestionField({
  field,
  disabled,
  onChange,
}: {
  field: QuestionField;
  disabled: boolean;
  onChange: (answer: string[]) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const custom = useRef<string[]>([]);
  const input = useRef<TextInput>(null);
  const multiple = field.type === 'multiselect';
  const label = field.title ?? field.description ?? field.key;
  return (
    <View className="gap-2">
      <Text>{label}</Text>
      {field.description && field.title ? (
        <Text className="text-muted-foreground">{field.description}</Text>
      ) : null}
      {field.options?.map(option => (
        <Button
          key={option.value}
          variant={selected.includes(option.value) ? 'secondary' : 'outline'}
          disabled={disabled}
          accessibilityRole={multiple ? 'checkbox' : 'radio'}
          accessibilityState={{ checked: selected.includes(option.value) }}
          onPress={() => {
            let next = [option.value];
            if (multiple) {
              next = selected.includes(option.value)
                ? selected.filter(value => value !== option.value)
                : [...selected, option.value];
            }
            setSelected(next);
            if (!multiple) {
              custom.current = [];
              input.current?.clear();
            }
            onChange([...next, ...custom.current]);
          }}
        >
          <Text>{option.label ?? option.value}</Text>
        </Button>
      ))}
      {!field.options?.length || field.custom ? (
        <Input
          ref={input}
          accessibilityLabel={label}
          placeholder={t('agentChat.questionCard.typeYourOwnAnswerPlaceholder')}
          defaultValue=""
          editable={!disabled}
          multiline={multiple}
          className={multiple ? 'min-h-[88px] leading-[1.25rem]' : undefined}
          onChangeText={text => {
            if (!multiple) {
              setSelected([]);
            }
            const typed = (multiple ? text.split('\n') : [text])
              .map(value => value.trim())
              .filter(value => value.length > 0);
            custom.current = typed;
            onChange([...(multiple ? selected : []), ...typed]);
          }}
        />
      ) : null}
    </View>
  );
}

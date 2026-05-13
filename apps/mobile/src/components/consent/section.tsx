import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type SectionProps = {
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly who: string;
  readonly footer?: ReactNode;
};

type FieldProps = {
  readonly label: string;
  readonly value: string;
};

function Field({ label, value }: FieldProps) {
  return (
    <Text className="mt-1 text-sm text-muted-foreground">
      <Text className="text-sm font-semibold text-foreground">{label}: </Text>
      {value}
    </Text>
  );
}

export function Section({ title, what, why, who, footer }: SectionProps) {
  return (
    <View className="border-t border-border py-4">
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      <Field label="What" value={what} />
      <Field label="Why" value={why} />
      <Field label="Who" value={who} />
      {footer}
    </View>
  );
}

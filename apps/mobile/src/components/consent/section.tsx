import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  return (
    <View className="border-t border-border py-4">
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      <Field label={t('consent.what')} value={what} />
      <Field label={t('consent.why')} value={why} />
      <Field label={t('consent.who')} value={who} />
      {footer}
    </View>
  );
}

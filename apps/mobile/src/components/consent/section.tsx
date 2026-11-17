import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Card } from '@/components/ui/card';
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
    <Text variant="muted">
      <Text variant="small">{label}: </Text>
      {value}
    </Text>
  );
}

export function Section({ title, what, why, who, footer }: SectionProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <Text variant="heading">{title}</Text>
      <View className="gap-1">
        <Field label={t('consent.what')} value={what} />
        <Field label={t('consent.why')} value={why} />
        <Field label={t('consent.who')} value={who} />
      </View>
      {footer}
    </Card>
  );
}

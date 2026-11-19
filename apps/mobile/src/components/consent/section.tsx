import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Card } from '@/components/ui/card';
import { Section as LabelledSection } from '@/components/ui/section';
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

/**
 * One fact the group discloses: its name on a caption line, the answer under
 * it. The label used to run inline on the answer's first line, which gave that
 * line a tighter leading than its own wrapped lines and left the fields running
 * together; stacked, every line is the value's line height and the card's own
 * gap separates the fields.
 */
function Field({ label, value }: FieldProps) {
  return (
    <View className="gap-1">
      <Text variant="caption">{label}</Text>
      <Text variant="muted">{value}</Text>
    </View>
  );
}

/** One disclosed data group: the section's mono eyebrow over its card. */
export function Section({ title, what, why, who, footer }: SectionProps) {
  const { t } = useTranslation();
  return (
    <LabelledSection label={title}>
      <Card>
        <Field label={t('consent.what')} value={what} />
        <Field label={t('consent.why')} value={why} />
        <Field label={t('consent.who')} value={who} />
        {footer}
      </Card>
    </LabelledSection>
  );
}

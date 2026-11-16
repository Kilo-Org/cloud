import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { FilterChip } from '@/components/ui/filter-chip';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  type DetectorChoice,
  GUARDRAILS_LIMITS,
  PII_ENTITIES,
  type PiiEntity,
  type PolicyFormat,
} from '@/lib/organization/guardrails-draft';

const PII_ENTITY_LABEL_KEYS = {
  pii: 'organizationGuardrails.pii.personalData.label',
  secrets: 'organizationGuardrails.pii.secrets.label',
  ip_address: 'organizationGuardrails.pii.ipAddress.label',
  url: 'organizationGuardrails.pii.url.label',
} satisfies Record<PiiEntity, string>;

const PII_ENTITY_DESCRIPTION_KEYS = {
  pii: 'organizationGuardrails.pii.personalData.description',
  secrets: 'organizationGuardrails.pii.secrets.description',
  ip_address: 'organizationGuardrails.pii.ipAddress.description',
  url: 'organizationGuardrails.pii.url.description',
} satisfies Record<PiiEntity, string>;

const POLICY_FORMAT_KEYS = {
  rules: 'organizationGuardrails.policyFormatRules',
  policy_text: 'organizationGuardrails.policyFormatText',
} satisfies Record<PolicyFormat, string>;

/** One detector: its name and description, the Off / Log only / Block choice, and its options. */
export function DetectorCard({
  label,
  description,
  choice,
  onChoiceChange,
  disabled,
  children,
}: Readonly<{
  label: string;
  description: string;
  choice: DetectorChoice;
  onChoiceChange: (next: DetectorChoice) => void;
  disabled: boolean;
  children?: ReactNode;
}>) {
  const { t } = useTranslation();
  const options = [
    { value: 'off' as const, label: t('common.off') },
    { value: 'log' as const, label: t('organizationGuardrails.choiceLog') },
    { value: 'block' as const, label: t('codeReviewer.decision.block') },
  ];
  return (
    <View className="gap-3 rounded-lg bg-secondary p-3">
      <View className="gap-1">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      <SegmentedControl
        options={options}
        value={choice}
        onChange={onChoiceChange}
        disabled={disabled}
        accessibilityLabel={label}
      />
      {choice === 'off' ? null : (
        <View className={disabled ? 'pointer-events-none opacity-50' : undefined}>{children}</View>
      )}
    </View>
  );
}

/** The PII detector's four data kinds, each a chip the admin turns on or off. */
export function PiiEntitiesField({
  entities,
  onChange,
  disabled,
}: Readonly<{
  entities: readonly PiiEntity[];
  onChange: (next: PiiEntity[]) => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">
        {t('organizationGuardrails.piiEntities')}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {PII_ENTITIES.map(entity => {
          const selected = entities.includes(entity);
          return (
            <View key={entity} className="gap-1">
              <FilterChip
                label={t(PII_ENTITY_LABEL_KEYS[entity])}
                selected={selected}
                disabled={disabled}
                onPress={() => {
                  onChange(
                    selected ? entities.filter(value => value !== entity) : [...entities, entity]
                  );
                }}
              />
              <Text className="max-w-44 text-xs text-muted-foreground">
                {t(PII_ENTITY_DESCRIPTION_KEYS[entity])}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/**
 * A detector's list of keywords or topics: one entry per line. The field keeps
 * its own text in the screen's draft, so a section collapse or another
 * detector's edit never discards what was typed.
 */
export function LineListField({
  label,
  hint,
  value,
  maxLength,
  onChange,
  disabled,
}: Readonly<{
  label: string;
  hint: string;
  value: string;
  maxLength: number;
  onChange: (next: string) => void;
  disabled: boolean;
}>) {
  return (
    <View className="gap-1.5">
      <FormField
        label={label}
        multiline
        numberOfLines={3}
        maxLength={maxLength}
        defaultValue={value}
        disabled={disabled}
        onChangeText={onChange}
      />
      <Text className="text-xs text-muted-foreground">{hint}</Text>
    </View>
  );
}

/** The policy violation detector's format choice and the text or rules it saves. */
export function PolicyFormatField({
  format,
  onChange,
  disabled,
}: Readonly<{
  format: PolicyFormat;
  onChange: (next: PolicyFormat) => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">
        {t('organizationGuardrails.policyFormat')}
      </Text>
      <SegmentedControl
        options={[
          { value: 'rules' as const, label: t(POLICY_FORMAT_KEYS.rules) },
          { value: 'policy_text' as const, label: t(POLICY_FORMAT_KEYS.policy_text) },
        ]}
        value={format}
        onChange={onChange}
        disabled={disabled}
        accessibilityLabel={t('organizationGuardrails.policyFormat')}
      />
      <Text className="text-xs text-muted-foreground">
        {format === 'rules'
          ? t('organizationGuardrails.policyFormatRulesDescription')
          : t('organizationGuardrails.policyFormatTextDescription')}
      </Text>
    </View>
  );
}

export function PolicyTextField({
  value,
  onChange,
  disabled,
}: Readonly<{
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  return (
    <FormField
      label={t('organizationGuardrails.policyFormatText')}
      multiline
      numberOfLines={5}
      maxLength={GUARDRAILS_LIMITS.policyTextLength}
      defaultValue={value}
      disabled={disabled}
      onChangeText={onChange}
    />
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { INPUT_DETECTOR_COPY } from '@/components/organization/guardrails-copy';
import {
  DetectorCard,
  PolicyFormatField,
  PolicyTextField,
} from '@/components/organization/guardrails-detector-editor';
import { PolicyRulesEditor } from '@/components/organization/guardrails-policy-rules';
import {
  SettingsSection,
  SettingsValueRow,
} from '@/components/organization/settings-form-sections';
import { Button } from '@/components/ui/button';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { Text } from '@/components/ui/text';
import {
  applyKiloDefaultPreset,
  detectorChoice,
  type GuardrailsDraft,
  INPUT_DETECTOR_IDS,
  type OrgGuardrailsGroup,
  withInputDetectorChoice,
} from '@/lib/organization/guardrails-draft';

/**
 * The input guardrail: its master switch, the members it applies to, and the
 * detectors that scan requests on the way in. Policy violation carries its own
 * rules editor or policy text, so the section owns that sub-form.
 */
export function InputGuardrailsSection({
  draft,
  groups,
  disabled,
  onChange,
}: Readonly<{
  draft: GuardrailsDraft;
  groups: readonly OrgGuardrailsGroup[];
  disabled: boolean;
  onChange: (update: (current: GuardrailsDraft) => GuardrailsDraft) => void;
}>) {
  const { t } = useTranslation();
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  // Apply Kilo Default rewrites the policy text, and the field below reads it
  // only on mount: the sub-form is remounted so the text on screen is the
  // draft's.
  const [policyGeneration, setPolicyGeneration] = useState(0);
  const policy = draft.detectors.policy_violation;

  const setPolicy = (patch: {
    format?: typeof policy.format;
    rules?: typeof policy.rules;
    policy_text?: string;
  }) => {
    onChange(current => ({
      ...current,
      detectors: {
        ...current.detectors,
        policy_violation: { ...current.detectors.policy_violation, ...patch },
      },
    }));
  };

  const selectedGroupName =
    draft.groupId == null
      ? t('organizationGuardrails.applyToAllMembers')
      : (groups.find(group => group.id === draft.groupId)?.name ?? draft.groupId);

  return (
    <SettingsSection
      title={t('organizationGuardrails.inputTitle')}
      description={t('organizationGuardrails.inputDescription')}
      enabled={draft.inputEnabled}
      switchDisabled={disabled}
      onEnabledChange={next => {
        onChange(current => ({ ...current, inputEnabled: next }));
      }}
    >
      {groups.length > 0 || draft.groupId != null ? (
        <SettingsValueRow
          label={t('organizationGuardrails.applyTo')}
          value={selectedGroupName}
          disabled={disabled}
          onPress={() => {
            setGroupPickerOpen(true);
          }}
        />
      ) : null}
      <Text className="text-xs text-muted-foreground">
        {t('organizationGuardrails.detectorsHint')}
      </Text>
      {INPUT_DETECTOR_IDS.map(id => {
        const copy = INPUT_DETECTOR_COPY[id];
        return (
          <DetectorCard
            key={id}
            label={t(copy.label)}
            description={t(copy.description)}
            choice={detectorChoice(draft.detectors[id])}
            disabled={disabled}
            onChoiceChange={choice => {
              onChange(current => ({
                ...current,
                detectors: withInputDetectorChoice(current.detectors, id, choice),
              }));
            }}
          >
            {id === 'policy_violation' && policy.enabled ? (
              <View key={`policy-${policyGeneration}`} className="gap-3">
                <PolicyFormatField
                  format={policy.format}
                  disabled={disabled}
                  onChange={format => {
                    setPolicy({ format });
                  }}
                />
                {policy.format === 'rules' ? (
                  <PolicyRulesEditor
                    rules={policy.rules}
                    disabled={disabled}
                    onChange={rules => {
                      setPolicy({ rules });
                    }}
                  />
                ) : (
                  <PolicyTextField
                    value={policy.policy_text}
                    disabled={disabled}
                    onChange={policy_text => {
                      setPolicy({ policy_text });
                    }}
                  />
                )}
              </View>
            ) : null}
          </DetectorCard>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        onPress={() => {
          onChange(current => ({
            ...current,
            detectors: applyKiloDefaultPreset(current.detectors),
          }));
          setPolicyGeneration(generation => generation + 1);
        }}
      >
        <Text>{t('organizationGuardrails.applyKiloDefault')}</Text>
      </Button>

      <MenuSheet
        visible={groupPickerOpen}
        title={t('organizationGuardrails.applyTo')}
        options={[
          {
            label: t('organizationGuardrails.applyToAllMembers'),
            selected: draft.groupId == null,
          },
          ...groups.map(group => ({
            label: group.name,
            selected: draft.groupId === group.id,
          })),
        ]}
        cancelLabel={t('common.cancel')}
        onSelect={index => {
          const groupId = index === 0 ? null : (groups[index - 1]?.id ?? null);
          onChange(current => ({ ...current, groupId }));
          setGroupPickerOpen(false);
        }}
        onClose={() => {
          setGroupPickerOpen(false);
        }}
      />
    </SettingsSection>
  );
}

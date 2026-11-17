import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { OUTPUT_DETECTOR_COPY } from '@/components/organization/guardrails-copy';
import {
  DetectorCard,
  LineListField,
  PiiEntitiesField,
  PolicyFormatField,
  PolicyTextField,
} from '@/components/organization/guardrails-detector-editor';
import { PolicyRulesEditor } from '@/components/organization/guardrails-policy-rules';
import { SettingsSection } from '@/components/organization/settings-form-sections';
import { Text } from '@/components/ui/text';
import {
  detectorChoice,
  type GuardrailsDraft,
  OUTPUT_DETECTOR_IDS,
  type OutputDetectorsDraft,
  withOutputDetectorChoice,
} from '@/lib/organization/guardrails-draft';

/**
 * The output guardrail: what Kilo scans in a model's response before a member
 * receives it. Each detector carries its own editor, so the section maps the
 * detector ids to the fields they add.
 */
export function OutputGuardrailsSection({
  draft,
  disabled,
  onChange,
}: Readonly<{
  draft: GuardrailsDraft;
  disabled: boolean;
  onChange: (update: (current: GuardrailsDraft) => GuardrailsDraft) => void;
}>) {
  const { t } = useTranslation();
  const detectors = draft.outputDetectors;
  const policy = detectors.policy_violation;

  const setDetectors = (update: (current: OutputDetectorsDraft) => OutputDetectorsDraft) => {
    onChange(current => ({ ...current, outputDetectors: update(current.outputDetectors) }));
  };

  return (
    <SettingsSection
      title={t('organizationGuardrails.outputTitle')}
      description={t('organizationGuardrails.outputDescription')}
      enabled={draft.outputEnabled}
      switchDisabled={disabled}
      onEnabledChange={next => {
        onChange(current => ({ ...current, outputEnabled: next }));
      }}
    >
      <Text variant="caption">
        {t('organizationGuardrails.detectorsHintOutput')}
      </Text>
      <Text variant="caption">
        {t('organizationGuardrails.blockingOutputNote')}
      </Text>
      {OUTPUT_DETECTOR_IDS.map(id => {
        const copy = OUTPUT_DETECTOR_COPY[id];
        return (
          <DetectorCard
            key={id}
            label={t(copy.label)}
            description={t(copy.description)}
            choice={detectorChoice(detectors[id])}
            disabled={disabled}
            onChoiceChange={choice => {
              setDetectors(current => withOutputDetectorChoice(current, id, choice));
            }}
          >
            {id === 'pii' ? (
              <PiiEntitiesField
                entities={detectors.pii.entities}
                disabled={disabled}
                onChange={entities => {
                  setDetectors(current => ({
                    ...current,
                    pii: { ...current.pii, entities },
                  }));
                }}
              />
            ) : null}
            {id === 'keyword_detector' ? (
              <LineListField
                label={t('organizationGuardrails.keywordsLabel')}
                hint={t('organizationGuardrails.keywordsHint')}
                value={detectors.keyword_detector.banned_keywords}
                disabled={disabled}
                onChange={banned_keywords => {
                  setDetectors(current => ({
                    ...current,
                    keyword_detector: { ...current.keyword_detector, banned_keywords },
                  }));
                }}
              />
            ) : null}
            {id === 'topic_detector' ? (
              <LineListField
                label={t('organizationGuardrails.detector.topics.label')}
                hint={t('organizationGuardrails.topicsHint')}
                value={detectors.topic_detector.topic}
                disabled={disabled}
                onChange={topic => {
                  setDetectors(current => ({
                    ...current,
                    topic_detector: { ...current.topic_detector, topic },
                  }));
                }}
              />
            ) : null}
            {id === 'policy_violation' ? (
              <View className="gap-3">
                <PolicyFormatField
                  format={policy.format}
                  disabled={disabled}
                  onChange={format => {
                    setDetectors(current => ({
                      ...current,
                      policy_violation: { ...current.policy_violation, format },
                    }));
                  }}
                />
                {policy.format === 'rules' ? (
                  <PolicyRulesEditor
                    rules={policy.rules}
                    disabled={disabled}
                    onChange={rules => {
                      setDetectors(current => ({
                        ...current,
                        policy_violation: { ...current.policy_violation, rules },
                      }));
                    }}
                  />
                ) : (
                  <PolicyTextField
                    value={policy.policy_text}
                    disabled={disabled}
                    onChange={policy_text => {
                      setDetectors(current => ({
                        ...current,
                        policy_violation: { ...current.policy_violation, policy_text },
                      }));
                    }}
                  />
                )}
              </View>
            ) : null}
          </DetectorCard>
        );
      })}
    </SettingsSection>
  );
}

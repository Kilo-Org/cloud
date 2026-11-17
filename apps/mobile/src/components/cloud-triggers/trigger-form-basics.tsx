/**
 * The first block of the trigger form: what the trigger is called, what fires
 * it, when it fires on a schedule, and where it runs.
 *
 * A created trigger's name, repository and activation never change, so the edit
 * form shows them as saved values with the reason they are fixed, exactly as the
 * web form does.
 */

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { RepoPickerSheet } from '@/components/profiles/repo-picker-sheet';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { triggerProblemText } from '@/lib/cloud-triggers/trigger-problem-copy';
import { TRIGGER_FIELD_EXAMPLES } from '@/lib/cloud-triggers/trigger-field-examples';
import {
  defaultPrompt,
  type TriggerActivation,
  type TriggerDraft,
  type TriggerDraftProblems,
} from '@/lib/cloud-triggers/trigger-draft';
import { useTouchedProblems } from '@/lib/cloud-triggers/use-touched-problems';
import { useTriggerRepositories } from '@/lib/cloud-triggers/use-trigger-options';

import { TriggerSelectRow } from './trigger-form-rows';

const ACTIVATION_OPTIONS = [
  { value: 'webhook' as const, labelKey: 'cloudAgent.triggers.activationWebhook' },
  { value: 'scheduled' as const, labelKey: 'common.scheduled' },
];

type TriggerFormBasicsProps = Readonly<{
  mode: 'create' | 'edit';
  organizationId?: string;
  draft: TriggerDraft;
  problems: TriggerDraftProblems;
  onDraftChange: (next: TriggerDraft) => void;
  repositoryPickerOpen: boolean;
  onRepositoryPickerOpenChange: (open: boolean) => void;
}>;

export function TriggerFormBasics({
  mode,
  organizationId,
  draft,
  problems,
  onDraftChange,
  repositoryPickerOpen,
  onRepositoryPickerOpenChange,
}: TriggerFormBasicsProps) {
  const { t } = useTranslation();
  const repositories = useTriggerRepositories(organizationId, repositoryPickerOpen);
  const isScheduled = draft.activation === 'scheduled';
  const { markTouched, shownProblem } = useTouchedProblems(problems);
  const activate = (activation: TriggerActivation) => {
    // A prompt still on the other activation's default follows the choice, so a
    // scheduled trigger does not start out describing a webhook body.
    onDraftChange({
      ...draft,
      activation,
      prompt:
        draft.prompt === defaultPrompt(draft.activation) ? defaultPrompt(activation) : draft.prompt,
    });
  };
  return (
    <View className="gap-4">
      {mode === 'create' ? (
        <FormField
          label={t('cloudAgent.triggers.fieldName')}
          required
          defaultValue={draft.name}
          onChangeText={name => {
            onDraftChange({ ...draft, name });
          }}
          error={triggerProblemText(shownProblem('name'))}
          onBlur={() => {
            markTouched('name');
          }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          maxLength={64}
        />
      ) : (
        <View className="gap-1">
          <Text variant="muted">{t('cloudAgent.triggers.fieldName')}</Text>
          <Text variant="mono">{draft.name}</Text>
          <Text variant="caption">{t('cloudAgent.triggers.nameLocked')}</Text>
        </View>
      )}

      <View className="gap-2">
        <Text variant="muted">{t('cloudAgent.triggers.fieldActivation')}</Text>
        {mode === 'create' ? (
          <SegmentedControl
            options={ACTIVATION_OPTIONS.map(option => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            value={draft.activation}
            onChange={activate}
            accessibilityLabel={t('cloudAgent.triggers.fieldActivation')}
          />
        ) : (
          <Text>
            {isScheduled ? t('common.scheduled') : t('cloudAgent.triggers.activationWebhook')}
          </Text>
        )}
      </View>

      {isScheduled && (
        <View className="gap-4">
          <FormField
            label={t('cloudAgent.triggers.fieldCron')}
            required
            defaultValue={draft.cron}
            onChangeText={cron => {
              onDraftChange({ ...draft, cron });
            }}
            error={triggerProblemText(shownProblem('cron'))}
            onBlur={() => {
              markTouched('cron');
            }}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder={TRIGGER_FIELD_EXAMPLES.cron}
          />
          <Text variant="caption">{t('cloudAgent.triggers.fieldCronHelp')}</Text>
          <FormField
            label={t('cloudAgent.triggers.fieldTimezone')}
            defaultValue={draft.timezone}
            onChangeText={timezone => {
              onDraftChange({ ...draft, timezone });
            }}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder={TRIGGER_FIELD_EXAMPLES.timeZone}
          />
        </View>
      )}

      <View className="gap-1">
        {mode === 'create' ? (
          <>
            <TriggerSelectRow
              label={t('common.repository')}
              value={
                draft.repository.length === 0
                  ? t('cloudAgent.triggers.notSelected')
                  : draft.repository
              }
              onPress={() => {
                markTouched('repository');
                onRepositoryPickerOpenChange(true);
              }}
              error={triggerProblemText(shownProblem('repository'))}
            />
            <Text variant="caption">{t('cloudAgent.triggers.repositoryLocked')}</Text>
          </>
        ) : (
          <>
            <Text variant="muted">{t('common.repository')}</Text>
            <Text variant="mono">{draft.repository}</Text>
            <Text variant="caption">{t('cloudAgent.triggers.repositoryLocked')}</Text>
          </>
        )}
      </View>

      {repositoryPickerOpen ? (
        <RepoPickerSheet
          repositories={repositories.repositories}
          isLoading={repositories.isLoading}
          isError={repositories.isError}
          onRetry={() => {
            repositories.refetch();
          }}
          selectedKey={draft.repository.length === 0 ? null : `github:${draft.repository}`}
          onSelect={repository => {
            onRepositoryPickerOpenChange(false);
            onDraftChange({
              ...draft,
              repository: repository.fullName,
              environmentId: null,
            });
          }}
          onClose={() => {
            onRepositoryPickerOpenChange(false);
          }}
        />
      ) : null}
    </View>
  );
}

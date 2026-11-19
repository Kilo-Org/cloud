/**
 * The second block of the trigger form: the agent a run starts, its model and
 * reasoning effort, and the environment and profile the run uses.
 *
 * The agent is a built-in mode or a named agent from the repository (the web
 * form's "Custom agent"), so the sheet offers the built-in modes and one row
 * that reveals the slug field. The model control is the app's own
 * `ModelSelector`, which carries the reasoning effort in the same pick.
 */

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  getBuiltinModeDescriptionKey,
  getBuiltinModeLabelKey,
} from '@/components/agents/mode-options';
import { BUILTIN_AGENT_MODES } from '@/components/agents/mode-normalize';
import { ModelSelector } from '@/components/agents/model-selector';
import { QueryError } from '@/components/query-error';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { triggerProblemText } from '@/lib/cloud-triggers/trigger-problem-copy';
import { type TriggerDraft, type TriggerDraftProblems } from '@/lib/cloud-triggers/trigger-draft';
import { TRIGGER_FIELD_EXAMPLES } from '@/lib/cloud-triggers/trigger-field-examples';
import { useTouchedProblems } from '@/lib/cloud-triggers/use-touched-problems';
import {
  useTriggerEnvironments,
  useTriggerProfiles,
} from '@/lib/cloud-triggers/use-trigger-options';
import { useAvailableModels } from '@/lib/hooks/use-available-models';

import { type TriggerChoice, TriggerChoiceSheet } from './trigger-choice-sheet';
import { TriggerSelectRow } from './trigger-form-rows';

/** The one picker sheet this block opens, or `null` when none is presented. */
export type TriggerAgentSheet = 'agent' | 'environment' | 'profile' | null;

type TriggerFormAgentProps = Readonly<{
  organizationId?: string;
  draft: TriggerDraft;
  problems: TriggerDraftProblems;
  onDraftChange: (next: TriggerDraft) => void;
  openSheet: TriggerAgentSheet;
  onOpenSheetChange: (sheet: TriggerAgentSheet) => void;
}>;

export function TriggerFormAgent({
  organizationId,
  draft,
  problems,
  onDraftChange,
  openSheet,
  onOpenSheetChange,
}: TriggerFormAgentProps) {
  const { t } = useTranslation();
  const models = useAvailableModels(organizationId, 'shared_services');
  const environments = useTriggerEnvironments(organizationId, draft.repository);
  // The server checks a profile against the run's owner: a trigger that runs as
  // its creator takes the caller's own profiles, never the organization's.
  // Loaded up front so a saved profile's name shows before the sheet is opened.
  const profiles = useTriggerProfiles(draft.runAsCreator ? undefined : organizationId, true);
  const isCustomAgent = !BUILTIN_AGENT_MODES.some(mode => mode === draft.agent);
  const { markTouched, shownProblem } = useTouchedProblems(problems);
  // TanStack Query v5 resets a no-data query to `pending` when it refetches,
  // clearing `error`, so `isError` alone would unmount the failure row (and its
  // retry) the moment the retry is pressed. Keeping the failed state through
  // the refetch leaves the row in place and lets the retry show its busy state
  // until the request settles. Same contract as the tool-summary settings
  // screen and `use-current-user-id`.
  const catalogueFailed =
    (models.isError || (models.isLoading && models.isFetched)) && models.models.length === 0;

  const agentOptions: TriggerChoice[] = [
    ...BUILTIN_AGENT_MODES.map(mode => ({
      value: mode,
      label: t(getBuiltinModeLabelKey(mode) ?? mode),
      description: t(getBuiltinModeDescriptionKey(mode) ?? ''),
    })),
    { value: null, label: t('cloudAgent.triggers.customAgent') },
  ];
  const agentValue = isCustomAgent
    ? t('cloudAgent.triggers.customAgent')
    : t(getBuiltinModeLabelKey(draft.agent) ?? draft.agent);
  const selectedEnvironment = environments.environments.find(
    environment => environment.id === draft.environmentId
  );
  const selectedProfile = profiles.profiles.find(profile => profile.id === draft.profileId);
  const modelProblemText = triggerProblemText(shownProblem('model'));

  return (
    <View className="gap-4">
      <View className="gap-1">
        <TriggerSelectRow
          label={t('common.agent')}
          value={draft.agent.length === 0 ? t('cloudAgent.triggers.customAgent') : agentValue}
          onPress={() => {
            markTouched('agent');
            onOpenSheetChange('agent');
          }}
          error={triggerProblemText(shownProblem('agent'))}
        />
        <Text variant="caption">{t('cloudAgent.triggers.agentHelp')}</Text>
      </View>
      {isCustomAgent && (
        <FormField
          label={t('profiles.agents.slug')}
          required
          defaultValue={draft.agent}
          onChangeText={agent => {
            onDraftChange({ ...draft, agent });
          }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder={TRIGGER_FIELD_EXAMPLES.agent}
          maxLength={50}
        />
      )}

      <View className="gap-2">
        <ModelSelector
          value={draft.model}
          variant={draft.variant}
          options={models.models}
          acceptsVariant
          presentation="field"
          onSelect={(model, variant) => {
            onDraftChange({ ...draft, model, variant });
          }}
          onOpen={() => {
            markTouched('model');
          }}
          isLoading={models.isLoading}
          disabled={catalogueFailed}
        />
        {catalogueFailed ? (
          <QueryError
            placement="top"
            compact
            variant="server"
            title={t('common.couldNotLoadModels')}
            onRetry={() => void models.refetch()}
            isRetrying={models.isFetching}
          />
        ) : null}
        {modelProblemText === undefined ? null : (
          <AccessibleStatus message={modelProblemText} className="text-sm" />
        )}
      </View>

      <TriggerSelectRow
        label={t('agentChat.newSession.environment')}
        value={selectedEnvironment?.name ?? t('cloudAgent.triggers.environmentAutomatic')}
        disabled={draft.repository.length === 0}
        onPress={() => {
          onOpenSheetChange('environment');
        }}
      />
      <View className="gap-1">
        <TriggerSelectRow
          label={t('common.profile')}
          value={selectedProfile?.name ?? t('cloudAgent.triggers.profileDefaults')}
          onPress={() => {
            onOpenSheetChange('profile');
          }}
        />
        <Text variant="caption">{t('cloudAgent.triggers.profileHelp')}</Text>
      </View>

      <TriggerChoiceSheet
        visible={openSheet === 'agent'}
        title={t('common.agent')}
        options={agentOptions}
        selected={isCustomAgent ? null : draft.agent}
        onSelect={value => {
          onDraftChange({ ...draft, agent: value ?? '' });
        }}
        onClose={() => {
          onOpenSheetChange(null);
        }}
      />
      <TriggerChoiceSheet
        visible={openSheet === 'environment'}
        title={t('agentChat.newSession.environment')}
        options={[
          { value: null, label: t('cloudAgent.triggers.environmentAutomatic') },
          ...environments.environments.map(environment => ({
            value: environment.id,
            label: environment.name,
          })),
        ]}
        selected={draft.environmentId}
        onSelect={value => {
          onDraftChange({ ...draft, environmentId: value });
        }}
        onClose={() => {
          onOpenSheetChange(null);
        }}
      />
      <TriggerChoiceSheet
        visible={openSheet === 'profile'}
        title={t('common.profile')}
        options={[
          { value: null, label: t('cloudAgent.triggers.profileDefaults') },
          ...profiles.profiles.map(profile => ({
            value: profile.id,
            label: profile.name,
          })),
        ]}
        selected={draft.profileId}
        onSelect={value => {
          onDraftChange({ ...draft, profileId: value });
        }}
        onClose={() => {
          onOpenSheetChange(null);
        }}
      />
    </View>
  );
}

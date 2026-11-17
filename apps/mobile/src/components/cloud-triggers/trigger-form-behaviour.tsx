/**
 * The third block of the trigger form: what the run is asked to do, what an
 * inbound body must look like, the header a caller must send, and the run's
 * options.
 *
 * The secret itself is never rendered: the worker reports that one is stored
 * (`webhookAuthConfigured`) and the app sends a new value only when the person
 * types one, which is exactly what the web form does.
 */

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { triggerProblemText } from '@/lib/cloud-triggers/trigger-problem-copy';
import { TRIGGER_FIELD_EXAMPLES } from '@/lib/cloud-triggers/trigger-field-examples';
import {
  type TriggerDraft,
  type TriggerDraftProblems,
  withRunAsCreator,
} from '@/lib/cloud-triggers/trigger-draft';
import { useTouchedProblems } from '@/lib/cloud-triggers/use-touched-problems';

import { TriggerSwitchRow } from './trigger-form-rows';

type TriggerFormBehaviourProps = Readonly<{
  mode: 'create' | 'edit';
  organizationId?: string;
  draft: TriggerDraft;
  problems: TriggerDraftProblems;
  /** Whether the worker holds a secret for this trigger already. */
  authConfigured: boolean;
  /** Changes after a save so the uncontrolled secret field remounts empty. */
  secretResetKey: number;
  onDraftChange: (next: TriggerDraft) => void;
}>;

/**
 * The guidance under the secret field, for what the trigger can do with it
 * today: a creator run needs its own 16-character secret, a stored secret only
 * changes when a new one is typed, and otherwise no secret exists yet and the
 * field must be filled in.
 */
function secretHelpKeyFor(
  state: Readonly<{ authConfigured: boolean; runAsCreator: boolean }>
):
  | 'cloudAgent.triggers.authSecretCreator'
  | 'cloudAgent.triggers.authSecretKeep'
  | 'cloudAgent.triggers.authSecretSet' {
  if (state.runAsCreator) {
    return 'cloudAgent.triggers.authSecretCreator';
  }
  return state.authConfigured
    ? 'cloudAgent.triggers.authSecretKeep'
    : 'cloudAgent.triggers.authSecretSet';
}

export function TriggerFormBehaviour({
  mode,
  organizationId,
  draft,
  problems,
  authConfigured,
  secretResetKey,
  onDraftChange,
}: TriggerFormBehaviourProps) {
  const { t } = useTranslation();
  const isScheduled = draft.activation === 'scheduled';
  const { markTouched, shownProblem } = useTouchedProblems(problems);
  const secretHelpKey = secretHelpKeyFor({ authConfigured, runAsCreator: draft.runAsCreator });
  return (
    <View className="gap-4">
      <FormField
        // The prompt is uncontrolled, so switching activation in the create
        // form would leave the old default on screen while the draft carried
        // the new one. The key remounts it on the value the draft now holds.
        key={`prompt-${draft.activation}`}
        label={t('agentChat.partDetail.field.prompt')}
        required
        multiline
        defaultValue={draft.prompt}
        onChangeText={prompt => {
          onDraftChange({ ...draft, prompt });
        }}
        error={triggerProblemText(shownProblem('prompt'))}
        onBlur={() => {
          markTouched('prompt');
        }}
        className="min-h-[120px] leading-[1.25rem]"
        textAlignVertical="top"
      />

      {isScheduled ? null : (
        <>
          <FormField
            label={t('cloudAgent.triggers.fieldBodySchema')}
            multiline
            defaultValue={draft.bodySchemaJson}
            onChangeText={bodySchemaJson => {
              onDraftChange({ ...draft, bodySchemaJson });
            }}
            error={triggerProblemText(shownProblem('bodySchema'))}
            onBlur={() => {
              markTouched('bodySchema');
            }}
            placeholder={TRIGGER_FIELD_EXAMPLES.bodySchema}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            className="min-h-[120px] font-mono text-xs leading-[1.25rem]"
            textAlignVertical="top"
          />
          <Text variant="muted" className="text-xs">
            {t('cloudAgent.triggers.bodySchemaHelp')}
          </Text>

          <View className="gap-1">
            <TriggerSwitchRow
              title={t('cloudAgent.triggers.authTitle')}
              description={t('cloudAgent.triggers.authDescription')}
              value={draft.authEnabled}
              onValueChange={authEnabled => {
                onDraftChange({
                  ...draft,
                  authEnabled,
                  authSecret: authEnabled ? draft.authSecret : '',
                  runAsCreator: authEnabled ? draft.runAsCreator : false,
                });
              }}
              disabled={draft.runAsCreator}
            />
            {draft.authEnabled && (
              <View className="gap-4">
                <FormField
                  label={t('cloudAgent.triggers.authHeaderLabel')}
                  required
                  defaultValue={draft.authHeader}
                  onChangeText={authHeader => {
                    onDraftChange({ ...draft, authHeader });
                  }}
                  error={triggerProblemText(shownProblem('authHeader'))}
                  onBlur={() => {
                    markTouched('authHeader');
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  placeholder={TRIGGER_FIELD_EXAMPLES.authHeader}
                />
                <FormField
                  key={`auth-secret-${secretResetKey}`}
                  label={t('cloudAgent.triggers.authSecretLabel')}
                  required={!authConfigured}
                  defaultValue={draft.authSecret}
                  onChangeText={authSecret => {
                    onDraftChange({ ...draft, authSecret });
                  }}
                  error={triggerProblemText(shownProblem('authSecret'))}
                  onBlur={() => {
                    markTouched('authSecret');
                  }}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  placeholder={
                    authConfigured
                      ? t('cloudAgent.triggers.authSecretKeep')
                      : t('cloudAgent.triggers.authSecretLabel')
                  }
                />
                <Text variant="muted" className="text-xs">
                  {t(secretHelpKey)}
                </Text>
              </View>
            )}
          </View>
        </>
      )}

      <View className="gap-2">
        <TriggerSwitchRow
          title={t('cloudAgent.triggers.autoCommit')}
          value={draft.autoCommit}
          onValueChange={autoCommit => {
            onDraftChange({ ...draft, autoCommit });
          }}
        />
        <TriggerSwitchRow
          title={t('cloudAgent.triggers.condenseOnComplete')}
          value={draft.condenseOnComplete}
          onValueChange={condenseOnComplete => {
            onDraftChange({ ...draft, condenseOnComplete });
          }}
        />
        {mode === 'edit' && (
          <TriggerSwitchRow
            title={t('cloudAgent.triggers.activeTitle')}
            description={draft.active ? undefined : t('cloudAgent.triggers.activeDescription')}
            value={draft.active}
            onValueChange={active => {
              onDraftChange({ ...draft, active });
            }}
          />
        )}
        {mode === 'create' && organizationId !== undefined && !isScheduled && (
          <TriggerSwitchRow
            title={t('cloudAgent.triggers.runAsCreator')}
            description={t('cloudAgent.triggers.runAsCreatorDescription')}
            value={draft.runAsCreator}
            onValueChange={runAsCreator => {
              onDraftChange(withRunAsCreator(draft, runAsCreator));
            }}
          />
        )}
      </View>
    </View>
  );
}

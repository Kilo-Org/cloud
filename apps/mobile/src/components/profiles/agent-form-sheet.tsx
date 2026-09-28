import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { AgentVariantPicker } from '@/components/profiles/agent-variant-picker';
import {
  type AgentFormError,
  type AgentFormState,
  type AgentSource,
  type AgentVisibility,
  buildAgentPayload,
  initialAgentFormState,
  PERMISSION_TOOLS,
  validateAgentForm,
} from '@/components/profiles/profile-agents-model';
import { SheetHeader } from '@/components/sheet-header';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { cn } from '@/lib/utils';

/** Catalog key for each refused field, so the message lands under the input at fault. */
const ERROR_KEYS = {
  'slug-required': 'profiles.agents.slugRequired',
  'slug-invalid': 'profiles.agents.slugInvalid',
  'slug-conflict': 'profiles.agents.slugConflict',
  'name-required': 'profiles.agents.nameRequired',
} satisfies Record<AgentFormError, string>;

const VISIBILITY_OPTIONS: readonly { value: AgentVisibility; labelKey: string }[] = [
  { value: 'primary', labelKey: 'profiles.agents.visibilityPrimary' },
  { value: 'subagent', labelKey: 'profiles.agents.visibilitySubagent' },
  { value: 'all', labelKey: 'profiles.agents.visibilityAll' },
];

type AgentFormSheetProps = Readonly<{
  agent: AgentSource | null;
  organizationId?: string;
  isSaving: boolean;
  onClose: () => void;
  onSave: (payload: { slug: string; name: string; config: Record<string, unknown> }) => void;
}>;

/**
 * The add/edit agent sheet. Mounted only while open, so every open seeds fresh
 * fields from the agent it edits. Text fields are uncontrolled (refs), per the
 * app's iOS text-input rule; visibility and the tool toggles are state.
 *
 * Save validates through `validateAgentForm`; a refused input shows the
 * matching `profiles.agents.*` message under the field at fault. Every tool is
 * allowed unless its switch is off, which writes `deny` for that tool only.
 *
 * Sampling (max steps, temperature, top_p) mirrors the web editor. The effort
 * variant control appears only when the typed model's catalogue entry lists
 * variants — the same `availableVariants` gate web uses — and never blocks a
 * save: an unavailable model list only hides the control.
 */
export function AgentFormSheet({
  agent,
  organizationId,
  isSaving,
  onClose,
  onSave,
}: Readonly<AgentFormSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const initial = initialAgentFormState(agent ?? undefined);
  const slugRef = useRef(initial.slug);
  const nameRef = useRef(initial.name);
  const descriptionRef = useRef(initial.description);
  const promptRef = useRef(initial.prompt);
  const modelRef = useRef(initial.model);
  const stepsRef = useRef(initial.steps);
  const temperatureRef = useRef(initial.temperature);
  const topPRef = useRef(initial.topP);
  // The typed model is text in `modelRef`; this state exists only to derive the
  // variant options the catalogue publishes for it.
  const [modelValue, setModelValue] = useState(initial.model);
  const [visibility, setVisibility] = useState<AgentVisibility>(initial.visibility);
  const [variant, setVariant] = useState(initial.variant);
  const [disabledTools, setDisabledTools] = useState<readonly string[]>(initial.disabledTools);
  const [error, setError] = useState<AgentFormError | null>(null);
  const { models } = useAvailableModels(organizationId);

  const variantsFor = (model: string): readonly string[] =>
    models.find(option => option.id === model.trim())?.variants ?? [];
  const variants = variantsFor(modelValue);

  const submit = () => {
    const state: AgentFormState = {
      slug: slugRef.current,
      name: nameRef.current,
      description: descriptionRef.current,
      prompt: promptRef.current,
      visibility,
      model: modelRef.current,
      steps: stepsRef.current,
      temperature: temperatureRef.current,
      topP: topPRef.current,
      variant,
      disabledTools,
    };
    const problem = validateAgentForm(state);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    onSave(buildAgentPayload(state, agent?.config));
  };

  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={agent === null ? t('profiles.agents.add') : agent.name}
        onDone={submit}
        onCancel={onClose}
        doneLabel={t('common.save')}
        disabled={isSaving}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <FormField
          label={t('profiles.agents.slug')}
          defaultValue={initial.slug}
          error={
            error === 'slug-required' || error === 'slug-invalid' || error === 'slug-conflict'
              ? t(ERROR_KEYS[error])
              : undefined
          }
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.agents.slugPlaceholder')}
          onChangeText={value => {
            slugRef.current = value.toLowerCase().replaceAll(/[^a-z0-9-]/g, '');
            setError(null);
          }}
        />
        <FormField
          label={t('profiles.agents.name')}
          defaultValue={initial.name}
          error={error === 'name-required' ? t(ERROR_KEYS[error]) : undefined}
          disabled={isSaving}
          required
          placeholder={t('profiles.agents.namePlaceholder')}
          onChangeText={value => {
            nameRef.current = value;
            setError(null);
          }}
        />
        <FormField
          label={t('profiles.agents.description')}
          defaultValue={initial.description}
          disabled={isSaving}
          placeholder={t('profiles.descriptionPlaceholder')}
          onChangeText={value => {
            descriptionRef.current = value;
          }}
        />
        <FormField
          label={t('profiles.agents.prompt')}
          defaultValue={initial.prompt}
          disabled={isSaving}
          multiline
          textAlignVertical="top"
          className="min-h-28 leading-5"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.agents.promptPlaceholder')}
          onChangeText={value => {
            promptRef.current = value;
          }}
        />
        <FormField
          label={t('profiles.agents.model')}
          defaultValue={initial.model}
          disabled={isSaving}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.agents.modelPlaceholder')}
          onChangeText={value => {
            modelRef.current = value;
            setModelValue(value);
            // Drop a stale effort value whenever the new model does not offer it.
            const next = variantsFor(value);
            setVariant(current => (next.includes(current) ? current : ''));
          }}
        />

        {variants.length > 0 ? (
          <AgentVariantPicker
            variants={variants}
            value={variant}
            disabled={isSaving}
            onChange={setVariant}
          />
        ) : null}

        <FormField
          label={t('profiles.agents.steps')}
          defaultValue={initial.steps}
          disabled={isSaving}
          keyboardType="number-pad"
          placeholder={t('profiles.agents.stepsPlaceholder')}
          onChangeText={value => {
            stepsRef.current = value;
          }}
        />
        <FormField
          label={t('profiles.agents.temperature')}
          defaultValue={initial.temperature}
          disabled={isSaving}
          keyboardType="decimal-pad"
          placeholder={t('profiles.agents.temperaturePlaceholder')}
          onChangeText={value => {
            temperatureRef.current = value;
          }}
        />
        <FormField
          label={t('profiles.agents.topP')}
          defaultValue={initial.topP}
          disabled={isSaving}
          keyboardType="decimal-pad"
          placeholder={t('profiles.agents.topPPlaceholder')}
          onChangeText={value => {
            topPRef.current = value;
          }}
        />

        <View className="gap-1.5">
          <Text className="text-sm font-medium text-foreground">
            {t('profiles.agents.visibility')}
          </Text>
          <View className="gap-1">
            {VISIBILITY_OPTIONS.map(option => {
              const selected = visibility === option.value;
              return (
                <Pressable
                  key={option.value}
                  className={cn(
                    'min-h-11 flex-row items-center rounded-md px-3 active:opacity-70',
                    selected && 'bg-secondary'
                  )}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={t(option.labelKey)}
                  onPress={() => {
                    setVisibility(option.value);
                  }}
                >
                  <Text
                    className={cn(
                      'text-sm',
                      selected ? 'font-medium text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {t(option.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View className="gap-1.5">
          <Text className="text-sm font-medium text-foreground">{t('profiles.agents.tools')}</Text>
          <View className="gap-1">
            {PERMISSION_TOOLS.map(tool => {
              const enabled = !disabledTools.includes(tool);
              return (
                <View key={tool} className="min-h-11 flex-row items-center gap-3 px-1">
                  <Text variant="mono" className="flex-1 text-sm text-foreground">
                    {tool}
                  </Text>
                  <Switch
                    value={enabled}
                    disabled={isSaving}
                    accessibilityLabel={tool}
                    onValueChange={next => {
                      setDisabledTools(current =>
                        next ? current.filter(item => item !== tool) : [...current, tool]
                      );
                    }}
                  />
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}

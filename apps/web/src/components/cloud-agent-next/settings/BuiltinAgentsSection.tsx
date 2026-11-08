'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Bot, Check, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { cn } from '@/lib/utils';
import {
  useSetBuiltinAgentsMutation,
  type CloudAgentSettingsData,
} from '@/hooks/useCloudAgentSettings';
import {
  CLOUD_AGENT_BUILTIN_AGENTS,
  type BuiltinAgentOverride,
  type BuiltinAgentSettings,
  type CloudAgentBuiltinAgentSlug,
} from '@kilocode/cloud-agent-profile';

type BuiltinAgentsSectionProps = {
  organizationId?: string;
  settings: CloudAgentSettingsData;
};

export function BuiltinAgentsSection({ organizationId, settings }: BuiltinAgentsSectionProps) {
  const { data: modelsData, isLoading: modelsLoading } = useModelSelectorList(undefined);
  const setBuiltinAgents = useSetBuiltinAgentsMutation(organizationId);
  const [agents, setAgents] = useState<BuiltinAgentSettings>(settings.builtinAgents);

  useEffect(() => {
    if (!setBuiltinAgents.isPending) setAgents(settings.builtinAgents);
  }, [settings.builtinAgents, setBuiltinAgents.isPending]);

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (modelsData?.data ?? []).map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
        variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
      })),
    [modelsData]
  );

  const save = (next: BuiltinAgentSettings) => {
    setAgents(next);
    setBuiltinAgents.mutate(
      { agents: next },
      {
        onError: error => {
          setAgents(settings.builtinAgents);
          toast.error(error.message);
        },
      }
    );
  };

  const updateAgent = (slug: CloudAgentBuiltinAgentSlug, patch: Partial<BuiltinAgentOverride>) => {
    const current = agents[slug] ?? {};
    const nextOverride: BuiltinAgentOverride = { ...current, ...patch };
    if (nextOverride.model == null) {
      delete nextOverride.model;
      delete nextOverride.variant;
    }
    if (nextOverride.disable !== true) delete nextOverride.disable;
    if (nextOverride.variant === '') delete nextOverride.variant;
    const next = { ...agents };
    if (Object.keys(nextOverride).length === 0) delete next[slug];
    else next[slug] = nextOverride;
    save(next);
  };

  const primaryAgents = CLOUD_AGENT_BUILTIN_AGENTS.filter(agent => agent.kind === 'primary');
  const hasPrimaryModelOverrides = primaryAgents.some(agent => agents[agent.slug]?.model);

  return (
    <section aria-labelledby="builtin-agents-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Bot className="size-4" aria-hidden />
          <h4 id="builtin-agents-heading" className="text-sm font-medium">
            Agent preferences
          </h4>
        </div>
        <p className="text-muted-foreground text-xs">
          Used for sessions you start, including organization sessions.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h5 id="agent-modes-heading" className="text-sm font-medium">
            Agent modes
          </h5>
          <p className="text-muted-foreground text-xs">
            Enable or disable modes in your agent picker. Choose the model in each session.
          </p>
        </div>
        <div role="group" aria-labelledby="agent-modes-heading" className="flex flex-wrap gap-2">
          {primaryAgents.map(agent => {
            const enabled = agents[agent.slug]?.disable !== true;
            return (
              <Button
                key={agent.slug}
                type="button"
                variant={enabled ? 'secondary' : 'outline'}
                size="sm"
                className={cn(
                  'rounded-full pointer-coarse:min-h-11',
                  !enabled && 'text-muted-foreground',
                  !agent.canDisable && 'disabled:opacity-100'
                )}
                aria-pressed={enabled}
                aria-describedby={!agent.canDisable ? 'required-agent-description' : undefined}
                title={agent.description}
                disabled={!agent.canDisable || setBuiltinAgents.isPending}
                onClick={() => updateAgent(agent.slug, { disable: enabled })}
              >
                {!agent.canDisable ? (
                  <Lock className="size-3.5" aria-hidden />
                ) : (
                  <Check className={cn('size-3.5', !enabled && 'invisible')} aria-hidden />
                )}
                {agent.name}
              </Button>
            );
          })}
        </div>
        <p id="required-agent-description" className="text-muted-foreground text-xs">
          Code is always enabled because new sessions start in Code mode.
        </p>
        {hasPrimaryModelOverrides && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <p className="text-muted-foreground">Previously saved mode models are still active.</p>
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={setBuiltinAgents.isPending}
              onClick={() => {
                const next = { ...agents };
                for (const agent of primaryAgents) {
                  if (next[agent.slug]?.disable === true) next[agent.slug] = { disable: true };
                  else delete next[agent.slug];
                }
                save(next);
              }}
            >
              Use session model for all modes
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h5 className="text-sm font-medium">Background models</h5>
          <p className="text-muted-foreground text-xs">
            Choose models for Explore and Compaction, or use the session model. Overrides apply only
            when the model is available to the session.
          </p>
        </div>
        {CLOUD_AGENT_BUILTIN_AGENTS.filter(agent => agent.kind === 'subagent').map(agent => {
          const override = agents[agent.slug];
          const variants = override?.model
            ? (modelOptions.find(model => model.id === override.model)?.variants ?? [])
            : [];
          return (
            <div
              key={agent.slug}
              className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <span className="text-sm font-medium">{agent.name}</span>
                <p className="text-muted-foreground text-xs">{agent.description}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <ModelCombobox
                  models={modelOptions}
                  value={override?.model ?? undefined}
                  onValueChange={model =>
                    updateAgent(agent.slug, {
                      model,
                      variant: undefined,
                    })
                  }
                  isLoading={modelsLoading}
                  disabled={setBuiltinAgents.isPending}
                  variant="compact"
                  placeholder="Session model"
                  triggerAriaLabel={`Model for ${agent.name}`}
                  modal
                />
                {override?.model && variants.length > 0 && (
                  <VariantCombobox
                    variants={variants}
                    value={override.variant}
                    onValueChange={variant => updateAgent(agent.slug, { variant })}
                    onClear={() => updateAgent(agent.slug, { variant: undefined })}
                    triggerAriaLabel={`Thinking effort for ${agent.name}`}
                    disabled={setBuiltinAgents.isPending}
                  />
                )}
                {override?.model && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground text-xs"
                    aria-label={`Use session model for ${agent.name}`}
                    disabled={setBuiltinAgents.isPending}
                    onClick={() => updateAgent(agent.slug, { model: undefined })}
                  >
                    Use session model
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

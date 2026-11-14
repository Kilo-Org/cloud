'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Lock, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import { SettingHint } from './SettingHint';

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
    <>
      <section aria-labelledby="agent-modes-heading" className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <h4 id="agent-modes-heading" className="text-sm font-medium">
            Modes
          </h4>
          <SettingHint label="Modes">
            Modes shown in your agent picker. You choose the model in each session.
          </SettingHint>
        </div>
        <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
          <div role="group" aria-labelledby="agent-modes-heading" className="flex flex-wrap gap-2">
            {primaryAgents.map(agent => {
              const enabled = agents[agent.slug]?.disable !== true;
              if (!agent.canDisable) {
                return (
                  <Tooltip key={agent.slug}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="cursor-default rounded-full pointer-coarse:min-h-11"
                        aria-pressed
                        aria-disabled
                        onClick={event => event.preventDefault()}
                      >
                        <Lock className="size-3.5" aria-hidden />
                        {agent.name}
                        <span className="sr-only">, always on</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Always on. New sessions start in {agent.name}.</TooltipContent>
                  </Tooltip>
                );
              }
              return (
                <Button
                  key={agent.slug}
                  type="button"
                  variant={enabled ? 'secondary' : 'outline'}
                  size="sm"
                  className={cn(
                    'rounded-full pointer-coarse:min-h-11',
                    !enabled && 'text-muted-foreground'
                  )}
                  aria-pressed={enabled}
                  title={agent.description}
                  disabled={setBuiltinAgents.isPending}
                  onClick={() => updateAgent(agent.slug, { disable: enabled })}
                >
                  {enabled && <Check className="size-3.5" aria-hidden />}
                  {agent.name}
                </Button>
              );
            })}
          </div>
          {hasPrimaryModelOverrides && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <p className="text-muted-foreground">
                Previously saved mode models are still active.
              </p>
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
      </section>
      <section aria-labelledby="background-models-heading" className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <h4 id="background-models-heading" className="text-sm font-medium">
            Background models
          </h4>
          <SettingHint label="Background models">
            Used only when the model is available to the session. Otherwise the session model is
            used.
          </SettingHint>
        </div>
        <div className="divide-y rounded-lg border">
          {CLOUD_AGENT_BUILTIN_AGENTS.filter(agent => agent.kind === 'subagent').map(agent => {
            const override = agents[agent.slug];
            const variants = override?.model
              ? (modelOptions.find(model => model.id === override.model)?.variants ?? [])
              : [];
            return (
              <div
                key={agent.slug}
                className="flex min-h-13 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-1">
                  <span className="text-sm font-medium">{agent.name}</span>
                  <SettingHint label={agent.name}>{agent.description}</SettingHint>
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          aria-label={`Use session model for ${agent.name}`}
                          disabled={setBuiltinAgents.isPending}
                          onClick={() => updateAgent(agent.slug, { model: undefined })}
                        >
                          <RotateCcw className="size-4" aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Use session model</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import {
  useSetModelContextLimitsMutation,
  type CloudAgentSettingsData,
} from '@/hooks/useCloudAgentSettings';
import {
  MAX_MODEL_CONTEXT_LIMITS,
  MAX_MODEL_CONTEXT_TOKENS,
  MIN_MODEL_CONTEXT_TOKENS,
  type ModelContextLimits,
} from '@kilocode/cloud-agent-profile';
import { SettingHint } from './SettingHint';

type ModelContextLimitsSectionProps = {
  organizationId?: string;
  settings: CloudAgentSettingsData;
};

const DEFAULT_CONTEXT_LIMIT = 200_000;

function advertisedWindow(contextLength: number | undefined): number | undefined {
  return contextLength !== undefined && Number.isFinite(contextLength) && contextLength > 0
    ? Math.floor(contextLength)
    : undefined;
}

function maxContextLimit(contextLength: number | undefined): number {
  return Math.min(
    MAX_MODEL_CONTEXT_TOKENS,
    advertisedWindow(contextLength) ?? MAX_MODEL_CONTEXT_TOKENS
  );
}

export function ModelContextLimitsSection({
  organizationId,
  settings,
}: ModelContextLimitsSectionProps) {
  const { data: modelsData, isLoading: modelsLoading } = useModelSelectorList(undefined);
  const setModelContextLimits = useSetModelContextLimitsMutation(organizationId);
  const [limits, setLimits] = useState<ModelContextLimits>(settings.modelContextLimits);

  useEffect(() => {
    if (!setModelContextLimits.isPending) setLimits(settings.modelContextLimits);
  }, [settings.modelContextLimits, setModelContextLimits.isPending]);

  const catalog = useMemo(() => modelsData?.data ?? [], [modelsData]);
  const modelById = useMemo(() => new Map(catalog.map(model => [model.id, model])), [catalog]);

  const addOptions = useMemo<ModelOption[]>(
    () =>
      catalog
        .filter(
          model =>
            !(model.id in limits) &&
            maxContextLimit(model.context_length) >= MIN_MODEL_CONTEXT_TOKENS
        )
        .map(model => ({
          id: model.id,
          name: model.name,
          isFree: model.isFree,
          mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
          hasUserByokAvailable: model.hasUserByokAvailable,
          variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
        })),
    [catalog, limits]
  );

  const save = (next: ModelContextLimits) => {
    setLimits(next);
    setModelContextLimits.mutate(
      { limits: next },
      {
        onError: error => {
          setLimits(settings.modelContextLimits);
          toast.error(error.message);
        },
      }
    );
  };

  const entries = Object.entries(limits);
  const canAdd = entries.length < MAX_MODEL_CONTEXT_LIMITS;

  return (
    <section aria-labelledby="model-context-limits-heading" className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h4 id="model-context-limits-heading" className="text-sm font-medium">
          Model context limits
        </h4>
        <SettingHint label="Model context limits">
          Cap the context window Kilo uses for a model. The conversation is compacted to stay under
          the cap, which reduces cost on long sessions. New workspaces and standalone sessions use
          these limits. New chats in existing workspaces keep that workspace’s limits.
        </SettingHint>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No limits. Models use their full context window.
          </p>
        ) : (
          <div role="group" aria-labelledby="model-context-limits-heading" className="divide-y">
            {entries.map(([model, context]) => {
              const catalogModel = modelById.get(model);
              return (
                <div
                  key={model}
                  className="flex min-h-13 flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">
                      {catalogModel
                        ? formatShortModelDisplayName(catalogModel.name)
                        : formatShortModelDisplayName(model)}
                    </span>
                    <span className="text-muted-foreground truncate font-mono text-xs">
                      {model}
                      {catalogModel
                        ? ` · ${catalogModel.context_length.toLocaleString()} token window`
                        : ''}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <ContextLimitInput
                      value={context}
                      max={maxContextLimit(catalogModel?.context_length)}
                      disabled={setModelContextLimits.isPending}
                      ariaLabel={`Context limit for ${model}`}
                      onCommit={next => save({ ...limits, [model]: next })}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          aria-label={`Remove context limit for ${model}`}
                          disabled={setModelContextLimits.isPending}
                          onClick={() => {
                            const next = { ...limits };
                            delete next[model];
                            save(next);
                          }}
                        >
                          <RotateCcw className="size-4" aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Use the full context window</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {canAdd && (
          <ModelCombobox
            models={addOptions}
            value={undefined}
            onValueChange={model => {
              const initialLimit = Math.min(
                MAX_MODEL_CONTEXT_TOKENS,
                advertisedWindow(modelById.get(model)?.context_length) ?? DEFAULT_CONTEXT_LIMIT
              );
              if (initialLimit < MIN_MODEL_CONTEXT_TOKENS) return;
              save({
                ...limits,
                [model]: initialLimit,
              });
            }}
            isLoading={modelsLoading}
            disabled={setModelContextLimits.isPending}
            variant="compact"
            placeholder="Add a model…"
            triggerAriaLabel="Add a model context limit"
            modal
          />
        )}
      </div>
    </section>
  );
}

type ContextLimitInputProps = {
  value: number;
  max: number;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (value: number) => void;
};

function ContextLimitInput({ value, max, disabled, ariaLabel, onCommit }: ContextLimitInputProps) {
  const hintId = useId();
  const [draft, setDraft] = useState(String(value));
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    setDraft(String(value));
    setShowError(false);
  }, [value]);

  const parsed = Number(draft);
  const valid = /^\d+$/.test(draft.trim()) && parsed >= MIN_MODEL_CONTEXT_TOKENS && parsed <= max;
  const unsupported = max < MIN_MODEL_CONTEXT_TOKENS;
  const invalid = showError && !valid;
  const range = `${MIN_MODEL_CONTEXT_TOKENS.toLocaleString()}–${max.toLocaleString()} tokens`;

  const commit = () => {
    setShowError(!valid);
    if (!valid) return;
    if (parsed !== value) onCommit(parsed);
    else setDraft(String(value));
  };

  return (
    <div className="flex flex-col gap-1">
      <Input
        type="number"
        inputMode="numeric"
        min={MIN_MODEL_CONTEXT_TOKENS}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        aria-describedby={hintId}
        aria-invalid={invalid}
        disabled={disabled || unsupported}
        className="w-32 font-mono"
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(String(value));
            setShowError(false);
          }
        }}
      />
      <p
        id={hintId}
        aria-live="polite"
        className={invalid ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
      >
        {unsupported
          ? 'This model’s window is too small for a cap. Remove the limit to use the full window.'
          : invalid
            ? `Enter a whole number in this range: ${range}.`
            : range}
      </p>
    </div>
  );
}

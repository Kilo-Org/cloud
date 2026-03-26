'use client';

import { useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { useOnboarding, type ModelPreset } from './OnboardingContext';

type PresetConfig = {
  key: ModelPreset;
  name: string;
  description: string;
  cost: string;
  models: {
    mayor: string;
    refinery: string;
    polecat: string;
  };
};

const PRESETS: PresetConfig[] = [
  {
    key: 'frontier',
    name: 'Maximum Frontier',
    description: 'Best quality across all roles',
    cost: '$$$',
    models: {
      mayor: 'kilo/frontier',
      refinery: 'kilo/frontier',
      polecat: 'kilo/frontier',
    },
  },
  {
    key: 'balanced',
    name: 'Balanced',
    description: 'Smart defaults — frontier review, balanced elsewhere',
    cost: '$$',
    models: {
      mayor: 'kilo/balanced',
      refinery: 'kilo/frontier',
      polecat: 'kilo/balanced',
    },
  },
  {
    key: 'cost-effective',
    name: 'Cost-Effective',
    description: 'Balanced models everywhere for lower cost',
    cost: '$',
    models: {
      mayor: 'kilo/balanced',
      refinery: 'kilo/balanced',
      polecat: 'kilo/balanced',
    },
  },
  {
    key: 'free',
    name: 'Free Tier',
    description: 'Try it out at no cost',
    cost: 'free',
    models: {
      mayor: 'kilo/free',
      refinery: 'kilo/free',
      polecat: 'kilo/free',
    },
  },
];

/** Derive the config shape stored in OnboardingState from a preset. */
export function presetToConfig(
  preset: ModelPreset,
  customModels: { mayor?: string; refinery?: string; polecat?: string }
) {
  if (preset === 'custom') {
    const mayorModel = customModels.mayor ?? 'kilo/balanced';
    return {
      default_model: mayorModel,
      role_models: {
        mayor: mayorModel,
        refinery: customModels.refinery ?? 'kilo/balanced',
        polecat: customModels.polecat ?? 'kilo/balanced',
      },
    };
  }

  const presetConfig = PRESETS.find(p => p.key === preset);
  if (!presetConfig) {
    return { default_model: 'kilo/balanced', role_models: {} };
  }

  const { mayor, refinery, polecat } = presetConfig.models;

  // Only include role_models entries that differ from the default (mayor) model
  const role_models: Record<string, string> = {};
  if (refinery !== mayor) role_models.refinery = refinery;
  if (polecat !== mayor) role_models.polecat = polecat;

  return {
    default_model: mayor,
    role_models,
  };
}

function PresetCard({
  preset,
  isSelected,
  onSelect,
}: {
  preset: PresetConfig;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex flex-col rounded-lg border p-4 text-left transition-all',
        'hover:bg-white/[0.04]',
        isSelected
          ? 'border-[color:oklch(95%_0.15_108_/_0.5)] bg-[color:oklch(95%_0.15_108_/_0.06)]'
          : 'border-white/[0.08] bg-white/[0.02]'
      )}
    >
      {/* Selection ring */}
      {isSelected && (
        <motion.div
          layoutId="preset-ring"
          className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-[color:oklch(95%_0.15_108_/_0.5)]"
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <span className={cn('text-sm font-medium', isSelected ? 'text-white/90' : 'text-white/70')}>
          {preset.name}
        </span>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
            preset.cost === 'free'
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-white/[0.06] text-white/40'
          )}
        >
          {preset.cost}
        </span>
      </div>

      <p className="mt-1 text-xs text-white/35">{preset.description}</p>
    </button>
  );
}

function CustomCard({ isSelected, onSelect }: { isSelected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex flex-col rounded-lg border p-4 text-left transition-all',
        'hover:bg-white/[0.04]',
        isSelected
          ? 'border-[color:oklch(95%_0.15_108_/_0.5)] bg-[color:oklch(95%_0.15_108_/_0.06)]'
          : 'border-white/[0.08] border-dashed bg-white/[0.01]'
      )}
    >
      {isSelected && (
        <motion.div
          layoutId="preset-ring"
          className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-[color:oklch(95%_0.15_108_/_0.5)]"
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <span className={cn('text-sm font-medium', isSelected ? 'text-white/90' : 'text-white/70')}>
          Custom
        </span>
        <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-white/40">
          varies
        </span>
      </div>

      <p className="mt-1 text-xs text-white/35">Pick a specific model for each role</p>
    </button>
  );
}

function CustomModelPickers({
  customModels,
  onUpdate,
  modelOptions,
  isLoadingModels,
  modelsError,
}: {
  customModels: { mayor?: string; refinery?: string; polecat?: string };
  onUpdate: (models: { mayor?: string; refinery?: string; polecat?: string }) => void;
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
  modelsError: string | undefined;
}) {
  const roles = [
    { key: 'mayor' as const, label: 'Mayor' },
    { key: 'refinery' as const, label: 'Refinery' },
    { key: 'polecat' as const, label: 'Polecat' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className="mt-4 space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
        {roles.map(({ key, label }) => (
          <div key={key}>
            <label className="mb-1.5 block text-xs font-medium text-white/50">{label}</label>
            <ModelCombobox
              label=""
              models={modelOptions}
              value={customModels[key]}
              onValueChange={value => onUpdate({ ...customModels, [key]: value })}
              isLoading={isLoadingModels}
              error={modelsError}
              placeholder="Select a model"
              className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85"
            />
          </div>
        ))}
      </div>
    </motion.div>
  );
}

export function OnboardingStepModel() {
  const { state, setModelPreset, setCustomModels } = useOnboarding();

  // Fetch available models for the Custom picker (no org context during onboarding)
  const {
    data: modelsData,
    isLoading: isLoadingModels,
    error: modelsError,
  } = useModelSelectorList(undefined);

  const modelOptions = useMemo<ModelOption[]>(
    () => modelsData?.data.map(model => ({ id: model.id, name: model.name })) ?? [],
    [modelsData]
  );

  function handlePresetSelect(preset: ModelPreset) {
    setModelPreset(preset);
  }

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Choose your models</h2>
      <p className="mt-2 text-sm text-white/40">
        Pick a model configuration that fits your needs and budget.
      </p>

      <div className="mt-8 w-full max-w-lg">
        {/* 2x2 grid for the four presets */}
        <div className="grid grid-cols-2 gap-3">
          {PRESETS.map(preset => (
            <PresetCard
              key={preset.key}
              preset={preset}
              isSelected={state.modelPreset === preset.key}
              onSelect={() => handlePresetSelect(preset.key)}
            />
          ))}
        </div>

        {/* Custom card below the 2x2 grid */}
        <div className="mt-3">
          <CustomCard
            isSelected={state.modelPreset === 'custom'}
            onSelect={() => handlePresetSelect('custom')}
          />
        </div>

        {/* Expanded custom model pickers */}
        <AnimatePresence>
          {state.modelPreset === 'custom' && (
            <CustomModelPickers
              customModels={state.customModels}
              onUpdate={setCustomModels}
              modelOptions={modelOptions}
              isLoadingModels={isLoadingModels}
              modelsError={modelsError?.message}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

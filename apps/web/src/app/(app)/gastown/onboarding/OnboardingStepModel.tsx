'use client';

import { useMemo } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { useOnboarding } from './OnboardingContext';
import { PRESETS } from './onboarding.domain';
import type { ModelPreset, PresetConfig } from './onboarding.domain';

/** Animated gradient blobs that create an ethereal neon glow inside the frontier card. */
function FrontierGlow() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
      {/* Base ambient glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,oklch(85%_0.18_160_/_0.08),transparent_70%)]" />

      {/* Drifting blob 1 — teal/cyan */}
      <motion.div
        className="absolute h-32 w-32 rounded-full bg-[radial-gradient(circle,oklch(80%_0.2_180_/_0.25),transparent_70%)] blur-xl"
        animate={{
          x: ['-20%', '60%', '10%', '-20%'],
          y: ['10%', '-30%', '50%', '10%'],
          scale: [1, 1.3, 0.9, 1],
        }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
        style={{ top: '10%', left: '5%' }}
      />

      {/* Drifting blob 2 — violet/purple */}
      <motion.div
        className="absolute h-28 w-28 rounded-full bg-[radial-gradient(circle,oklch(75%_0.2_300_/_0.2),transparent_70%)] blur-xl"
        animate={{
          x: ['50%', '-10%', '40%', '50%'],
          y: ['-20%', '40%', '-10%', '-20%'],
          scale: [1.1, 0.8, 1.2, 1.1],
        }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        style={{ top: '20%', right: '10%' }}
      />

      {/* Drifting blob 3 — green/lime */}
      <motion.div
        className="absolute h-24 w-24 rounded-full bg-[radial-gradient(circle,oklch(90%_0.18_130_/_0.18),transparent_70%)] blur-xl"
        animate={{
          x: ['30%', '-30%', '50%', '30%'],
          y: ['60%', '10%', '-20%', '60%'],
          scale: [0.9, 1.2, 1, 0.9],
        }}
        transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
        style={{ bottom: '5%', left: '20%' }}
      />

      {/* Drifting blob 4 — pink/magenta */}
      <motion.div
        className="absolute h-20 w-20 rounded-full bg-[radial-gradient(circle,oklch(80%_0.2_350_/_0.15),transparent_70%)] blur-lg"
        animate={{
          x: ['-10%', '70%', '20%', '-10%'],
          y: ['30%', '-20%', '60%', '30%'],
          scale: [1, 1.4, 0.7, 1],
        }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
        style={{ top: '40%', left: '40%' }}
      />

      {/* Outer glow ring */}
      <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/[0.08]" />
    </div>
  );
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
  const isFrontier = preset.key === 'frontier';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex flex-col rounded-lg border p-4 text-left transition-all',
        'hover:bg-white/[0.04]',
        isSelected && isFrontier
          ? 'border-[color:oklch(80%_0.18_180_/_0.4)] bg-black/40'
          : isSelected
            ? 'border-[color:oklch(95%_0.15_108_/_0.5)] bg-[color:oklch(95%_0.15_108_/_0.06)]'
            : 'border-white/[0.08] bg-white/[0.02]'
      )}
    >
      {/* Ethereal glow effect for frontier when selected */}
      {isSelected && isFrontier && <FrontierGlow />}

      {/* Selection ring */}
      {isSelected && !isFrontier && (
        <motion.div
          layoutId="preset-ring"
          className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-[color:oklch(95%_0.15_108_/_0.5)]"
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        />
      )}

      <div className="relative flex items-start justify-between gap-2">
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

      <p className="relative mt-1 text-xs text-white/35">{preset.description}</p>
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

const ROLES = [
  { key: 'mayor' as const, label: 'Mayor', description: 'Primary coding agent' },
  { key: 'refinery' as const, label: 'Refinery', description: 'Code review & planning' },
  { key: 'polecat' as const, label: 'Polecat', description: 'Fast auxiliary tasks' },
];

function ModelRolePickers({
  models,
  isCustom,
  onUpdate,
  modelOptions,
  isLoadingModels,
  modelsError,
}: {
  models: { mayor: string; refinery: string; polecat: string };
  isCustom: boolean;
  onUpdate: (models: { mayor?: string; refinery?: string; polecat?: string }) => void;
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
  modelsError: string | undefined;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className="mt-4 space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
        {ROLES.map(({ key, label, description }) => (
          <div key={key}>
            <div className="mb-1.5 flex items-baseline gap-2">
              <label className="text-xs font-medium text-white/50">{label}</label>
              <span className="text-[10px] text-white/25">{description}</span>
            </div>
            <ModelCombobox
              label=""
              models={modelOptions}
              value={models[key]}
              onValueChange={value => onUpdate({ ...models, [key]: value })}
              isLoading={isLoadingModels}
              error={modelsError}
              placeholder="Select a model"
              disabled={!isCustom}
              className={cn(
                'border-white/[0.08] bg-white/[0.03] text-sm text-white/85',
                !isCustom && 'opacity-70'
              )}
            />
          </div>
        ))}
        {!isCustom && (
          <p className="text-center text-[10px] text-white/20">
            Select &ldquo;Custom&rdquo; to change models
          </p>
        )}
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

  // Resolve current models for display: preset values or custom overrides
  const currentModels = useMemo(() => {
    if (state.modelPreset === 'custom') {
      return {
        mayor: state.customModels.mayor ?? 'kilo-auto/balanced',
        refinery: state.customModels.refinery ?? 'kilo-auto/balanced',
        polecat: state.customModels.polecat ?? 'kilo-auto/balanced',
      };
    }
    const preset = PRESETS.find(p => p.key === state.modelPreset);
    if (preset) return preset.models;
    return {
      mayor: 'kilo-auto/balanced',
      refinery: 'kilo-auto/balanced',
      polecat: 'kilo-auto/balanced',
    };
  }, [state.modelPreset, state.customModels]);

  const isCustom = state.modelPreset === 'custom';

  function handlePresetSelect(preset: ModelPreset) {
    setModelPreset(preset);
  }

  function handleCustomUpdate(models: { mayor?: string; refinery?: string; polecat?: string }) {
    setCustomModels(models);
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
          <CustomCard isSelected={isCustom} onSelect={() => handlePresetSelect('custom')} />
        </div>

        {/* Always-visible model role pickers */}
        <ModelRolePickers
          models={currentModels}
          isCustom={isCustom}
          onUpdate={handleCustomUpdate}
          modelOptions={modelOptions}
          isLoadingModels={isLoadingModels}
          modelsError={modelsError?.message}
        />
      </div>
    </div>
  );
}

'use client';

import { CheckCircle, Circle, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';

type MoleculeStep = {
  name: string;
  description?: string;
  status: 'completed' | 'current' | 'pending';
  summary?: string;
};

type MoleculeStepperProps = {
  steps: MoleculeStep[];
  moleculeName?: string;
};

/**
 * Checkout-flow-style progress stepper for molecule/formula execution.
 * Shows completed steps with summaries, current step pulsing, future steps dimmed.
 */
export function MoleculeStepper({ steps, moleculeName }: MoleculeStepperProps) {
  if (steps.length === 0) {
    return <div className="text-center text-xs text-white/25">No molecule steps attached.</div>;
  }

  return (
    <div>
      {moleculeName && (
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded bg-violet-500/15 px-2 py-0.5 text-[9px] font-medium tracking-wide text-violet-300 uppercase">
            Molecule
          </span>
          <span className="text-xs font-medium text-white/60">{moleculeName}</span>
        </div>
      )}

      <div className="relative space-y-0">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;

          return (
            <div key={i} className="relative flex gap-3">
              {/* Vertical connector line */}
              {!isLast && (
                <div
                  className={`absolute top-6 left-[11px] h-[calc(100%-8px)] w-px ${
                    step.status === 'completed' ? 'bg-emerald-500/30' : 'bg-white/[0.06]'
                  }`}
                />
              )}

              {/* Step indicator */}
              <div className="relative z-10 flex shrink-0 pt-0.5">
                {step.status === 'completed' ? (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: i * 0.1, type: 'spring', stiffness: 300 }}
                  >
                    <CheckCircle className="size-[22px] text-emerald-400" />
                  </motion.div>
                ) : step.status === 'current' ? (
                  <div className="relative">
                    <Loader2 className="size-[22px] animate-spin text-[color:oklch(95%_0.15_108)]" />
                    <span className="absolute -inset-1 animate-ping rounded-full bg-[color:oklch(95%_0.15_108_/_0.2)]" />
                  </div>
                ) : (
                  <Circle className="size-[22px] text-white/15" />
                )}
              </div>

              {/* Step content */}
              <div className="flex-1 pb-5">
                <div
                  className={`text-sm font-medium ${
                    step.status === 'completed'
                      ? 'text-white/60'
                      : step.status === 'current'
                        ? 'text-white/90'
                        : 'text-white/25'
                  }`}
                >
                  {step.name}
                </div>
                {step.description && (
                  <div
                    className={`mt-0.5 text-[11px] ${
                      step.status === 'pending' ? 'text-white/15' : 'text-white/35'
                    }`}
                  >
                    {step.description}
                  </div>
                )}
                {step.status === 'completed' && step.summary && (
                  <div className="mt-1.5 rounded-md border border-emerald-500/10 bg-emerald-500/5 px-2.5 py-1.5 text-[10px] text-emerald-300/70">
                    {step.summary}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Formula = {
  name: string;
  description: string;
  stepCount: number;
  steps: Array<{ name: string; description?: string }>;
};

type FormulaLibraryProps = {
  formulas: Formula[];
  onSelect?: (formula: Formula) => void;
};

/**
 * Browse available formulas with descriptions and step previews.
 */
export function FormulaLibrary({ formulas, onSelect }: FormulaLibraryProps) {
  if (formulas.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Circle className="mb-2 size-6 text-white/10" />
        <p className="text-xs text-white/25">No formulas available.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {formulas.map((formula, i) => (
        <motion.button
          key={i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          onClick={() => onSelect?.(formula)}
          className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.04]"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-white/75">{formula.name}</span>
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-white/30">
              {formula.stepCount} steps
            </span>
          </div>
          <div className="mt-1 text-[11px] text-white/35">{formula.description}</div>
          <div className="mt-2 flex items-center gap-1">
            {formula.steps.slice(0, 5).map((step, j) => (
              <span
                key={j}
                className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[8px] text-white/25"
              >
                {step.name}
              </span>
            ))}
            {formula.steps.length > 5 && (
              <span className="text-[8px] text-white/15">+{formula.steps.length - 5}</span>
            )}
          </div>
        </motion.button>
      ))}
    </div>
  );
}

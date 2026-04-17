'use client';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type OnboardingStepIndicatorProps = {
  currentStep: number;
  totalSteps: number;
  label?: string;
};

export function OnboardingStepIndicator({
  currentStep,
  totalSteps,
  label,
}: OnboardingStepIndicatorProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
        {Array.from({ length: totalSteps }, (_, i) => (
          <span
            key={i}
            className={cn(
              'h-1.5 w-6 rounded-full',
              i < currentStep ? 'bg-brand-primary' : 'bg-muted'
            )}
          />
        ))}
      </div>
      <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
        {label ?? `Step ${currentStep} of ${totalSteps}`}
      </span>
    </div>
  );
}

export function ProvisioningBanner() {
  return (
    <div className="border-border flex w-full items-center gap-3 rounded-lg border p-4">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <div>
        <p className="text-sm font-semibold">Setting up your instance</p>
        <p className="text-muted-foreground text-xs">
          This happens in the background — keep going while we get things ready.
        </p>
      </div>
    </div>
  );
}

type OnboardingStepViewProps = {
  currentStep: number;
  totalSteps: number;
  stepLabel?: string;
  title?: string;
  description?: string;
  showProvisioningBanner?: boolean;
  contentClassName?: string;
  children: React.ReactNode;
};

export function OnboardingStepView({
  currentStep,
  totalSteps,
  stepLabel,
  title,
  description,
  showProvisioningBanner,
  contentClassName,
  children,
}: OnboardingStepViewProps) {
  const indicator = (
    <OnboardingStepIndicator currentStep={currentStep} totalSteps={totalSteps} label={stepLabel} />
  );

  return (
    <Card className="mt-6">
      <CardContent className={cn('flex flex-col gap-6 p-6 sm:p-8', contentClassName)}>
        {title || description ? (
          <div className="flex flex-col gap-3">
            {indicator}
            {(title || description) && (
              <div className="flex flex-col gap-1">
                {title && <h2 className="text-foreground text-2xl font-bold">{title}</h2>}
                {description && <p className="text-muted-foreground text-sm">{description}</p>}
              </div>
            )}
          </div>
        ) : (
          <div className="self-start">{indicator}</div>
        )}

        {children}

        {showProvisioningBanner && <ProvisioningBanner />}
      </CardContent>
    </Card>
  );
}

'use client';

import { AlertCircle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ExecPreset } from './claw.types';

export function PermissionStep({
  instanceRunning,
  onSelect,
}: {
  instanceRunning: boolean;
  onSelect: (preset: ExecPreset) => void;
}) {
  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
        {/* Step indicator */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Step 2 of 4
            </span>
            <div className="flex gap-1">
              <span className="h-1.5 w-6 rounded-full bg-blue-500" />
              <span className="h-1.5 w-6 rounded-full bg-blue-500" />
              <span className="bg-muted h-1.5 w-6 rounded-full" />
              <span className="bg-muted h-1.5 w-6 rounded-full" />
            </div>
          </div>
          <h2 className="text-foreground text-2xl font-bold">Set Bot Permissions</h2>
          <p className="text-muted-foreground text-sm">
            Choose how your KiloClaw bot handles actions on your behalf.
          </p>
        </div>

        {/* Permission cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PresetCard
            onClick={() => onSelect('never-ask')}
            icon={<ShieldAlert className="h-5 w-5 text-amber-400" />}
            iconBg="bg-amber-900/50"
            title="Allow everything"
            description="The bot acts immediately without asking. Best for autonomous workflows, but review what it can access first."
            caution="Use with caution"
          />
          <PresetCard
            onClick={() => onSelect('always-ask')}
            icon={<ShieldCheck className="h-5 w-5 text-emerald-400" />}
            iconBg="bg-emerald-900/50"
            title="Ask for permission"
            description="The bot pauses and asks you before taking any action. Best when you want full control over what it does."
            badge="Recommended"
          />
        </div>

        {/* Provisioning status banner */}
        {!instanceRunning && (
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
        )}
      </CardContent>
    </Card>
  );
}

function PresetCard({
  onClick,
  icon,
  iconBg,
  title,
  description,
  badge,
  caution,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  badge?: string;
  caution?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex cursor-pointer flex-col gap-4 rounded-xl border p-5 text-left transition-colors',
        'border-border hover:border-muted-foreground/40'
      )}
    >
      {/* Top row: icon + badge */}
      <div className="flex items-start justify-between">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', iconBg)}>
          {icon}
        </div>
        {badge ? (
          <span className="rounded-full border border-emerald-700 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-400 uppercase">
            {badge}
          </span>
        ) : null}
      </div>

      {/* Title + description */}
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-bold">{title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      </div>

      {/* Caution label */}
      {caution && (
        <div className="flex items-center gap-1.5 text-amber-400">
          <AlertCircle className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{caution}</span>
        </div>
      )}
    </button>
  );
}

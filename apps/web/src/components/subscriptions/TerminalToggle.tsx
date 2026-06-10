'use client';

import { useId } from 'react';
import { Switch } from '@/components/ui/switch';

export function TerminalToggle({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();

  return (
    <label htmlFor={id} className="flex items-center gap-3 text-sm">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      <span>{label}</span>
    </label>
  );
}

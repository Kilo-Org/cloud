'use client';

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
  return (
    <div className="flex items-center gap-3 text-sm">
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
      <span>{label}</span>
    </div>
  );
}

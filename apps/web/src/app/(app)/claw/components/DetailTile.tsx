import type { ComponentType } from 'react';

export function DetailTile({
  label,
  value,
  mono = false,
  icon: Icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="bg-secondary/40 flex items-start gap-3 rounded-lg border p-4">
      <div className="bg-accent mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
        <Icon className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p
          className={`text-foreground mt-0.5 truncate text-sm font-medium ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

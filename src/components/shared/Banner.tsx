import { cn } from '@/lib/utils';

type BannerProps = {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  colors: {
    border: string;
    bg: string;
    text: string;
  };
};

export function Banner({ icon, title, description, action, colors }: BannerProps) {
  return (
    <div
      className={cn(
        'flex w-full flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:gap-4',
        colors.border,
        colors.bg,
        colors.text
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center sm:gap-4">
        <div className="mt-0.5 flex shrink-0 items-center sm:mt-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold sm:font-bold">{title}</p>
          <p className="text-muted-foreground mt-0.5 text-sm sm:mt-0">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

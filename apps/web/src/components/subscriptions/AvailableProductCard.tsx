import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function AvailableProductCard({
  icon,
  title,
  price,
  status,
  features,
  cta,
  details,
  action,
}: {
  icon: ReactNode;
  title: string;
  price: { amount: string; cadenceLabel: string };
  status?: string;
  features?: readonly string[];
  cta?: {
    label: string;
    href?: string;
    onClick?: () => void;
    disabled?: boolean;
    busy?: boolean;
    trailingIcon?: ReactNode;
  };
  details?: ReactNode;
  action?: ReactNode;
}) {
  const button = cta ? (
    <Button
      type="button"
      className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 focus-visible:ring-brand-primary/50 h-11 w-full sm:h-9"
      onClick={cta.onClick}
      disabled={cta.disabled}
      aria-busy={cta.busy}
    >
      {cta.label}
      {cta.trailingIcon ?? <ArrowRight />}
    </Button>
  ) : null;

  return (
    <Card className="border-border/60 relative flex h-full flex-col p-4 text-left shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
            {icon}
          </div>
          <h3 className="truncate text-sm font-semibold">{title}</h3>
        </div>
        {status ? (
          <Badge variant="secondary-outline" className="text-muted-foreground rounded-full px-3">
            {status}
          </Badge>
        ) : null}
      </div>

      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-semibold text-white tabular-nums">{price.amount}</span>
        <span className="text-muted-foreground text-xs">{price.cadenceLabel}</span>
      </div>

      {features ? (
        <ul className="mt-4 grid flex-1 gap-x-8 gap-y-2 lg:grid-cols-2" aria-label="Plan benefits">
          {features.map(feature => (
            <li
              key={feature}
              className="text-muted-foreground flex items-start gap-2 text-xs leading-5"
            >
              <Check className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 pt-2">
        {action ?? (cta?.href && button ? <Link href={cta.href}>{button}</Link> : button)}
      </div>
      {details ? <div className="mt-4">{details}</div> : null}
    </Card>
  );
}

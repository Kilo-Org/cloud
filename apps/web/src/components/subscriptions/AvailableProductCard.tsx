import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function AvailableProductCard({
  icon,
  title,
  description,
  price,
  cta,
  badge,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  price: string;
  cta?: { label: string; href?: string; onClick?: () => void; disabled?: boolean };
  badge?: string;
  action?: ReactNode;
}) {
  const badgeVariant = badge === 'Recommended' ? 'default' : 'secondary-outline';

  const button = cta ? (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={cta.onClick}
      disabled={cta.disabled}
    >
      {cta.label}
    </Button>
  ) : null;

  return (
    <Card className="border-dashed">
      <CardContent className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="bg-muted flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
            {icon}
          </div>
          {badge ? <Badge variant={badgeVariant}>{badge}</Badge> : null}
        </div>
        <div className="space-y-2">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        <div className="mt-auto space-y-3">
          <div className="text-sm font-medium">{price}</div>
          {action ?? (cta?.href && button ? <Link href={cta.href}>{button}</Link> : button)}
        </div>
      </CardContent>
    </Card>
  );
}

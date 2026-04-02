import type { ReactNode } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

export function SubscriptionGroup({
  title,
  description,
  children,
  headerIcon,
  isLoading = false,
  isError = false,
  error,
  onRetry,
  accordionValue,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  headerIcon?: ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  accordionValue?: string;
}) {
  const header = (
    <div className="flex min-w-0 items-center gap-4">
      {headerIcon ? (
        <div className="bg-muted flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border">
          {headerIcon}
        </div>
      ) : null}
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
    </div>
  );

  const body = isLoading ? (
    <div className="grid gap-3 lg:grid-cols-2">
      {['skeleton-1', 'skeleton-2'].map(key => (
        <Card key={key}>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-3">
              <Skeleton className="h-11 w-11 rounded-xl" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      ))}
    </div>
  ) : isError ? (
    <Card className="border-red-500/40 bg-red-500/5">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-red-300" />
          <div>
            <p className="font-medium">Unable to load {title.toLowerCase()}</p>
            <p className="text-muted-foreground text-sm">
              {error instanceof Error
                ? error.message
                : 'Something went wrong while loading this section.'}
            </p>
          </div>
        </div>
        {onRetry ? (
          <Button variant="outline" onClick={onRetry} className="self-start sm:self-auto">
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        ) : null}
      </CardContent>
    </Card>
  ) : (
    children
  );

  if (accordionValue) {
    return (
      <AccordionItem
        value={accordionValue}
        className="rounded-3xl border bg-card/30 px-5 py-5 shadow-sm last:border-b md:px-6 md:py-6"
      >
        <AccordionTrigger className="flex-row-reverse items-center justify-between gap-4 pt-0 hover:no-underline [&>svg]:size-5 [&>svg]:translate-y-0">
          {header}
        </AccordionTrigger>
        <AccordionContent className="pb-0 pt-4">
          <Separator />
          <div className="pt-5">{body}</div>
        </AccordionContent>
      </AccordionItem>
    );
  }

  return (
    <section className="rounded-3xl border bg-card/30 p-5 shadow-sm md:p-6">
      <div className="space-y-5">
        {header}
        <Separator />
        {body}
      </div>
    </section>
  );
}

import HeaderLogo from '@/components/HeaderLogo';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

type KiloCardLayoutProps = {
  children: ReactNode;
  title?: string;
  contentClassName?: string;
  className?: string;
  /**
   * When true, render the children directly on the page background instead of
   * inside a Card. The centered logo and outer layout stay the same.
   */
  bare?: boolean;
};

export function KiloCardLayout({
  children,
  title,
  contentClassName = 'space-y-6',
  className = 'max-w-3xl',
  bare = false,
}: KiloCardLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="mb-8">
        <HeaderLogo className="w-auto self-auto pr-0" />
      </div>
      <div className={cn('mx-auto w-full', className)}>
        {bare ? (
          <>
            {title && <h1 className="pb-8 text-center text-2xl font-bold">{title}</h1>}
            <div className={contentClassName}>{children}</div>
          </>
        ) : (
          <Card className="rounded-none shadow">
            {title && (
              <CardHeader className="text-center">
                <h1 className="pb-8 text-2xl font-bold">{title}</h1>
              </CardHeader>
            )}
            <CardContent className={contentClassName}>{children}</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

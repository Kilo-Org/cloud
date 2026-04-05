import HeaderLogo from '@/components/HeaderLogo';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { ReactNode } from 'react';

type KiloCardLayoutProps = {
  children: ReactNode;
  title?: string;
  contentClassName?: string;
  className?: string;
};

export function KiloCardLayout({
  children,
  title,
  contentClassName = 'space-y-6',
  className = 'max-w-3xl',
}: KiloCardLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="mb-8">
        <HeaderLogo />
      </div>
      <div className={`mx-auto w-full ${className}`}>
        <Card className="rounded-none shadow">
          {title && (
            <CardHeader className="text-center">
              <h1 className="pb-8 text-2xl font-bold">{title}</h1>
            </CardHeader>
          )}
          <CardContent className={contentClassName}>{children}</CardContent>
        </Card>
      </div>
    </div>
  );
}

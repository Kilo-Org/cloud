'use client';

import type { ReactNode } from 'react';
import { PageContainer } from './layouts/PageContainer';
import { useSetTopBarTitle } from '@/components/TopBar';

type PageLayoutProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  headerActions?: ReactNode;
};

export function PageLayout({ title, subtitle, children, headerActions }: PageLayoutProps) {
  // Push string titles into the topbar; ReactNode titles stay in-page only.
  useSetTopBarTitle(typeof title === 'string' ? title : null);

  return (
    <PageContainer>
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          {typeof title === 'string' ? (
            <h1 className="text-foreground text-3xl font-bold md:hidden">{title}</h1>
          ) : (
            title
          )}
          {subtitle &&
            (typeof subtitle === 'string' ? (
              <p className="text-muted-foreground">{subtitle}</p>
            ) : (
              subtitle
            ))}
        </div>
        {headerActions && <div className="shrink-0">{headerActions}</div>}
      </div>
      {children}
    </PageContainer>
  );
}

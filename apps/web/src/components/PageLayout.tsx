import type { ReactNode } from 'react';
import { PageContainer } from './layouts/PageContainer';
import { SetPageTitle } from './SetPageTitle';

type PageLayoutProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  headerActions?: ReactNode;
};

export function PageLayout({ title, subtitle, children, headerActions }: PageLayoutProps) {
  const hasSubtitleOrActions = subtitle || headerActions;
  return (
    <PageContainer>
      {typeof title === 'string' ? <SetPageTitle title={title} /> : title}
      {hasSubtitleOrActions && (
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-2">
            {subtitle &&
              (typeof subtitle === 'string' ? (
                <p className="text-muted-foreground">{subtitle}</p>
              ) : (
                subtitle
              ))}
          </div>
          {headerActions && <div className="shrink-0">{headerActions}</div>}
        </div>
      )}
      {children}
    </PageContainer>
  );
}

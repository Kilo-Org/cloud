'use client';

import { usePageTitle } from '@/contexts/PageTitleContext';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';

export function AppTopbar() {
  const { title, icon, extras, hideTopbar } = usePageTitle();

  if (hideTopbar) return null;

  return (
    <header className="bg-background sticky top-0 z-10 h-14 shrink-0 border-b flex items-center">
      <div className="flex aspect-square h-14 items-center justify-center">
        <SidebarTrigger className="-ml-1" />
      </div>

      {title && (
        <div className="flex h-full min-w-0 flex-1 items-center gap-2 pr-3">
          {icon && <div className="shrink-0">{icon}</div>}
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="block truncate">{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {extras && <div className="shrink-0">{extras}</div>}
        </div>
      )}
    </header>
  );
}

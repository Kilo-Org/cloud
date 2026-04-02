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
  const { title, icon, extras, actions } = usePageTitle();

  return (
    <header className="bg-background sticky top-0 z-10 flex h-14 shrink-0 items-center border-b">
      <div className="flex aspect-square h-14 items-center justify-center">
        <SidebarTrigger className="-ml-1" />
      </div>

      {title && (
        <div className="flex h-full flex-1 items-center gap-2 pr-4">
          {icon}
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {extras}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
    </header>
  );
}

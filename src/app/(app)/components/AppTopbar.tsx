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
  const { title, icon, extras } = usePageTitle();

  return (
    <header className="bg-background sticky top-0 z-10 h-14 shrink-0 border-b flex items-center">
      <div className="flex aspect-square h-14 items-center justify-center">
        <SidebarTrigger className="-ml-1" />
      </div>

      {title && (
        <div className="flex h-full items-center gap-2">
          {icon}
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {extras}
        </div>
      )}
    </header>
  );
}

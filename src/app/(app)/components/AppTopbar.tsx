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
  const { title, icon, extras, hidden } = usePageTitle();

  if (hidden) return null;

  return (
    <header className="bg-background sticky top-0 z-10 h-14 shrink-0 border-b">
      <div className="float-left flex h-14 aspect-square items-center justify-center">
        <SidebarTrigger className="-ml-1" />
      </div>

      {title && (
        <div className="mx-auto h-full max-w-285 px-4 md:px-6">
          <div className="inline-flex h-full items-center gap-2">
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
        </div>
      )}
    </header>
  );
}

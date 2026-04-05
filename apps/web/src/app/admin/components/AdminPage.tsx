import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';

export default function AdminPage({
  children,
  breadcrumbs,
  buttons,
}: {
  children: React.ReactNode;
  breadcrumbs?: React.ReactNode;
  buttons?: React.ReactNode;
}) {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b">
        <div className="flex w-full items-center justify-between gap-1 px-4 lg:gap-2 lg:px-6">
          <div className="flex items-center gap-1 lg:gap-2">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mx-2 h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink href="/admin">Admin</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                {breadcrumbs}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div>{buttons}</div>
        </div>
      </header>
      <div className="mx-8 flex flex-1 py-8">{children}</div>
    </>
  );
}

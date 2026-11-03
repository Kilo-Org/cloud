import { Skeleton } from '@/components/ui/skeleton';

const ROW_WIDTHS = ['72%', '58%', '80%', '64%', '76%', '52%', '68%', '60%'];

/** Placeholder with the same rhythm as the session list: a date heading and rows. */
export function SidebarListSkeleton() {
  return (
    <div role="status" aria-label="Loading sessions">
      <div className="px-2 pt-2 pb-1">
        <Skeleton className="h-[11px] w-12 motion-reduce:animate-none" />
      </div>
      {ROW_WIDTHS.map((width, index) => (
        <div key={index} className="flex items-center gap-2 px-3 py-2" aria-hidden="true">
          <div className="flex h-[19px] min-w-0 flex-1 items-center">
            <Skeleton className="h-3 motion-reduce:animate-none" style={{ width }} />
          </div>
          <Skeleton className="h-3 w-5 shrink-0 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

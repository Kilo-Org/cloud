import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type PageContainerProps = {
  children: ReactNode;
  fullBleed?: boolean;
  className?: string;
};

export function PageContainer({ children, fullBleed = false, className }: PageContainerProps) {
  return (
    <div
      className={cn(
        'm-auto flex w-full max-w-[1140px] flex-col gap-6',
        fullBleed ? '' : 'container p-4 md:p-6',
        className
      )}
    >
      {children}
    </div>
  );
}

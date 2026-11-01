import Link from 'next/link';
import { ListTree } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AiRequestsLink() {
  return (
    <div className="m-auto flex w-full max-w-[1140px] px-4 pt-4 md:px-6 md:pt-6">
      <div className="border-border flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
        <span className="type-body text-foreground">
          Check individual requests, including whether your own API key was used
        </span>
        <Button asChild size="sm" variant="outline">
          <Link href="/usage/requests">
            <ListTree aria-hidden />
            View AI requests
          </Link>
        </Button>
      </div>
    </div>
  );
}

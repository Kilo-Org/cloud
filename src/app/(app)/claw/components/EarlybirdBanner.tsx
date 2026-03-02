import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export function EarlybirdBanner() {
  return (
    <Link
      href="/claw/earlybird"
      className="border-brand-primary/30 bg-brand-primary/5 hover:bg-brand-primary/10 hover:border-brand-primary/50 group flex items-center justify-between rounded-xl border p-4 transition-all"
    >
      <div className="flex items-center gap-3">
        <span className="text-xl">🦀</span>
        <div>
          <span className="text-brand-primary text-sm font-semibold">
            Early Bird: 50% Off KiloClaw Compute
          </span>
          <span className="text-muted-foreground ml-2 text-sm">
            First 100 users &mdash; $25/mo instead of $49
          </span>
        </div>
      </div>
      <ArrowRight className="text-brand-primary h-4 w-4 transition-transform group-hover:translate-x-1" />
    </Link>
  );
}

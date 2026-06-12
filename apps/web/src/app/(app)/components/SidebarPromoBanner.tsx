import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function SidebarPromoBanner() {
  return (
    <div className="px-3 py-3">
      <div className="bg-card flex flex-col gap-2 rounded-xl border p-3">
        <div>
          <p className="text-sm font-semibold leading-tight">Up to 50% Free AI Credits</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Maximize your AI output per dollar with Kilo Pass
          </p>
        </div>
        <Button asChild size="sm" className="w-full">
          <Link href="/subscriptions">Get Kilo Pass</Link>
        </Button>
      </div>
    </div>
  );
}

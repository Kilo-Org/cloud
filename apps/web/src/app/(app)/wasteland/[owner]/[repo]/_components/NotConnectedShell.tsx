'use client';

import Link from 'next/link';
import { Plug, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

type NotConnectedShellProps = {
  owner: string;
  repo: string;
};

/**
 * Rendered when `wasteland.resolveOwnerRepo` returns null — we don't
 * have this `<owner>/<repo>` registered as a connected wasteland.
 *
 * Two paths offered:
 *   1. "Connect this upstream" — links to the existing connect wizard
 *      at `/wasteland/new`, with the upstream slug pre-filled via query
 *      string. The wizard already accepts `?upstream=` (see M2.7 for
 *      the rewrite); for now we pass it as `upstream=<owner>/<repo>` so
 *      the wizard can read it when it lands.
 *   2. "Browse anonymously" — DEFERRED. The plan calls for an
 *      anonymous DoltHub-read path so a logged-out visitor can see the
 *      upstream wanted board. That needs a public proxy endpoint that
 *      doesn't yet exist; the button is disabled with a tooltip until
 *      that path lands.
 */
export function NotConnectedShell({ owner, repo }: NotConnectedShellProps) {
  const slug = `${owner}/${repo}`;
  const connectHref = `/wasteland/new?upstream=${encodeURIComponent(slug)}`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <SidebarTrigger className="-ml-1" />
        <h1 className="font-mono text-base font-medium text-white/90">
          <span className="text-white/55">{owner}</span>
          <span className="text-white/30">/</span>
          <span>{repo}</span>
        </h1>
      </header>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-6 rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold tracking-tight text-white/90">
              Not connected yet
            </h2>
            <p className="text-sm text-white/55">
              We don&apos;t have a connection to{' '}
              <span className="font-mono text-white/75">{slug}</span> yet. Connect it to start a
              fork, claim work, and post wanted items.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button asChild className="w-full">
              <Link href={connectHref}>
                <Plug className="size-4" />
                Connect this upstream
              </Link>
            </Button>

            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* The disabled state is a span wrapping the button so the
                      tooltip still triggers on hover. */}
                  <span tabIndex={0}>
                    <Button variant="secondary" disabled className="w-full">
                      <Eye className="size-4" />
                      Browse anonymously
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Coming soon</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <p className="text-xs text-white/35">
            Connecting registers this upstream so the team can claim items, post wanted work, and
            ship contributions back.
          </p>
        </div>
      </div>
    </div>
  );
}

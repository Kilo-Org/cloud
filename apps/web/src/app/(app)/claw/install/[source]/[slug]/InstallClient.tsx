'use client';

import Link from 'next/link';
import type { InstallPayload } from '@/lib/kiloclaw/install';
import type { InstallSource } from '@/lib/kiloclaw/install-sources';

type InstallClientProps = {
  source: InstallSource;
  sourceLabel: string;
  payload: InstallPayload;
};

/**
 * Preview-only shell. The signed payload has been fetched and verified
 * server-side; this page shows the user what's about to be installed.
 * Dispatch is intentionally not wired yet — the install mutation lands
 * in the next slice on this branch and will replace the disabled CTA
 * below with a real click-to-install button. Until then, the route
 * deliberately does no install work; visiting it is safe.
 */
export function InstallClient({ source, sourceLabel, payload }: InstallClientProps) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <p className="text-sm uppercase tracking-wide text-muted-foreground">{sourceLabel} preview</p>
      <h1 className="text-2xl font-semibold">{payload.title}</h1>
      {payload.tagline ? (
        <p className="text-base text-muted-foreground">{payload.tagline}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">{payload.description}</p>
      <button
        type="button"
        disabled
        className="mt-2 cursor-not-allowed rounded-md border border-muted px-4 py-2 text-sm text-muted-foreground opacity-60"
        title="Install dispatch is being wired in the next change on this branch."
      >
        Install (coming soon)
      </button>
      <p className="text-xs text-muted-foreground">
        Source: <code>{source}</code> · Slug: <code>{payload.slug}</code>
      </p>
      <Link href="/claw/chat" className="text-sm text-primary underline">
        Cancel
      </Link>
    </div>
  );
}

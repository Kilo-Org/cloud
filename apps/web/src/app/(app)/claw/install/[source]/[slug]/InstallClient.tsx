'use client';

import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import type { InstallPayload } from '@/lib/kiloclaw/install';
import type { InstallSource } from '@/lib/kiloclaw/install-sources';

type InstallClientProps = {
  source: InstallSource;
  sourceLabel: string;
  payload: InstallPayload;
};

export function InstallClient({ source, sourceLabel, payload }: InstallClientProps) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm uppercase tracking-wide text-muted-foreground">
        Installing {sourceLabel}
      </p>
      <h1 className="text-2xl font-semibold">{payload.title}</h1>
      {payload.tagline ? (
        <p className="text-base text-muted-foreground">{payload.tagline}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">{payload.description}</p>
      <p className="mt-4 text-xs text-muted-foreground">
        Install dispatch wiring is pending — this page currently renders the preview only. Source:{' '}
        <code>{source}</code> · Slug: <code>{payload.slug}</code>
      </p>
      <Link href="/claw/chat" className="text-sm text-primary underline">
        Cancel
      </Link>
    </div>
  );
}

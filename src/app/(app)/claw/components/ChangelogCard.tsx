'use client';

import { format, parseISO } from 'date-fns';
import { Bug, History, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CHANGELOG_ENTRIES, type ChangelogEntry } from './changelog-data';

const CATEGORY_STYLES = {
  feature: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  bugfix: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
} as const;

const DEPLOY_HINT_STYLES = {
  redeploy_suggested: {
    label: 'Redeploy Suggested',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
  },
  redeploy_required: {
    label: 'Redeploy Required',
    className: 'border-red-500/30 bg-red-500/15 text-red-400',
  },
} as const;

function ChangelogRow({ entry }: { entry: ChangelogEntry }) {
  const deployHint = entry.deployHint ? DEPLOY_HINT_STYLES[entry.deployHint] : null;

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {entry.category === 'feature' ? (
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        ) : (
          <Bug className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        )}
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs">
            {format(parseISO(entry.date), 'MMM d, yyyy')}
          </p>
          <p className="mt-0.5 text-sm">{entry.description}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" className={CATEGORY_STYLES[entry.category]}>
          {entry.category}
        </Badge>
        {deployHint && (
          <Badge variant="outline" className={deployHint.className}>
            {deployHint.label}
          </Badge>
        )}
      </div>
    </div>
  );
}

export function ChangelogCard() {
  if (CHANGELOG_ENTRIES.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" />
          Changelog
        </CardTitle>
        <CardDescription>Recent changes and updates to the Kilo Claw platform.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {CHANGELOG_ENTRIES.map((entry, i) => (
          <ChangelogRow key={`${entry.date}-${i}`} entry={entry} />
        ))}
      </CardContent>
    </Card>
  );
}

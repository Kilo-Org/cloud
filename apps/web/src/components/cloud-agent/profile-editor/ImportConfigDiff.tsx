/** Selectable diff sections and issue list for the config import preview. */
'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { SectionCheckState } from './config-import-selection';

export type ImportIssueView = {
  severity: 'error' | 'warning';
  code: string;
  category: string;
  path: string | null;
  field: string | null;
  message: string;
};

type FieldChange = { field: string; before?: unknown; after?: unknown };

export type CategoryDiffData<T> = {
  added: Array<{ id: string; item: T }>;
  changed: Array<{ id: string; before: T; after: T; changes: FieldChange[] }>;
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function ItemJson({ item }: { item: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap break-words">
      {JSON.stringify(item, null, 2)}
    </pre>
  );
}

function FieldChanges({ changes }: { changes: FieldChange[] }) {
  return (
    <ul className="space-y-0.5">
      {changes.map(change => (
        <li key={change.field} className="font-mono text-xs">
          <span className="text-muted-foreground">{change.field}</span>
          {': '}
          <span className="text-muted-foreground line-through">{formatValue(change.before)}</span>
          {' → '}
          <span>{formatValue(change.after)}</span>
        </li>
      ))}
    </ul>
  );
}

function DiffItem({
  label,
  detail,
  selected,
  onSelectedChange,
  children,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="hover:bg-accent/50 flex items-center gap-2 rounded px-1.5">
        <Checkbox
          checked={selected}
          onCheckedChange={onSelectedChange}
          aria-label={`Import ${label}`}
        />
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="focus-visible:ring-ring flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-xs focus-visible:ring-2 focus-visible:outline-none"
          >
            <code className="min-w-0 truncate font-mono" title={label}>
              {label}
            </code>
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'text-muted-foreground/60 h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none',
                open && 'rotate-90'
              )}
            />
            {detail && (
              <span className="text-muted-foreground ml-1 hidden min-w-0 truncate sm:block">
                {detail}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="bg-muted/30 mt-1 ml-8 space-y-2 rounded-md border p-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One category of importable definitions, each with its own checkbox. */
export function ImportSection<T>({
  title,
  preview,
  sectionState,
  isSelected,
  onSectionChange,
  onItemChange,
}: {
  title: string;
  preview: CategoryDiffData<T>;
  sectionState: SectionCheckState;
  isSelected: (id: string) => boolean;
  onSectionChange: (selected: boolean) => void;
  onItemChange: (id: string, selected: boolean) => void;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="rounded-lg border">
      <div className="bg-secondary/40 flex items-center gap-2 rounded-t-lg border-b px-4 py-3">
        <Checkbox
          id={`${headingId}-select`}
          checked={sectionState}
          onCheckedChange={onSectionChange}
          aria-label={`Import all ${title.toLowerCase()}`}
        />
        <h4 id={headingId} className="text-sm font-semibold">
          <label htmlFor={`${headingId}-select`} className="cursor-pointer">
            {title}
          </label>
        </h4>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {[
            preview.added.length > 0 && `${preview.added.length} new`,
            preview.changed.length > 0 && `${preview.changed.length} changed`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div className="px-4 py-3">
        {preview.added.length > 0 && preview.changed.length > 0 && (
          <p className="text-muted-foreground px-1.5 py-1 text-xs font-medium">New</p>
        )}
        {preview.added.map(({ id, item }) => (
          <DiffItem
            key={`new-${id}`}
            label={id}
            selected={isSelected(id)}
            onSelectedChange={selected => onItemChange(id, selected)}
          >
            <ItemJson item={item} />
          </DiffItem>
        ))}
        {preview.added.length > 0 && preview.changed.length > 0 && (
          <p className="text-muted-foreground mt-2 px-1.5 py-1 text-xs font-medium">Changed</p>
        )}
        {preview.changed.map(change => (
          <DiffItem
            key={`changed-${change.id}`}
            label={change.id}
            detail={change.changes.map(field => field.field).join(', ')}
            selected={isSelected(change.id)}
            onSelectedChange={selected => onItemChange(change.id, selected)}
          >
            <FieldChanges changes={change.changes} />
            <div className="space-y-2">
              <div>
                <p className="text-muted-foreground text-xs font-medium">Current (overwritten)</p>
                <ItemJson item={change.before} />
              </div>
              <div>
                <p className="text-muted-foreground text-xs font-medium">Imported</p>
                <ItemJson item={change.after} />
              </div>
            </div>
          </DiffItem>
        ))}
      </div>
    </section>
  );
}

function IssueRow({ issue }: { issue: ImportIssueView }) {
  return (
    <div className="flex items-start gap-2 rounded-md border p-2 text-xs">
      <Badge variant={issue.severity === 'error' ? 'destructive' : 'secondary'}>
        {issue.severity}
      </Badge>
      <div className="min-w-0">
        <span className="text-muted-foreground">{issue.category}</span>
        {issue.path && <code className="ml-1 font-mono">{issue.path}</code>}
        <p className="break-words">{issue.message}</p>
      </div>
    </div>
  );
}

/** Definitions from the archive that cannot be imported, with the reason for each. */
export function ImportIssues({
  issues,
  defaultOpen,
}: {
  issues: ImportIssueView[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          />
          {issues.length === 1 ? '1 problem' : `${issues.length} problems`} in this archive
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1">
          {issues.map((issue, index) => (
            <IssueRow
              key={`${issue.category}-${issue.code}-${issue.path ?? ''}-${index}`}
              issue={issue}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

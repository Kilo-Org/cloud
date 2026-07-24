import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';
import {
  countCodeLines,
  isCollapsible,
  previewCode,
  resolveCodeBlockChrome,
} from './collapsible-code-block';

interface CollapsibleCodeBlockProps {
  readonly code: string;
  readonly forceExpanded: boolean;
  readonly languageClassName?: string | undefined;
}

const CodePre = ({
  children,
  languageClassName,
}: {
  readonly children: string;
  readonly languageClassName: string | undefined;
}): JSX.Element => (
  <pre>
    <code className={languageClassName}>{children}</code>
  </pre>
);

export const CollapsibleCodeBlock = ({
  code,
  forceExpanded,
  languageClassName,
}: CollapsibleCodeBlockProps): JSX.Element => {
  // Always call hooks: collapsible can flip false→true while streaming crosses the
  // Threshold, and forceExpanded can flip true→false at finalize. Conditional hooks
  // Would break order and drop expand state at that handoff.
  const [expanded, setExpanded] = useState(false);
  const collapsible = isCollapsible(code);
  const chrome = resolveCodeBlockChrome({ collapsible, forceExpanded });

  if (chrome === 'plain' || chrome === 'expanded-no-chrome') {
    return <CodePre languageClassName={languageClassName}>{code}</CodePre>;
  }

  const lineCount = countCodeLines(code);
  const displayCode = expanded ? code : previewCode(code);

  return (
    <div className="relative min-w-0">
      <div className="relative min-w-0">
        <CodePre languageClassName={languageClassName}>{displayCode}</CodePre>
        {expanded ? null : (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b bg-gradient-to-t from-[rgb(9_9_11)] to-transparent"
          />
        )}
      </div>
      <button
        aria-expanded={expanded}
        className="mt-1 flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] font-medium text-zinc-400 outline-none transition hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-[#EDFF00] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        onClick={() => {
          setExpanded(current => !current);
        }}
        type="button"
      >
        {expanded ? (
          <ChevronUp aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
        )}
        <span>{expanded ? 'Show less' : `Show more (${lineCount} lines)`}</span>
      </button>
    </div>
  );
};

import type { JSX } from 'react';
import { CollapsibleCodeBlock } from './collapsible-code-block.tsx';
import { buildUnifiedScriptDiff } from './workflow-script-diff';
import type { ScriptDiffHunk, ScriptDiffLine, ScriptDiffLineKind } from './workflow-script-diff';
import { highlightScriptLine } from './workflow-script-highlight';
import type { ScriptToken } from './workflow-script-highlight';

/**
 * Renders one workflow-script comparison for the save card. A create or an
 * identical update shows the plain new script; a changed update shows one
 * unified diff (git-style hunks with syntax-highlighted rows); a script above
 * the diff size guard shows the plain script plus a one-line note.
 */
const labelClass = 'type-label text-foreground-muted';

const syntaxClassName = (token: ScriptToken): string | undefined => {
  switch (token) {
    case 'comment': {
      return 'text-syntax-comment';
    }
    case 'keyword': {
      return 'text-syntax-keyword';
    }
    case 'number': {
      return 'text-syntax-number';
    }
    case 'string': {
      return 'text-syntax-string';
    }
    case 'plain': {
      return undefined;
    }
  }
};

const lineRowClassName = (kind: ScriptDiffLineKind): string => {
  switch (kind) {
    case 'add': {
      return 'whitespace-pre-wrap break-words bg-diff-add-surface text-diff-add-text';
    }
    case 'del': {
      return 'whitespace-pre-wrap break-words bg-diff-delete-surface text-diff-delete-text';
    }
    case 'context': {
      return 'whitespace-pre-wrap break-words text-foreground-muted';
    }
  }
};

const linePrefix = (kind: ScriptDiffLineKind): string => {
  switch (kind) {
    case 'add': {
      return '+';
    }
    case 'del': {
      return '-';
    }
    case 'context': {
      return ' ';
    }
  }
};

const DiffLine = ({ line }: { line: ScriptDiffLine }): JSX.Element => (
  <div className={lineRowClassName(line.kind)}>
    {linePrefix(line.kind)}
    {highlightScriptLine(line.text).map((span, index) => (
      // eslint-disable-next-line react/no-array-index-key -- token plus position is the stable key for a static line's spans
      <span className={syntaxClassName(span.token)} key={`${span.token}:${index}`}>
        {span.text}
      </span>
    ))}
  </div>
);

const DiffHunk = ({ hunk }: { hunk: ScriptDiffHunk }): JSX.Element => (
  <>
    <div className="whitespace-pre-wrap break-words text-foreground-subtle">{hunk.header}</div>
    {hunk.lines.map((line, index) => (
      // eslint-disable-next-line react/no-array-index-key -- header plus position is the stable key for a static hunk's rows
      <DiffLine key={`${hunk.header}:${index}`} line={line} />
    ))}
  </>
);

const PlainScriptBlock = ({ script }: { script: string }): JSX.Element => (
  <CollapsibleCodeBlock code={script} forceExpanded={false} />
);

export const WorkflowScriptDiff = ({
  newScript,
  oldScript,
}: {
  newScript: string;
  oldScript: string | undefined;
}): JSX.Element => {
  if (oldScript === undefined) {
    return (
      <div className="space-y-1">
        <p className={labelClass}>Script</p>
        <PlainScriptBlock script={newScript} />
      </div>
    );
  }

  const diff = buildUnifiedScriptDiff(oldScript, newScript);

  if (diff.kind === 'unchanged') {
    return (
      <div className="space-y-1">
        <p className={labelClass}>Script (unchanged)</p>
        <PlainScriptBlock script={newScript} />
      </div>
    );
  }

  if (diff.kind === 'tooLarge') {
    return (
      <div className="space-y-1">
        <p className={labelClass}>Script</p>
        <p className={labelClass}>Script too large to diff line by line.</p>
        <PlainScriptBlock script={newScript} />
      </div>
    );
  }

  return (
    <div aria-label="Script changes" className="space-y-1">
      <p className={labelClass}>Script changes</p>
      <div className="font-mono text-xs leading-4">
        {diff.hunks.map(hunk => (
          <DiffHunk hunk={hunk} key={hunk.header} />
        ))}
      </div>
    </div>
  );
};

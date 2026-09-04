import type { SelectedLineRange } from '@pierre/diffs';
import { normalizeWorktreeReviewRange, type WorktreeReviewResult } from './worktree-review';

const rowSelector = '[data-code][data-unified] > [data-content] > [data-line]';
const controlSelector =
  'button, input, textarea, select, a, [contenteditable], [data-line-annotation], [data-gutter-utility-slot], [data-separator]';

export const worktreeReviewKeyboardInstructions =
  'Up and Down move between lines. Shift extends the selection. Enter comments. Escape clears.';

type SelectionResult = WorktreeReviewResult<SelectedLineRange | null>;
type BrowserSelection = Pick<Selection, 'rangeCount' | 'getRangeAt'> & {
  getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => readonly AbstractRange[];
};

function codeRows(root: ShadowRoot): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(rowSelector));
}

function rowSide(row: HTMLElement) {
  return row.getAttribute('data-line-type') === 'change-deletion' ? 'deletions' : 'additions';
}

function codeRow(root: ShadowRoot, node: Node): HTMLElement | null {
  if (node.getRootNode() !== root) return null;
  const element = node.nodeType === 1 ? node : node.parentElement;
  const ElementClass = root.ownerDocument.defaultView?.HTMLElement;
  if (!ElementClass || !(element instanceof ElementClass)) return null;
  if (element.closest(controlSelector)) return null;
  return element.closest<HTMLElement>(rowSelector);
}

function rangeForRows(rows: HTMLElement[], start: number, end: number): SelectionResult {
  const selected = rows.slice(Math.min(start, end), Math.max(start, end) + 1);
  const first = selected[0];
  const last = selected.at(-1);
  if (start < 0 || end < 0 || !first || !last) return { ok: true, value: null };
  const side = rowSide(first);
  const startLine = Number(first.getAttribute('data-line'));
  for (const [index, row] of selected.entries()) {
    if (rowSide(row) !== side) {
      return { ok: false, error: 'Select only old lines or only new lines, not both.' };
    }
    if (Number(row.getAttribute('data-line')) !== startLine + index) {
      return {
        ok: false,
        error: 'The selection crosses hidden lines. Expand them before commenting.',
      };
    }
  }
  const value: SelectedLineRange = {
    side,
    start: startLine,
    end: Number(last.getAttribute('data-line')),
  };
  const normalized = normalizeWorktreeReviewRange(value);
  return normalized.ok ? { ok: true, value } : normalized;
}

export function validateWorktreeReviewRenderedRange(
  root: ShadowRoot,
  selection: SelectedLineRange
): SelectionResult {
  const normalized = normalizeWorktreeReviewRange(selection);
  if (!normalized.ok) return normalized;
  const rows = codeRows(root);
  const { side, startLine, endLine } = normalized.value;
  const start = rows.findIndex(
    row => rowSide(row) === side && Number(row.getAttribute('data-line')) === startLine
  );
  const end = rows.findIndex(
    row => rowSide(row) === side && Number(row.getAttribute('data-line')) === endLine
  );
  if (start < 0 || end < 0) {
    return { ok: false, error: 'Select lines in the displayed saved diff.' };
  }
  return rangeForRows(rows, start, end);
}

function isRowStart(row: HTMLElement, container: Node, offset: number): boolean {
  if (container.nodeType === 3) {
    if (offset !== 0) return false;
  } else if (
    Array.from(container.childNodes)
      .slice(0, offset)
      .some(node => node.textContent?.length)
  ) {
    return false;
  }
  for (let node: Node | null = container; node && node !== row; node = node.parentNode) {
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.textContent?.length) return false;
    }
  }
  return true;
}

export function readWorktreeReviewTextSelection(
  root: ShadowRoot,
  selection: BrowserSelection | null = root.ownerDocument.getSelection()
): SelectionResult {
  if (!root.host.isConnected || !selection) return { ok: true, value: null };
  let ranges: readonly AbstractRange[];
  try {
    if (typeof selection.getComposedRanges === 'function') {
      ranges = selection.getComposedRanges({ shadowRoots: [root] });
    } else {
      const selectableRoot: ShadowRoot & { getSelection?: () => Selection | null } = root;
      const fallback = selectableRoot.getSelection?.() ?? selection;
      ranges = fallback.rangeCount === 1 ? [fallback.getRangeAt(0)] : [];
    }
  } catch {
    return { ok: true, value: null };
  }
  const range = ranges.length === 1 ? ranges[0] : undefined;
  if (
    !range ||
    (range.startContainer === range.endContainer && range.startOffset === range.endOffset)
  ) {
    return { ok: true, value: null };
  }
  const first = codeRow(root, range.startContainer);
  const last = codeRow(root, range.endContainer);
  if (!first || !last || first.parentElement !== last.parentElement)
    return { ok: true, value: null };
  const rows = codeRows(root);
  const start = rows.indexOf(first);
  let end = rows.indexOf(last);
  if (start !== end && isRowStart(last, range.endContainer, range.endOffset)) end -= 1;
  return rangeForRows(rows, start, end);
}

export function bindWorktreeReviewSelection(
  root: ShadowRoot,
  onSelection: (result: SelectionResult) => void,
  onComment: (selection: SelectedLineRange) => void
): () => void {
  const rows = codeRows(root);
  const gutters = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-code][data-unified] > [data-gutter] > [data-column-number]'
    )
  );
  const entry = rows.find(row => row === root.activeElement || row.tabIndex === 0) ?? rows[0];
  const previous = [...rows, ...gutters].map(row => ({
    row,
    tabIndex: row.getAttribute('tabindex'),
    role: row.getAttribute('role'),
    label: row.getAttribute('aria-label'),
    description: row.getAttribute('aria-description'),
  }));
  for (const gutter of gutters) gutter.tabIndex = -1;
  for (const row of rows) {
    row.tabIndex = row === entry ? 0 : -1;
    row.setAttribute('role', 'group');
    row.setAttribute(
      'aria-label',
      `${rowSide(row) === 'deletions' ? 'Old' : 'New'} line ${row.getAttribute('data-line')}`
    );
    row.setAttribute('aria-description', worktreeReviewKeyboardInstructions);
  }
  let active = true;
  let textSelectionActive = false;
  let anchor: HTMLElement | undefined;
  let keyboardSelection: SelectionResult | undefined;
  const isActive = () => active && root.host.isConnected;
  const selectionChanged = () => {
    if (!isActive()) return;
    const result = readWorktreeReviewTextSelection(root);
    if (!result.ok || result.value) {
      textSelectionActive = true;
      anchor = undefined;
      keyboardSelection = undefined;
      onSelection(result);
    } else if (textSelectionActive) {
      textSelectionActive = false;
      onSelection(result);
    }
  };
  const ElementClass = root.ownerDocument.defaultView?.HTMLElement;
  const KeyboardEventClass = root.ownerDocument.defaultView?.KeyboardEvent;
  const focusChanged = (event: Event) => {
    if (!isActive() || !ElementClass || !(event.target instanceof ElementClass)) return;
    if (!rows.includes(event.target)) return;
    for (const row of rows) row.tabIndex = row === event.target ? 0 : -1;
  };
  const keyDown = (event: Event) => {
    if (!isActive() || !KeyboardEventClass || !(event instanceof KeyboardEventClass)) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!ElementClass || !(event.target instanceof ElementClass)) return;
    const row = event.target;
    const index = rows.indexOf(row);
    if (index < 0) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      anchor = undefined;
      keyboardSelection = undefined;
      textSelectionActive = false;
      onSelection({ ok: true, value: null });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = keyboardSelection ?? readWorktreeReviewTextSelection(root);
      const selected = result.ok && !result.value ? rangeForRows(rows, index, index) : result;
      onSelection(selected);
      if (selected.ok && selected.value) onComment(selected.value);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = Math.max(
        0,
        Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))
      );
      const next = rows[nextIndex];
      if (!next) return;
      anchor = event.shiftKey ? (anchor ?? row) : next;
      keyboardSelection = rangeForRows(rows, rows.indexOf(anchor), nextIndex);
      onSelection(keyboardSelection);
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  const pointerDown = (event: Event) => {
    if (!isActive()) return;
    textSelectionActive = false;
    anchor = undefined;
    keyboardSelection = undefined;
    if (ElementClass && event.target instanceof ElementClass && codeRow(root, event.target)) {
      onSelection({ ok: true, value: null });
    }
  };
  root.ownerDocument.addEventListener('selectionchange', selectionChanged);
  root.addEventListener('focusin', focusChanged);
  root.addEventListener('keydown', keyDown);
  root.addEventListener('pointerdown', pointerDown);
  return () => {
    if (!active) return;
    active = false;
    root.ownerDocument.removeEventListener('selectionchange', selectionChanged);
    root.removeEventListener('focusin', focusChanged);
    root.removeEventListener('keydown', keyDown);
    root.removeEventListener('pointerdown', pointerDown);
    for (const { row, tabIndex, role, label, description } of previous) {
      for (const [name, value] of [
        ['tabindex', tabIndex],
        ['role', role],
        ['aria-label', label],
        ['aria-description', description],
      ] as const) {
        if (value === null) row.removeAttribute(name);
        else row.setAttribute(name, value);
      }
    }
  };
}

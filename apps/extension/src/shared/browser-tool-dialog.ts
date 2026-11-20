import { z } from 'zod';
import { KILO_BROWSER_TOOL_PREFIX, toKiloBrowserToolName } from './browser-tool-contract';
import type { BrowserToolDialog } from './browser-tool-session';
import type { EvalTabResult } from './tab-debugger';

/*
 * A JavaScript dialog (alert, confirm, prompt, beforeunload) blocks the page's
 * renderer until it is answered. Measured on Chromium: while one is open,
 * `Input.dispatchMouseEvent`, `Runtime.evaluate`, `DOM.getDocument`,
 * `Page.getFrameTree`, `Page.captureScreenshot`, `Accessibility.getFullAXTree`
 * and `Target.setAutoAttach` all wait for it, and `Page.handleJavaScriptDialog`
 * answers at once. So an open dialog is a modal state, as in Playwright MCP: the
 * call that opened it returns as soon as it opens, and every other tool on that
 * tab is refused until `browser_handle_dialog` answers it.
 */

const HANDLE_DIALOG_TOOL = 'browser_handle_dialog';
/** The two `about:` documents that carry no origin of their own and inherit one. */
const INHERITED_ABOUT_URLS = ['about:blank', 'about:srcdoc'] as const;

/**
 * The origin a dialog's frame url stands for, given the tab's own document
 * origin. A frame at `about:blank`, `about:srcdoc` or a `blob:` url inherits
 * its creator's origin (a `blob:` url even spells it out), so a dialog from
 * such a frame acts in the document that created it. Every other url is judged
 * on its own; anything without an origin — `data:`, a url-less dialog — stays
 * `undefined`, which the caller turns into a fail-closed `opaque:null`.
 */
export const dialogOriginFor = (
  url: string | undefined,
  tabOrigin: string | undefined,
  originOf: (url: string | undefined) => string | undefined
): string | undefined => {
  if (url === undefined || url === '') {
    return undefined;
  }

  const direct = originOf(url);

  if (direct !== undefined) {
    return direct;
  }

  // A `blob:` url embeds the creator's origin: `blob:https://host:port/uuid`.
  if (url.startsWith('blob:')) {
    return originOf(url.slice('blob:'.length));
  }

  if (
    INHERITED_ABOUT_URLS.some(candidate => url === candidate || url.startsWith(`${candidate}#`))
  ) {
    return tabOrigin;
  }

  return undefined;
};

const textValueSchema = z.string();

/** What a page command fails with while a dialog is open, instead of waiting for the dialog. */
export const BROWSER_TOOL_DIALOG_OPEN_ERROR =
  'A JavaScript dialog is open on this page; answer it with browser_handle_dialog first.';

export class BrowserToolDialogOpenError extends Error {
  constructor() {
    super(BROWSER_TOOL_DIALOG_OPEN_ERROR);
    this.name = 'BrowserToolDialogOpenError';
  }
}

/** Accepts the upstream name and the panel's `kilo_` name. */
export const isHandleDialogTool = (toolName: string): boolean =>
  toolName === HANDLE_DIALOG_TOOL || toolName === toKiloBrowserToolName(HANDLE_DIALOG_TOOL);

/** What the modal state may say about one dialog: its message, and whether this caller can answer it. */
export interface ModalStateReading {
  /** Whether the caller may read the opening frame's message, as a snapshot treats that frame's text. */
  readonly messageReadable: boolean;
  /** False for a caller whose tool set leaves the handler out (safe mode is read-only): the dialog is the user's to answer. */
  readonly answerable?: boolean;
}

/**
 * Playwright MCP's modal-state section for one open dialog. A dialog opened by
 * a frame the caller may not read keeps its message back, as a snapshot keeps
 * that frame's text back. A caller that cannot answer one is pointed at the
 * page, never at a tool its mode does not expose.
 */
export const modalStateText = (
  dialog: BrowserToolDialog,
  toolName: string,
  reading: ModalStateReading
): string => {
  const { answerable = true, messageReadable } = reading;
  const description = messageReadable
    ? `"${dialog.type}" dialog with message "${dialog.message}"`
    : `"${dialog.type}" dialog (message withheld: no read permission for the frame that opened it)`;

  if (!answerable) {
    return `### Modal state\n- [${description}]: answer it on the page; this mode cannot answer dialogs`;
  }

  // The answering tool in the caller's own spelling: the panel's tools carry the `kilo_` prefix, the CLI's do not.
  const handler = toolName.startsWith(KILO_BROWSER_TOOL_PREFIX)
    ? toKiloBrowserToolName(HANDLE_DIALOG_TOOL)
    : HANDLE_DIALOG_TOOL;

  return `### Modal state\n- [${description}]: can be handled by ${handler}`;
};

/** Playwright MCP's refusal of a tool that cannot run while the dialog is open. */
export const dialogRefusalText = (
  dialog: BrowserToolDialog,
  toolName: string,
  reading: ModalStateReading
): string =>
  `Tool "${toolName}" does not handle the modal state.\n\n${modalStateText(dialog, toolName, reading)}`;

/**
 * The result of a call during which the page opened a dialog. The step that
 * opened it may never answer while the dialog is open (a click's release is not
 * acknowledged until then), so the modal state is the whole result; a step that
 * did finish keeps its own text ahead of it.
 */
export const withModalState = (result: EvalTabResult, modalState: string): EvalTabResult => {
  if (!result.ok) {
    return result.error === BROWSER_TOOL_DIALOG_OPEN_ERROR
      ? { ok: true, value: modalState }
      : { error: `${result.error}\n\n${modalState}`, ok: false };
  }

  if (result.value === undefined) {
    return {
      ok: true,
      value:
        result.description === undefined ? modalState : `${result.description}\n\n${modalState}`,
    };
  }

  // The bridge shows a string value as it is and any other value as its JSON, so the section follows that text.
  const text = textValueSchema.safeParse(result.value);
  const shown = text.success ? text.data : JSON.stringify(result.value);

  return { ok: true, value: `${shown}\n\n${modalState}` };
};

/**
 * Resolves with the dialog-open marker as soon as the page opens a dialog, so a
 * call can race its step against it. `stop` ends the watch.
 */
export const watchForDialog = (
  watchDialogs: (listener: (dialog: BrowserToolDialog) => void) => () => void
) => {
  const { promise, resolve } = Promise.withResolvers<EvalTabResult>();
  const stop = watchDialogs(() => {
    resolve({ error: BROWSER_TOOL_DIALOG_OPEN_ERROR, ok: false });
  });

  return { opened: promise, stop };
};

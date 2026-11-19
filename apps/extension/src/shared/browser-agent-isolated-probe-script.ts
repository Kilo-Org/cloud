/**
 * The page side of the agent gate's probes on a browser without a debugger
 * protocol (Firefox), run by `scripting.executeScript` in the content-script
 * world: page script cannot shadow the DOM it reads (Firefox Xray vision), and
 * Firefox's `runtime.getFrameId` maps a frame element or a parent window to
 * the frame id the injection results carry, which is what ties an `<iframe>`
 * to the origin of the document inside it.
 *
 * The function is serialized on its own, so it reads nothing from module
 * scope; its sensitive-field rules are the ones the debugger probes in
 * `browser-agent-probes.ts` carry as page source. It answers JSON text.
 */
/** One element's viewport box, the shape the screenshot mask reads. */
interface ProbeBox {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export const runIsolatedAgentProbe = (kind: string, selector: string): string => {
  const { runtime } =
    (
      globalThis as typeof globalThis & {
        browser?: { runtime?: { getFrameId?: (target: unknown) => number } };
      }
    ).browser ?? {};
  const frameIdOf = (target: unknown): number | null => {
    try {
      const id = runtime?.getFrameId?.(target);

      return id === undefined || id < 0 ? null : id;
    } catch {
      return null;
    }
  };
  // `tagName` is upper case only for HTML documents; an XHTML page reports `iframe`, so names come from the namespace.
  const htmlNameOf = (element: Element): string =>
    element.namespaceURI === 'http://www.w3.org/1999/xhtml' ? element.localName : '';
  const kindOf = (element: Element): string | null => {
    const type = (element.getAttribute('type') ?? '').toLowerCase();

    if (htmlNameOf(element) === 'input' && type === 'password') {
      return 'password';
    }

    const tokens = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/u);

    if (tokens.includes('one-time-code')) {
      return 'one-time-code';
    }

    if (tokens.some(token => token.startsWith('cc-'))) {
      return 'payment';
    }

    const name = (element.getAttribute('name') ?? '').toLowerCase();

    return /(?:^|[-_])(?:cc|card)(?:[-_]|$)/u.test(name) || name === 'cardnumber'
      ? 'payment'
      : null;
  };
  const classify = (element: Element) => {
    const own = kindOf(element);
    const form = element.closest('form');
    const role = element.getAttribute('role') ?? '';
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    const isSubmit =
      htmlNameOf(element) === 'button' ||
      (htmlNameOf(element) === 'input' && (type === 'submit' || type === 'image')) ||
      (role === 'button' && form !== null);
    const paymentFormSubmit =
      isSubmit &&
      form !== null &&
      [...form.querySelectorAll('input, select, textarea')].some(
        input => kindOf(input) === 'payment'
      );

    return { fields: own === null ? [] : [{ kind: own }], paymentFormSubmit };
  };
  const boxOf = (element: Element): ProbeBox => {
    const rect = element.getBoundingClientRect();

    return { height: rect.height, left: rect.left, top: rect.top, width: rect.width };
  };

  if (kind === 'frame') {
    // The content-script global is a sandbox over the page window, so the frame's own window is `window`.
    // oxlint-disable-next-line unicorn/prefer-global-this
    const parentFrameId = window === window.top ? null : frameIdOf(window.parent);

    return JSON.stringify({ origin: location.origin, parentFrameId, url: location.href });
  }

  if (kind === 'target') {
    const matches = document.querySelectorAll(selector);
    const [element] = matches;

    return JSON.stringify(
      matches.length === 1 && element !== undefined ? { probe: classify(element) } : {}
    );
  }

  if (kind === 'focused') {
    let element = document.activeElement;

    while (element instanceof HTMLIFrameElement) {
      let inner: Document | null = null;

      try {
        inner = element.contentDocument;
      } catch {
        inner = null;
      }

      if (inner === null) {
        return JSON.stringify({ frameId: frameIdOf(element) });
      }

      element = inner.activeElement;
    }

    return JSON.stringify(element === null ? {} : { probe: classify(element) });
  }

  if (kind === 'presence') {
    let closed = false;
    const scan = (root: Document | ShadowRoot): boolean => {
      const fields = [...root.querySelectorAll('input, textarea, select')];

      if (fields.some(field => kindOf(field) !== null)) {
        return true;
      }

      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot !== null) {
          if (scan(element.shadowRoot)) {
            return true;
          }
        } else if (element.tagName.includes('-')) {
          closed = true;
        }
      }

      return false;
    };
    const present = scan(document);

    return JSON.stringify({ closed, present });
  }

  if (kind === 'boxes') {
    // Firefox gives content scripts `openOrClosedShadowRoot`, so a closed root is read like an open one, as the debugger's pierced DOM is.
    const readsClosedRoots = 'openOrClosedShadowRoot' in document.documentElement;
    const shadowOf = (element: Element): ShadowRoot | null =>
      (element as Element & { readonly openOrClosedShadowRoot?: ShadowRoot | null })
        .openOrClosedShadowRoot ?? element.shadowRoot;
    const fields: ProbeBox[] = [];
    const owners: { readonly box: ProbeBox; readonly frameId: number | null }[] = [];
    const scan = (root: Document | ShadowRoot): void => {
      for (const element of root.querySelectorAll('*')) {
        if (htmlNameOf(element) === 'input' && kindOf(element) !== null) {
          fields.push(boxOf(element));
        }

        if (['embed', 'frame', 'iframe', 'object'].includes(htmlNameOf(element))) {
          owners.push({ box: boxOf(element), frameId: frameIdOf(element) });
        }

        const shadow = shadowOf(element);

        if (shadow !== null) {
          scan(shadow);
        } else if (!readsClosedRoots && element.tagName.includes('-')) {
          // A custom element may hold a closed root this world cannot open, so its whole box is masked.
          fields.push(boxOf(element));
        }
      }
    };

    scan(document);

    return JSON.stringify({
      fields: fields.filter(box => box.width > 0 && box.height > 0),
      owners,
    });
  }

  return '{}';
};

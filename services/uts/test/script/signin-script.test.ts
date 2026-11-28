import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  deviceApprovalPage,
  deviceCodeEntryPage,
  passkeysPage,
  signInPage,
} from '../../src/signin/pages';
import { signInScript } from '../../src/signin/script';
import type { PendingDevice, UserCodeSource } from '../../src/signin/store';

/**
 * Runs the sign-in pages' script against the markup the pages render, in a fresh JavaScript
 * context with a small stand-in for the DOM, `fetch` and the WebAuthn API. It checks the
 * related-origin fallback (design 5.14) on the issuer host, where the relying-party id is the
 * app host.
 */

const RP_ID = 'app.kilo.ai';
const ISSUER_HOST = 'uts.kiloapps.io';

type Listener = () => Promise<void>;

type FakeElement = {
  id: string | null;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  value: string;
  passkey: boolean;
  dataset: Record<string, string>;
  listeners: Listener[];
  addEventListener: (type: string, listener: Listener) => void;
};

/** Every start tag of the page, with the attributes the script reads. */
function parse(html: string): { body: FakeElement; elements: FakeElement[] } {
  const elements: FakeElement[] = [];
  let body: FakeElement | null = null;
  for (const tag of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[2].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
      attributes.set(attribute[1], attribute[2] ?? '');
    }
    const dataset: Record<string, string> = {};
    for (const [name, value] of attributes) {
      if (name.startsWith('data-')) {
        dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] =
          value;
      }
    }
    const listeners: Listener[] = [];
    const element: FakeElement = {
      id: attributes.get('id') ?? null,
      hidden: attributes.has('hidden'),
      disabled: false,
      textContent: '',
      value: attributes.get('value') ?? '',
      passkey: attributes.has('data-passkey'),
      dataset,
      listeners,
      addEventListener: (type, listener) => {
        if (type === 'click') listeners.push(listener);
      },
    };
    elements.push(element);
    if (tag[1] === 'body') body = element;
  }
  if (body === null) throw new Error('the page has no body');
  return { body, elements };
}

type Capabilities = Record<string, boolean> | 'no method' | 'no webauthn';
type Reply = { status: number; data: unknown };

type Browser = {
  host?: string;
  capabilities: Capabilities;
  get?: () => Promise<unknown>;
  create?: () => Promise<unknown>;
  replies?: Record<string, Reply[]>;
};

const bytes = () => new Uint8Array([1, 2, 3]).buffer;

const assertionCredential = async () => ({
  id: 'credential',
  rawId: bytes(),
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response: {
    clientDataJSON: bytes(),
    authenticatorData: bytes(),
    signature: bytes(),
    userHandle: null,
  },
});

const securityError = async () => {
  throw new DOMException(
    'The relying party ID is not a registrable domain suffix',
    'SecurityError'
  );
};

const OPTIONS_REPLY: Reply = {
  status: 200,
  data: { options: { challenge: 'AQID', allowCredentials: [], user: { id: 'AQID', name: 'a' } } },
};

/** Loads `response`'s page in a stand-in browser and runs the script. */
async function load(response: Response, browser: Browser) {
  const { body, elements } = parse(await response.text());
  const byId = new Map<string, FakeElement>();
  for (const element of elements) if (element.id !== null) byId.set(element.id, element);
  const requests: { path: string; body: unknown }[] = [];
  const queues = new Map(Object.entries(browser.replies ?? {}));
  let reloads = 0;
  const context: Record<string, unknown> = {
    document: {
      body,
      getElementById: (id: string) => byId.get(id) ?? null,
      querySelectorAll: (selector: string) =>
        selector === '[data-passkey]' ? elements.filter(element => element.passkey) : [],
    },
    window: {
      location: {
        hostname: browser.host ?? ISSUER_HOST,
        reload: () => {
          reloads += 1;
        },
      },
    },
    navigator:
      browser.capabilities === 'no webauthn'
        ? {}
        : {
            credentials: {
              get: browser.get ?? assertionCredential,
              create: browser.create ?? securityError,
            },
          },
    fetch: async (path: string, init: { body: string }) => {
      requests.push({ path, body: JSON.parse(init.body) });
      const reply = queues.get(path)?.shift() ?? { status: 200, data: {} };
      return { ok: reply.status < 400, json: async () => reply.data };
    },
    atob,
    btoa,
  };
  const { capabilities } = browser;
  if (capabilities !== 'no webauthn') {
    context.PublicKeyCredential =
      capabilities === 'no method' ? {} : { getClientCapabilities: async () => capabilities };
  }
  runInNewContext(await signInScript().text(), context);
  await settle();
  const element = (id: string) => {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`no element ${id}`);
    return found;
  };
  const click = async (id: string) => {
    for (const listener of element(id).listeners) await listener();
    await settle();
  };
  return {
    element,
    click,
    requests,
    passkeyElements: elements.filter(item => item.passkey),
    reloads: () => reloads,
  };
}

async function settle() {
  for (let round = 0; round < 5; round += 1) await setImmediate();
}

const signIn = () =>
  signInPage({
    returnTo: '/signin/done',
    clientOrigin: null,
    rpId: RP_ID,
    providers: [],
    email: { turnstileSiteKey: null },
    sso: false,
  });

const device: PendingDevice = {
  clientId: 'kilo-cli',
  scopes: ['gateway:models.read'],
  createdAt: new Date('2026-11-26T10:00:00Z'),
  expiresAt: new Date('2026-11-26T10:10:00Z'),
  userAgent: null,
  country: null,
  city: null,
};
const approval = (source: UserCodeSource) =>
  deviceApprovalPage('ABCD-EFGH', source, 'Kilo', device, RP_ID);

describe('passkey sign-in on the issuer host', () => {
  it('hides the passkey and shows the notice when the browser reports no related origins', async () => {
    const page = await load(signIn(), { capabilities: { relatedOrigins: false } });
    expect(page.passkeyElements.map(item => item.hidden)).toEqual([true]);
    expect(page.element('passkey-unavailable').hidden).toBe(false);
    expect(page.element('email-address').hidden).toBe(false);
    await page.click('passkey-sign-in');
    expect(page.requests).toEqual([]);
  });

  it('hides the passkey in a browser without WebAuthn', async () => {
    const page = await load(signIn(), { capabilities: 'no webauthn' });
    expect(page.element('passkey-unavailable').hidden).toBe(false);
    expect(page.passkeyElements.every(item => item.hidden)).toBe(true);
  });

  it('signs in where the browser reports related-origin support', async () => {
    const page = await load(signIn(), {
      capabilities: { relatedOrigins: true },
      replies: { '/signin/passkey/options': [OPTIONS_REPLY] },
    });
    expect(page.element('passkey-unavailable').hidden).toBe(true);
    await page.click('passkey-sign-in');
    expect(page.requests.map(request => request.path)).toEqual([
      '/signin/passkey/options',
      '/signin/passkey/verify',
    ]);
    expect(page.reloads()).toBe(1);
  });

  it('shows the notice when a browser that cannot say throws SecurityError at the ceremony', async () => {
    const page = await load(signIn(), {
      capabilities: 'no method',
      get: securityError,
      replies: { '/signin/passkey/options': [OPTIONS_REPLY] },
    });
    expect(page.element('passkey-unavailable').hidden).toBe(true);
    await page.click('passkey-sign-in');
    expect(page.element('passkey-unavailable').hidden).toBe(false);
    expect(page.passkeyElements.every(item => item.hidden)).toBe(true);
    expect(page.element('status').textContent).toBe('');
    expect(page.requests.map(request => request.path)).toEqual(['/signin/passkey/options']);
  });

  it('treats a missing relatedOrigins key as unknown', async () => {
    const page = await load(signIn(), {
      capabilities: { conditionalGet: true },
      get: securityError,
      replies: { '/signin/passkey/options': [OPTIONS_REPLY] },
    });
    expect(page.element('passkey-unavailable').hidden).toBe(true);
    await page.click('passkey-sign-in');
    expect(page.element('passkey-unavailable').hidden).toBe(false);
  });

  it('lets the user retry after NotAllowedError, which also means a cancelled ceremony', async () => {
    const page = await load(signIn(), {
      capabilities: 'no method',
      get: async () => {
        throw new DOMException(
          'The operation either timed out or was not allowed',
          'NotAllowedError'
        );
      },
      replies: { '/signin/passkey/options': [OPTIONS_REPLY] },
    });
    await page.click('passkey-sign-in');
    expect(page.element('passkey-unavailable').hidden).toBe(true);
    expect(page.element('status').textContent).toMatch(/^That did not work: /);
    expect(page.element('passkey-sign-in').disabled).toBe(false);
  });

  it('never consults related origins where the relying-party id is the page host', async () => {
    const page = await load(
      signInPage({
        returnTo: '/signin/done',
        clientOrigin: null,
        rpId: 'localhost',
        providers: [],
        email: { turnstileSiteKey: null },
        sso: false,
      }),
      { host: 'localhost', capabilities: { relatedOrigins: false }, get: securityError }
    );
    expect(page.element('passkey-unavailable').hidden).toBe(true);
    await page.click('passkey-sign-in');
    expect(page.element('passkey-unavailable').hidden).toBe(true);
    expect(page.element('status').textContent).toMatch(/^That did not work: /);
  });
});

describe('passkey registration on the issuer host', () => {
  it('refuses before asking for a challenge when the browser reports no related origins', async () => {
    const page = await load(passkeysPage(RP_ID), { capabilities: { relatedOrigins: false } });
    expect(page.element('passkey-register').hidden).toBe(false);
    expect(page.passkeyElements.every(item => item.hidden)).toBe(true);
    expect(page.element('passkey-unavailable').hidden).toBe(false);
    await page.click('passkey-register');
    expect(page.requests).toEqual([]);
  });

  it('refuses with the notice when create() throws SecurityError, and verifies nothing', async () => {
    const page = await load(passkeysPage(RP_ID), {
      capabilities: 'no method',
      create: securityError,
      replies: { '/signin/passkey/options': [OPTIONS_REPLY] },
    });
    await page.click('passkey-register');
    expect(page.element('passkey-unavailable').hidden).toBe(false);
    expect(page.element('status').textContent).toBe('');
    expect(page.requests.map(request => request.path)).toEqual(['/signin/passkey/options']);
  });
});

describe('device approval on the issuer host', () => {
  it('offers only Deny for a code from a link when the browser reports no related origins', async () => {
    const page = await load(approval('link'), {
      capabilities: { relatedOrigins: false },
      replies: { '/device/decision': [{ status: 200, data: { outcome: 'denied' } }] },
    });
    expect(page.element('device-approve').hidden).toBe(true);
    expect(page.element('device-deny').hidden).toBe(false);
    expect(page.element('passkey-unavailable').hidden).toBe(false);
    await page.click('device-deny');
    expect(page.requests).toEqual([
      {
        path: '/device/decision',
        body: { user_code: 'ABCD-EFGH', source: 'link', approve: false },
      },
    ]);
    expect(page.element('status').textContent).toBe('Device sign-in denied.');
  });

  it('shows the notice when a typed code needs a passkey step-up the browser cannot run', async () => {
    const page = await load(approval('typed'), {
      capabilities: 'no method',
      get: securityError,
      replies: {
        '/device/decision': [{ status: 403, data: { error: 'gate_required' } }],
        '/signin/passkey/options': [OPTIONS_REPLY],
      },
    });
    expect(page.element('device-approve').hidden).toBe(false);
    await page.click('device-approve');
    expect(page.element('passkey-unavailable').hidden).toBe(false);
    expect(page.requests.map(request => request.path)).toEqual([
      '/device/decision',
      '/signin/passkey/options',
    ]);
  });
});

describe('pages without a passkey ceremony', () => {
  it('change nothing when the browser reports no related origins', async () => {
    const page = await load(deviceCodeEntryPage(null, null), {
      capabilities: { relatedOrigins: false },
    });
    expect(page.passkeyElements).toEqual([]);
    expect(page.element('user-code').hidden).toBe(false);
  });
});

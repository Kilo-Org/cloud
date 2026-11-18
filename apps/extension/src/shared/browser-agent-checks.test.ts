import { describe, expect, it } from 'vitest';
import {
  applyAgentSnapshotLine,
  classifyFormField,
  createStepTokenStore,
  hashBrowserToolArguments,
  isOAuthConsentUrl,
  isOriginGranted,
  maskSensitiveValues,
  MASKED_VALUE,
  originPatternMatches,
  SENSITIVE_REASON,
  sensitiveReasonForField,
  toBrowserOrigin,
  toolGrantClass,
} from './browser-agent-checks';
import { sensitiveTargetsOf } from './browser-agent-probes';

const absentUrl: string | undefined = undefined;

const reversedArgumentKeys = (): Record<string, unknown> =>
  Object.fromEntries(Object.entries({ first: 1, second: [2] }).toReversed());

describe('origin normalisation', () => {
  it('drops the path, query and default port', () => {
    expect(toBrowserOrigin('https://Example.com:443/a?b#c')).toBe('https://example.com');
    expect(toBrowserOrigin('http://localhost:3001/page')).toBe('http://localhost:3001');
    expect(toBrowserOrigin('http://127.0.0.1:80/')).toBe('http://127.0.0.1');
  });

  it('keeps a non-default port and collapses every file URL to one origin', () => {
    expect(toBrowserOrigin('http://localhost:8123/x')).toBe('http://localhost:8123');
    expect(toBrowserOrigin('file:///Users/me/page.html')).toBe('file://');
  });

  it('refuses browser-internal and extension pages', () => {
    expect(toBrowserOrigin('chrome://settings')).toBeUndefined();
    expect(toBrowserOrigin('chrome-extension://abc/sidepanel.html')).toBeUndefined();
    expect(toBrowserOrigin('about:blank')).toBeUndefined();
    expect(toBrowserOrigin(absentUrl)).toBeUndefined();
  });
});

describe('tool class mapping', () => {
  it('maps the read tools to read', () => {
    for (const name of ['browser_snapshot', 'browser_find', 'browser_take_screenshot']) {
      expect(toolGrantClass(name)).toBe('read');
    }
  });

  it('maps navigation to navigate', () => {
    expect(toolGrantClass('browser_navigate')).toBe('navigate');
    expect(toolGrantClass('browser_navigate_back')).toBe('navigate');
  });

  it('treats model-authored code as act (D11)', () => {
    expect(toolGrantClass('browser_evaluate')).toBe('act');
    expect(toolGrantClass('browser_run_code_unsafe')).toBe('act');
  });

  it('falls back to act for an unknown tool', () => {
    expect(toolGrantClass('browser_teleport')).toBe('act');
  });
});

describe('grant matching', () => {
  const grants = [
    { class: 'read' as const, origin: 'https://example.com' },
    { class: 'act' as const, origin: 'http://localhost:*' },
  ];

  it('matches class and origin exactly', () => {
    expect(isOriginGranted(grants, 'read', 'https://example.com')).toBe(true);
    expect(isOriginGranted(grants, 'act', 'https://example.com')).toBe(false);
    expect(isOriginGranted(grants, 'read', 'https://other.com')).toBe(false);
  });

  it('matches a wildcard origin', () => {
    expect(isOriginGranted(grants, 'act', 'http://localhost:5173')).toBe(true);
    expect(originPatternMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(originPatternMatches('*.example.com', 'example.com')).toBe(false);
  });
});

describe('argument hashing', () => {
  it('ignores key order and names the length', () => {
    expect(hashBrowserToolArguments({ first: 1, second: [2] })).toBe(
      hashBrowserToolArguments(reversedArgumentKeys())
    );
  });

  it('changes with a value', () => {
    expect(hashBrowserToolArguments({ first: 1 })).not.toBe(hashBrowserToolArguments({ first: 2 }));
  });
});

describe('step tokens', () => {
  const binding = {
    argumentHash: 'abc',
    element: 'e12',
    origin: 'https://example.com',
    session: 'session-1',
    tabId: 7,
    toolName: 'browser_type',
  };

  it('consumes a token once for the same call', () => {
    const store = createStepTokenStore({ now: () => 1000, random: () => 'token-1' });
    const token = store.issue({ ...binding, reason: SENSITIVE_REASON.password });

    expect(store.consume(token, binding)).toBe(true);
    expect(store.consume(token, binding)).toBe(false);
  });

  it('rejects a token bound to another tab, tool, element or argument set', () => {
    const store = createStepTokenStore({ now: () => 1000, random: () => 'token-2' });
    const token = store.issue({ ...binding, reason: SENSITIVE_REASON.password });

    expect(store.consume(token, { ...binding, tabId: 8 })).toBe(false);
  });

  it('expires after 60 s', () => {
    let clock = 1000;
    const store = createStepTokenStore({ now: () => clock, random: () => 'token-3' });
    const token = store.issue({ ...binding, reason: SENSITIVE_REASON.password });

    clock += 59_999;
    expect(store.consume(token, binding)).toBe(true);

    const second = store.issue({ ...binding, reason: SENSITIVE_REASON.password });
    clock += 60_000;
    expect(store.consume(second, binding)).toBe(false);
    expect(store.size()).toBe(0);
  });
});

describe('sensitive form fields', () => {
  it('classifies password, one-time-code and payment fields', () => {
    expect(classifyFormField({ type: 'password' })).toBe('password');
    expect(classifyFormField({ autocomplete: 'one-time-code' })).toBe('one-time-code');
    expect(classifyFormField({ autocomplete: 'section-a cc-number' })).toBe('payment');
    expect(classifyFormField({ name: 'card-number' })).toBe('payment');
    expect(classifyFormField({ name: 'email', type: 'email' })).toBeUndefined();
  });

  it('names the reason a human sees', () => {
    expect(sensitiveReasonForField('password')).toBe(SENSITIVE_REASON.password);
    expect(sensitiveReasonForField('payment')).toBe(SENSITIVE_REASON.paymentField);
    expect(sensitiveReasonForField('one-time-code')).toBe(SENSITIVE_REASON.oneTimeCode);
  });

  it('collects the targets of a fill_form call', () => {
    expect(
      sensitiveTargetsOf('browser_fill_form', {
        fields: [
          { name: 'Email', target: 'e1', type: 'textbox', value: 'a@b.c' },
          { name: 'Card', target: '#cc', type: 'textbox', value: '4111' },
        ],
      })
    ).toStrictEqual(['e1', '#cc']);
    expect(sensitiveTargetsOf('browser_navigate', { element: 'e1' })).toStrictEqual([]);
  });
});

describe('oauth consent pages', () => {
  it('matches the listed host and path routes', () => {
    expect(isOAuthConsentUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(isOAuthConsentUrl('https://accounts.google.com/signin/oauth/consent')).toBe(true);
    expect(isOAuthConsentUrl('https://github.com/login/oauth/authorize?client_id=1')).toBe(true);
    expect(
      isOAuthConsentUrl('https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize')
    ).toBe(true);
    expect(isOAuthConsentUrl('https://appleid.apple.com/auth/authorize')).toBe(true);
  });

  it('does not match a normal page on the same host', () => {
    expect(isOAuthConsentUrl('https://github.com/Kilo-Org/cloud')).toBe(false);
    expect(isOAuthConsentUrl('https://accounts.google.com/gsi/client')).toBe(false);
    expect(isOAuthConsentUrl(absentUrl)).toBe(false);
  });
});

describe('hidden text and value masking', () => {
  it('drops hidden text leaves and masks sensitive values', () => {
    const hidden = new Set(['secret note']);
    const values = new Set(['hunter2']);

    expect(
      applyAgentSnapshotLine(
        { depth: 0, name: 'secret note', role: '', textLeaf: true },
        {
          hiddenText: hidden,
          sensitiveValues: values,
        }
      )
    ).toBeUndefined();
    expect(
      applyAgentSnapshotLine(
        { depth: 0, name: 'hunter2', role: '', textLeaf: true },
        {
          hiddenText: hidden,
          sensitiveValues: values,
        }
      )
    ).toStrictEqual({ depth: 0, name: MASKED_VALUE, role: '', textLeaf: true });
    expect(
      applyAgentSnapshotLine(
        { depth: 1, name: 'Email', ref: 'e4', role: 'textbox' },
        {
          hiddenText: hidden,
          sensitiveValues: values,
        }
      )
    ).toStrictEqual({ depth: 1, name: 'Email', ref: 'e4', role: 'textbox' });
  });

  it('masks a value wherever it leaked into text', () => {
    expect(maskSensitiveValues('value=hunter2 and again hunter2', ['hunter2'])).toBe(
      'value=[masked] and again [masked]'
    );
  });
});

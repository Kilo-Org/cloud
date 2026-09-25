/* eslint-disable max-lines -- the suite owns the sign-in hierarchy contract and the inline-link touch-target audit for one screen, and the SSO-recovery, passkey, legal-link, and email-validation suites share one native-auth mock harness; splitting them would duplicate every mock in this file */
// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement } from 'react';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openBrowserAsync } from 'expo-web-browser';
import {
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_CONNECTOR_CLASS,
  INLINE_LINK_FACING_HIT_SLOP_DP,
  INLINE_LINK_OUTER_HIT_SLOP_DP,
  INLINE_LINK_ROW_CLASS,
  INLINE_LINK_ROW_MARGIN_DP,
  INLINE_LINK_VERTICAL_HIT_SLOP_DP,
  MIN_TAP_TARGET_DP,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';
import { PRIVACY_URL, TERMS_URL } from '@/lib/config';

import { i18n } from '@/i18n';
import { IdleAuth, PROVIDER_GLYPH_SLOT_CLASS } from '../idle-auth';

type StartFn = (mode: 'signin' | 'sso', ssoEmail?: string) => Promise<void>;

type SsoRecoveryFixture = { email: string; ssoOrganizationId: string | undefined } | null;

const ssoRecovery: { value: SsoRecoveryFixture } = vi.hoisted(() => ({
  value: { email: 'user@example.com', ssoOrganizationId: 'org_1' },
}));

// The native passkey module is absent in the test runtime, so the capability is
// the one input the screen reads from the client module.
const passkeySupport = vi.hoisted(() => ({ supported: true }));

// Which provider controls the screen renders: Apple availability and the
// Google client ID both come from outside the component.
const providers = vi.hoisted(() => ({ appleAvailable: false, googleConfigured: false }));

// What the screen reads from the hook: a fixed result object plus the one piece
// of state the busy treatment depends on.
const nativeAuth = vi.hoisted(() => ({
  busy: undefined as 'apple' | 'otp-send' | 'passkey' | undefined,
  emailError: undefined as string | undefined,
  clearEmailError: vi.fn(),
  requestEmailCode: vi.fn(),
  signInWithApple: vi.fn(),
  signInWithPasskey: vi.fn(),
}));

vi.mock('@/lib/auth/passkey-client', () => ({
  passkeysSupported: () => passkeySupport.supported,
}));

vi.mock('@/lib/auth/use-native-auth', () => ({
  useNativeAuth: () => ({
    busy: nativeAuth.busy,
    emailError: nativeAuth.emailError,
    clearEmailError: nativeAuth.clearEmailError,
    googleConfigured: providers.googleConfigured,
    signInWithApple: nativeAuth.signInWithApple,
    signInWithGoogle: vi.fn(),
    signInWithPasskey: nativeAuth.signInWithPasskey,
    requestEmailCode: nativeAuth.requestEmailCode,
    verifyEmailCode: vi.fn(),
    ssoRecovery: ssoRecovery.value,
    clearSsoRecovery: vi.fn(),
    handleSsoError: vi.fn(),
  }),
}));

vi.mock('@/lib/login-draft', () => ({
  setLoginEmailDraft: vi.fn(),
  setSsoRecoveryDraft: vi.fn(),
}));

vi.mock('expo-apple-authentication', () => ({
  isAvailableAsync: vi.fn(async () => {
    await Promise.resolve();
    return providers.appleAvailable;
  }),
}));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
}));

vi.mock('sonner-native', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/login/email-otp-form', () => ({ EmailOtpForm: 'EmailOtpForm' }));
vi.mock('@/components/login/apple-logo', () => ({ AppleLogo: 'AppleLogo' }));
vi.mock('@/components/login/google-logo', () => ({ GoogleLogo: 'GoogleLogo' }));
vi.mock('@/components/ui/icons', () => ({ KeyRound: 'KeyRound' }));

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  TERMS_URL: 'https://app.kilo.ai/terms-app',
  PRIVACY_URL: 'https://app.kilo.ai/privacy-app',
}));

// The real hook pulls expo-router, which the mounted project cannot load.
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#14130f', mutedForeground: '#6f6a61' }),
}));

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;
const renderers: R[] = [];

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

async function mountIdleAuth(start: StartFn): Promise<R> {
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(IdleAuth, { start }));
    await Promise.resolve();
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  renderers.push(r);
  return r;
}

function texts(root: I): string[] {
  return root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    )
    .map(n => n.props.children as string);
}

function findButton(root: I, label: string): I {
  const buttons = root.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button');
  const btn = buttons.find(b => (b.props.accessibilityLabel as string) === label);
  if (!btn) {
    throw new Error(`button "${label}" not found`);
  }
  return btn;
}

function linkPressables(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      n.props.accessibilityRole === 'link'
  );
}

function findLink(root: I, label: string): I {
  const links = linkPressables(root).filter(link => link.props.accessibilityLabel === label);
  const link = links[0];
  if (!link || links.length !== 1) {
    throw new Error(`link "${label}" found ${links.length} times, expected once`);
  }
  return link;
}

/** The sentence end a legal link's accessibility label sits at. */
function linkEdge(label: string | undefined): 'start' | 'end' {
  return label === 'Terms' ? 'start' : 'end';
}

/**
 * The per-side slop the legal link at one end of the sentence must render. The
 * facing side (4dp) points at the connector, the outer side (12dp) reaches over
 * plain prose, and the two still add to the 44pt target from the 28dp audit
 * floor. The sentence is LTR in this suite's native mock.
 */
function expectedLinkSlop(edge: 'start' | 'end'): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  return {
    top: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
    bottom: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
    left: edge === 'start' ? INLINE_LINK_OUTER_HIT_SLOP_DP : INLINE_LINK_FACING_HIT_SLOP_DP,
    right: edge === 'start' ? INLINE_LINK_FACING_HIT_SLOP_DP : INLINE_LINK_OUTER_HIT_SLOP_DP,
  };
}

/**
 * The legal line's copy in render order: the prefix Text's children plus every
 * link label, connector, and the suffix, concatenated. The sentence's own word
 * spaces are what a reader sees, so a doubled space or a floating period shows
 * up here without measuring pixels.
 */
function legalSentence(root: I): string {
  const row = root.find(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'View' &&
      String(n.props.className).includes('flex-wrap')
  );
  return row
    .findAll(n => typeof n.type === 'string' && (n.type as string) === 'Text')
    .map(node => {
      const children = node.props.children;
      if (typeof children === 'string') {
        return children;
      }
      if (Array.isArray(children)) {
        return children.map(child => (typeof child === 'string' ? child : '')).join('');
      }
      return '';
    })
    .join('');
}

/** The box a control's className declares, in dp: its own height and width. */
function boxDp(className: string): { width: number; height: number } {
  const size = (axis: 'h' | 'w'): number => {
    const pattern = new RegExp(`^(?:min-)?${axis}-\\[(\\d+(?:\\.\\d+)?)px\\]$`);
    for (const part of className.split(/\s+/)) {
      const match = pattern.exec(part);
      if (match?.[1]) {
        return Number(match[1]);
      }
    }
    throw new Error(`no ${axis} size class in "${className}"`);
  };
  return { width: size('w'), height: size('h') };
}

/** The label Text inside a provider Button, whichever icon sits beside it. */
function labelText(button: I): I {
  return button.find(n => typeof n.type === 'string' && (n.type as string) === 'Text');
}

/**
 * Every node inside a provider Button that carries the reserved glyph-slot
 * className. The slot is what puts the label on the same axis in all three
 * rows, so the suite asserts exactly one per row and that all three match.
 */
function glyphSlots(button: I): I[] {
  return button.findAll(n => String(n.props.className).includes(PROVIDER_GLYPH_SLOT_CLASS));
}

function glyphSlot(button: I): I {
  const slots = glyphSlots(button);
  const slot = slots[0];
  if (!slot || slots.length !== 1) {
    throw new Error(`expected exactly one glyph slot, found ${slots.length}`);
  }
  return slot;
}

/**
 * The compiled flex layout of a label's own className, through the app's own
 * pipeline. Only the classes that decide the label's line allocation are
 * compiled, so the assertion protects native sizing rather than utility names;
 * pixel wrapping is verified on device.
 */
async function compiledLabelLayout(label: I) {
  const classes = (label.props.className as string)
    .split(' ')
    .filter(className => /^(?:flex-|text-center$)/.test(className))
    .join(' ');
  const declarations = classes ? await compiledDeclarations(classes) : [];
  return declarations;
}

/** The compiled declarations of an arbitrary className, through the app's pipeline. */
async function compiledDeclarations(classes: string) {
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../../global.css"; .target { @apply ${classes}; }`,
    { from: import.meta.filename }
  );
  return (
    compile(css, { inlineVariables: false })
      .stylesheet()
      .s?.find(([name]) => name === 'target')?.[1]
      .flatMap(rule => rule.d ?? []) ?? []
  );
}

/** The numeric value of one compiled declaration, through the app's pipeline. */
async function compiledNumber(classes: string, property: string): Promise<number | undefined> {
  for (const declaration of await compiledDeclarations(classes)) {
    if (!Array.isArray(declaration)) {
      const plain = declaration as Record<string, unknown>;
      if (property in plain) {
        return plain[property] as number;
      }
    }
  }
  return undefined;
}

/** A Button that keeps the default (brand-filled) variant is a primary action. */
function filledPrimaryLabels(root: I): (string | undefined)[] {
  return root
    .findAll(n => typeof n.type === 'string' && (n.type as string) === 'Button')
    .filter(b => b.props.variant === undefined)
    .map(b => b.props.accessibilityLabel as string | undefined);
}

/** Every provider control that carries a leading glyph before its label. */
function providerRows(root: I): I[] {
  return ['Sign in with Apple', 'Sign in with Google', 'Sign in with a passkey'].map(label =>
    findButton(root, label)
  );
}

// Provider controls are opt-in per test; the file default is the plain
// email-only form every other suite renders.
beforeEach(() => {
  providers.appleAvailable = false;
  providers.googleConfigured = false;
});

describe('IdleAuth provider chrome parity', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    nativeAuth.busy = undefined;
    nativeAuth.signInWithApple.mockClear();
    passkeySupport.supported = true;
    providers.appleAvailable = true;
    providers.googleConfigured = true;
  });

  it('renders Apple, Google and the passkey with one outlined style', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const apple = findButton(renderer.root, 'Sign in with Apple');
    const google = findButton(renderer.root, 'Sign in with Google');
    const passkey = findButton(renderer.root, 'Sign in with a passkey');

    // One variant means one border colour and width (border-border) and one
    // fill (bg-card); one className means one corner radius and height. The
    // native AppleAuthenticationButton drew its own darker, thicker border, so
    // Apple now renders the app's own outline Button like its two siblings.
    for (const button of [apple, google, passkey]) {
      expect(button.props.variant).toBe('outline');
      expect(button.props.size).toBe('lg');
      expect(String(button.props.className)).toContain('min-h-[44px]');
      expect(String(button.props.className)).toContain('rounded-[8px]');
    }
    expect(apple.props.className).toBe(google.props.className);
    expect(apple.props.className).toBe(passkey.props.className);

    // One label size and weight across the three.
    const labelClasses = [apple, google, passkey].map(button =>
      String(labelText(button).props.className)
    );
    for (const classes of labelClasses) {
      expect(classes).toContain('text-[17px]');
      expect(classes).toContain('font-medium');
    }
    expect(labelClasses[0]).toBe(labelClasses[1]);
    expect(labelClasses[0]).toBe(labelClasses[2]);

    // Apple's HIG mark replaces the native chrome, drawn inside the button.
    expect(apple.findByType('AppleLogo')).toBeTruthy();

    expect(filledPrimaryLabels(renderer.root)).toEqual(['Continue with email']);

    act(() => {
      renderer.unmount();
    });
  });

  it('gives every provider row a leading glyph', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    // The three provider rows read as one group: each carries a leading mark in
    // the same reserved slot (the passkey row used to be label-only text). The
    // mark lives inside the row's slot, so the slot is what puts the label on
    // one axis and holds the mark, the spinner, or nothing.
    const leadingTypes = providerRows(renderer.root).map(
      row => glyphSlot(row).children.find(child => typeof child !== 'string')?.type
    );
    expect(leadingTypes).toEqual(['AppleLogo', 'GoogleLogo', 'KeyRound']);

    act(() => {
      renderer.unmount();
    });
  });

  it('labels the Apple row from the app catalog, not the device language', async () => {
    await i18n.changeLanguage('de');
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    // Apple's native control titles itself in the device language, which left
    // English "Sign in with Apple" beside the translated Google row. The Apple
    // row must use the catalog like every other control on the screen.
    expect(texts(renderer.root)).toContain('Mit Apple anmelden');
    expect(texts(renderer.root)).not.toContain('Sign in with Apple');
    expect(
      renderer.root.findAll(
        n => typeof n.type === 'string' && (n.type as string) === 'AppleAuthenticationButton'
      )
    ).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('signs in with Apple through the hook handler', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const apple = findButton(renderer.root, 'Sign in with Apple');
    act(() => {
      (apple.props.onPress as () => void)();
    });

    expect(nativeAuth.signInWithApple).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps one filled primary action without Apple sign-in', async () => {
    providers.appleAvailable = false;
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    expect(() => findButton(renderer.root, 'Sign in with Apple')).toThrow(
      'button "Sign in with Apple" not found'
    );
    expect(filledPrimaryLabels(renderer.root)).toEqual(['Continue with email']);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('IdleAuth text action affordance', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    nativeAuth.busy = undefined;
    passkeySupport.supported = false;
    providers.appleAvailable = false;
    providers.googleConfigured = false;
  });

  it('draws "More sign-in options" as an underlined link, not plain text', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    const more = findButton(renderer.root, 'More sign-in options');

    // A tappable control with no underline, chevron or button shape read as a
    // plain bold sentence next to the underlined Terms and Privacy Policy links.
    expect(more.props.variant).toBe('link');
    expect(more.props.className as string).toContain('active:opacity-60');
    const label = more.findAll(n => typeof n.type === 'string' && (n.type as string) === 'Text')[0];
    expect(label?.props.className as string).toContain('underline');

    act(() => {
      renderer.unmount();
    });
  });
});

describe('IdleAuth SSO recovery', () => {
  beforeEach(() => {
    ssoRecovery.value = { email: 'user@example.com', ssoOrganizationId: 'org_1' };
    nativeAuth.busy = undefined;
    passkeySupport.supported = true;
  });

  it('shows the recovery copy and forwards the SSO start', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    expect(texts(renderer.root)).toContain('Your organization uses single sign-on.');

    const btn = findButton(renderer.root, 'Continue with SSO');
    await act(async () => {
      await Promise.resolve();
      (btn.props.onPress as () => void)();
    });

    expect(start).toHaveBeenCalledWith('sso', 'user@example.com');
  });

  it('moves the SSO busy spinner inside its primary Button', async () => {
    const deferred: { resolve: () => void } = { resolve: () => undefined };
    const pending = new Promise<void>(resolve => {
      deferred.resolve = resolve;
    });
    const start = vi.fn<StartFn>(async () => {
      await pending;
    });
    const renderer = await mountIdleAuth(start);

    const idle = findButton(renderer.root, 'Continue with SSO');
    expect(idle.props.loading).not.toBe(true);

    act(() => {
      (idle.props.onPress as () => void)();
    });

    const busy = findButton(renderer.root, 'Continue with SSO');
    expect(busy.props.loading).toBe(true);
    expect(busy.props.disabled).toBe(true);
    // The busy spinner belongs to Button; the screen adds none of its own.
    expect(busy.findAllByType('ActivityIndicator')).toHaveLength(0);

    await act(async () => {
      deferred.resolve();
      await pending;
    });
  });
});

describe('IdleAuth passkey control', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    passkeySupport.supported = true;
    nativeAuth.busy = undefined;
    nativeAuth.signInWithPasskey.mockClear();
  });

  it('offers the passkey button above the email field', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const btn = findButton(renderer.root, 'Sign in with a passkey');
    expect(btn.props.variant).toBe('outline');
    expect(btn.props.size).toBe('lg');

    const order = renderer.root
      .findAll(n => typeof n.type === 'string' && ['Button', 'FormField'].includes(n.type))
      .map(n => n.props.accessibilityLabel ?? n.props.label);

    expect(order).toEqual([
      'Sign in with a passkey',
      'Email address',
      'Continue with email',
      'More sign-in options',
    ]);
  });

  it('starts the passkey ceremony on press', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const btn = findButton(renderer.root, 'Sign in with a passkey');
    act(() => {
      (btn.props.onPress as () => void)();
    });

    expect(nativeAuth.signInWithPasskey).toHaveBeenCalledTimes(1);
  });

  it('shows the busy treatment while the ceremony runs', async () => {
    nativeAuth.busy = 'passkey';
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const btn = findButton(renderer.root, 'Sign in with a passkey');
    expect(btn.props.disabled).toBe(true);
    expect(
      btn.findAll(n => typeof n.type === 'string' && (n.type as string) === 'ActivityIndicator')
    ).toHaveLength(1);
    expect(btn.parent?.props.pointerEvents).toBe('none');
  });

  it('renders no passkey control without the native module', async () => {
    passkeySupport.supported = false;
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    expect(() => findButton(renderer.root, 'Sign in with a passkey')).toThrow(
      'button "Sign in with a passkey" not found'
    );
    expect(texts(renderer.root)).not.toContain('Sign in with a passkey');
    // The other ways in are untouched.
    expect(findButton(renderer.root, 'Continue with email')).toBeTruthy();
  });
});
describe('IdleAuth provider label layout', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    nativeAuth.busy = undefined;
    passkeySupport.supported = true;
    providers.appleAvailable = false;
    providers.googleConfigured = true;
  });

  it('keeps every provider label on one line at equal button heights', async () => {
    // The Apple row is a provider row too: left on the pre-fix flex-wrap +
    // shrink classes it would let its label wrap onto its own flex line and
    // grow taller than the two siblings it is drawn to match.
    providers.appleAvailable = true;
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const apple = findButton(renderer.root, 'Sign in with Apple');
    const google = findButton(renderer.root, 'Sign in with Google');
    const passkey = findButton(renderer.root, 'Sign in with a passkey');

    for (const button of [apple, google, passkey]) {
      // A label must never be pushed onto its own flex line, so the icon stays
      // on the label's line and the stacked buttons keep one height.
      expect(String(button.props.className).split(/\s+/)).not.toContain('flex-wrap');
      // Keep the 44pt floor so Dynamic Type can still grow the control.
      expect(String(button.props.className)).toContain('min-h-[44px]');

      const label = labelText(button);
      // Larger accessibility text may still wrap naturally; never hide part of
      // the copy and never disable native font scaling.
      expect(label.props.numberOfLines).toBeUndefined();
      expect(label.props.adjustsFontSizeToFit).toBeUndefined();
      expect(label.props.ellipsizeMode).toBeUndefined();
      expect(label.props.allowFontScaling).not.toBe(false);
    }

    // The three provider controls carry one row class, so none of them can
    // drift back to the wrapping chrome on its own.
    expect(String(apple.props.className)).toBe(String(google.props.className));

    // flexBasis 0% + flexGrow 1 gives each label the whole remaining row width:
    // the remedy the resend-code label already ships (PR #6384).
    const oneLineLabel = { flexBasis: '0%', flexGrow: 1, flexShrink: 1, textAlign: 'center' };
    expect(await compiledLabelLayout(labelText(apple))).toEqual([oneLineLabel]);
    expect(await compiledLabelLayout(labelText(google))).toEqual([oneLineLabel]);
    expect(await compiledLabelLayout(labelText(passkey))).toEqual([oneLineLabel]);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the passkey row height while the ceremony runs', async () => {
    nativeAuth.busy = 'passkey';
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const button = findButton(renderer.root, 'Sign in with a passkey');
    expect(button.props.disabled).toBe(true);
    expect(
      button.findAll(n => typeof n.type === 'string' && (n.type as string) === 'ActivityIndicator')
    ).toHaveLength(1);
    // The inline indicator must not change the row's height: the label keeps its
    // one-line layout and the button keeps the 44pt floor.
    expect(String(button.props.className)).toContain('min-h-[44px]');
    expect(await compiledLabelLayout(labelText(button))).toEqual([
      { flexBasis: '0%', flexGrow: 1, flexShrink: 1, textAlign: 'center' },
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it('reserves one identical glyph slot per provider row', async () => {
    providers.appleAvailable = true;
    providers.googleConfigured = true;
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const buttons = [
      findButton(renderer.root, 'Sign in with Apple'),
      findButton(renderer.root, 'Sign in with Google'),
      findButton(renderer.root, 'Sign in with a passkey'),
    ];
    // Exactly one slot per row, with the identical className, so the three
    // flex-1 labels start from the same x with the marks in the same place.
    const slotClasses = buttons.map(button => String(glyphSlot(button).props.className));
    expect(slotClasses[0]).toBe(PROVIDER_GLYPH_SLOT_CLASS);
    expect(slotClasses[1]).toBe(slotClasses[0]);
    expect(slotClasses[2]).toBe(slotClasses[0]);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the passkey label className byte-identical while the ceremony runs', async () => {
    const idle = await mountIdleAuth(vi.fn<StartFn>());
    const idleClasses = String(
      labelText(findButton(idle.root, 'Sign in with a passkey')).props.className
    );
    act(() => {
      idle.unmount();
    });

    nativeAuth.busy = 'passkey';
    const busy = await mountIdleAuth(vi.fn<StartFn>());
    const busyButton = findButton(busy.root, 'Sign in with a passkey');
    // The spinner takes the reserved slot, so the label does not move.
    expect(glyphSlot(busyButton)).toBeTruthy();
    expect(String(labelText(busyButton).props.className)).toBe(idleClasses);

    act(() => {
      busy.unmount();
    });
  });

  it('keeps the Apple label className byte-identical while the request runs', async () => {
    providers.appleAvailable = true;
    const idle = await mountIdleAuth(vi.fn<StartFn>());
    const idleClasses = String(
      labelText(findButton(idle.root, 'Sign in with Apple')).props.className
    );
    act(() => {
      idle.unmount();
    });

    nativeAuth.busy = 'apple';
    const busy = await mountIdleAuth(vi.fn<StartFn>());
    const busyButton = findButton(busy.root, 'Sign in with Apple');
    // Replacing the 18pt mark with the spinner inside the same slot cannot
    // move the label.
    expect(glyphSlot(busyButton)).toBeTruthy();
    expect(String(labelText(busyButton).props.className)).toBe(idleClasses);

    act(() => {
      busy.unmount();
    });
  });
});
describe('IdleAuth email continue copy', () => {
  it('shows a Continue button with email accessibility', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    expect(texts(renderer.root)).toContain('Continue');
    expect(texts(renderer.root)).not.toContain('Sign in or create an account');

    const btn = findButton(renderer.root, 'Continue with email');
    expect(btn).toBeTruthy();
  });

  it('shows the Terms and Privacy Policy line', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    expect(texts(renderer.root)).toContain('Terms');
    expect(texts(renderer.root)).toContain('Privacy Policy');
  });

  it('offers each legal link as its own pressable target on the audit floor', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    const links = linkPressables(renderer.root);
    expect(links.map(link => link.props.accessibilityLabel)).toEqual(['Terms', 'Privacy Policy']);

    for (const link of links) {
      const box = boxDp(link.props.className as string);
      expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
      expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
      // Each link reaches the 44pt design target from its own rect: the facing
      // side (4dp) points at the connector, the outer side (12dp) reaches over
      // plain prose, so the two sides are not equal and the reach is
      // box + facing + outer rather than box + 2 * slop.
      const slop = link.props.hitSlop as {
        top: number;
        bottom: number;
        left: number;
        right: number;
      };
      expect(slop).toEqual(expectedLinkSlop(linkEdge(link.props.accessibilityLabel as string)));
      expect(box.width + slop.left + slop.right).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
      expect(box.height + slop.top + slop.bottom).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    }

    // The sentence's copy is unchanged: both labels still render, with the
    // connector and suffix the sentence carried before.
    expect(texts(renderer.root)).toEqual(
      expect.arrayContaining(['Terms', 'Privacy Policy', ' and ', '.'])
    );

    act(() => {
      renderer.unmount();
    });
  });

  it('routes the sentence connector through the shared inline-link gap', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    // The connector text is the only node between the two links, so it carries
    // the shared gap class that keeps their facing reaches off each other in a
    // catalog with a short conjunction (ru " и ", pl " i ", ar " و ",
    // zh " 和 "). `tap-target.test.ts` compiles the class's width.
    const connectors = renderer.root.findAll(
      n =>
        typeof n.type === 'string' && (n.type as string) === 'Text' && n.props.children === ' and '
    );
    expect(connectors).toHaveLength(1);
    expect(connectors[0]?.props.className).toContain(INLINE_LINK_CONNECTOR_CLASS);
    // The connector's compiled floor holds both facing reaches apart: 2 * 4dp
    // plus 2dp of headroom, so the two touch regions never meet between the
    // links. `tap-target.test.ts` checks the same floor against the constant.
    const connectorFloorDp = await compiledNumber(INLINE_LINK_CONNECTOR_CLASS, 'minWidth');
    expect(connectorFloorDp).toBeGreaterThanOrEqual(2 * INLINE_LINK_FACING_HIT_SLOP_DP);

    act(() => {
      renderer.unmount();
    });
  });

  it('opens the browser for Terms and Privacy Policy', async () => {
    const start = vi.fn<StartFn>();
    const renderer = await mountIdleAuth(start);

    const terms = findLink(renderer.root, 'Terms');
    act(() => {
      (terms.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith(TERMS_URL);

    const privacy = findLink(renderer.root, 'Privacy Policy');
    act(() => {
      (privacy.props.onPress as () => void)();
    });
    expect(openBrowserAsync).toHaveBeenCalledWith(PRIVACY_URL);
  });
});

describe('IdleAuth email validation layout', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    nativeAuth.busy = undefined;
    nativeAuth.emailError = undefined;
    nativeAuth.clearEmailError.mockClear();
    nativeAuth.requestEmailCode.mockReset();
  });

  it('keeps validation in the field before an enabled Continue, then accepts a correction', async () => {
    nativeAuth.emailError = 'Check your email address and try again.';
    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    const field = renderer.root.findByType('FormField');
    expect(field.props.error).toBe(nativeAuth.emailError);
    // The message renders in the field's own flow: no zero-opacity reserve, so
    // no empty hole under the input on the happy path.
    expect(field.props.reserveErrorMessages).toBeUndefined();
    expect(
      renderer.root.findAllByProps({ importantForAccessibility: 'no-hide-descendants' })
    ).toHaveLength(0);
    const button = findButton(renderer.root, 'Continue with email');
    expect(button.props.disabled).toBe(false);
    const siblings = field.parent?.children;
    expect(siblings?.indexOf(field)).toBeLessThan(siblings?.indexOf(button) ?? 0);
    act(() => {
      (field.props.onChangeText as (value: string) => void)('user@example.com');
    });
    expect(nativeAuth.clearEmailError).toHaveBeenCalledOnce();
    nativeAuth.emailError = undefined;
    nativeAuth.requestEmailCode.mockResolvedValue(true);
    await act(async () => {
      await (button.props.onPress as () => Promise<void>)();
    });
    expect(nativeAuth.requestEmailCode).toHaveBeenCalledWith('user@example.com');
    expect(renderer.root.findByType('EmailOtpForm').props.email).toBe('user@example.com');
    nativeAuth.requestEmailCode.mockResolvedValue(false);
    await act(async () => {
      (renderer.root.findByType('EmailOtpForm').props.onResend as () => void)();
      nativeAuth.emailError =
        'Unable to deliver email to this address. Please use a different email.';
      renderer.update(createElement(IdleAuth, { start: vi.fn<StartFn>() }));
      await Promise.resolve();
    });
    const remounted = renderer.root.findByType('FormField');
    expect(remounted.props.error).toBe(nativeAuth.emailError);
    // The field remounted when the view returned from OTP: it must show the
    // rejected address, not blank out while `emailRef` still holds it.
    expect(remounted.props.defaultValue).toBe('user@example.com');
  });

  it('keeps one indicator inside Continue and no reserved hole while loading', async () => {
    nativeAuth.busy = 'otp-send';
    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    // The loading state adds no reserved error slot under the field (the
    // base branch removed the zero-opacity reserve).
    expect(renderer.root.findByType('FormField').props.reserveErrorMessages).toBeUndefined();
    const continueButton = findButton(renderer.root, 'Continue with email');
    expect(continueButton.props.disabled).toBe(true);
    // Button owns the one busy spinner: the screen passes the busy flag and
    // renders no child indicator of its own, so nothing stacks.
    expect(continueButton.props.loading).toBe(true);
    expect(continueButton.findAllByType('ActivityIndicator')).toHaveLength(0);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  });

  it('uses the keyboard submit action for an empty field too', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());
    const field = renderer.root.findByType('FormField');
    expect(field.props.error).toBeUndefined();
    await act(async () => {
      (field.props.onSubmitEditing as () => void)();
      await Promise.resolve();
    });
    expect(nativeAuth.requestEmailCode).toHaveBeenCalledWith('');
    expect(renderer.root.findByType('FormField')).toBeTruthy();
  });
});

describe('IdleAuth layout repairs', () => {
  beforeEach(() => {
    ssoRecovery.value = null;
    nativeAuth.busy = undefined;
    nativeAuth.emailError = undefined;
    passkeySupport.supported = true;
    providers.appleAvailable = true;
    providers.googleConfigured = true;
  });

  it('leaves no invisible reserved error slot between the field and Continue', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    // The field used to reserve its tallest error in zero-opacity copies under
    // the input; the two-line 'Unable to deliver email...' message reserved a
    // 35pt hole the owner measured as a 50pt input-to-Continue gap.
    expect(renderer.root.findByType('FormField').props.reserveErrorMessages).toBeUndefined();
    expect(
      renderer.root.findAllByProps({ importantForAccessibility: 'no-hide-descendants' })
    ).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the field-to-Continue gutter on the shared screen gap', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    const field = renderer.root.findByType('FormField');
    const button = findButton(renderer.root, 'Continue with email');
    // The button is the field's next sibling in the screen's `gap-3` column, so
    // with no reserved slot the visible input-to-Continue space is exactly
    // `gap-3` (10.5pt / 21px at 2.02 px per point).
    expect(field.parent?.props.className).toBe('gap-3');
    expect(field.parent).toBe(button.parent);
    const siblings = field.parent?.children;
    expect(siblings?.indexOf(field)).toBeLessThan(siblings?.indexOf(button) ?? 0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders the legal sentence with single word spaces and no extra link padding', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    // The whole line reads as plain prose: one space between words, the period
    // tight against "Privacy Policy". The links' own px-1 padding widened every
    // boundary it touched.
    expect(legalSentence(renderer.root)).toBe(
      'By continuing you agree to our Terms and Privacy Policy.'
    );
    for (const link of linkPressables(renderer.root)) {
      expect(String(link.props.className)).not.toMatch(/(?:^|\s)px-/);
      expect(String(link.props.className)).toContain(INLINE_LINK_BOX_CLASS);
      expect(link.props.hitSlop).toEqual(
        expectedLinkSlop(linkEdge(link.props.accessibilityLabel as string))
      );
    }

    act(() => {
      renderer.unmount();
    });
  });

  it('cancels the inline link box height so the sentence keeps a text-xs line', async () => {
    // The audit floor stays on the node's own rect...
    expect(await compiledNumber(INLINE_LINK_BOX_CLASS, 'minHeight')).toBe(28);
    expect(await compiledNumber(INLINE_LINK_BOX_CLASS, 'minWidth')).toBe(28);
    // ...while the vertical cancel keeps (28 - 14) / 2 out of the text-xs row,
    // so the legal line is no taller than the surrounding prose.
    expect(await compiledNumber(INLINE_LINK_BOX_CLASS, 'marginBlock')).toBe(-7);
  });

  it('keeps each legal link touch region inside the row gutter, clear of the Continue button', async () => {
    const renderer = await mountIdleAuth(vi.fn<StartFn>());

    // A link's 44pt vertical region reaches (28 - 14) / 2 + 8 = 15dp past the
    // text-xs line it sits on. The screen's `gap-3` gutter to the Continue
    // button above the row (and the ghost button below) is 10.5dp — 4.5dp
    // short — so the legal row carries its own margin and the free space is
    // 10.5 + 5 = 15.5dp each side. Without that clearance the region started
    // 4.5dp inside the Continue button and a tap on the button's bottom strip
    // opened the link instead of sending the code (the earlier mis-routed-tap
    // finding).
    expect(INLINE_LINK_ROW_CLASS).toBe(`my-[${INLINE_LINK_ROW_MARGIN_DP}px]`);
    const overflowDp = (MIN_TAP_TARGET_DP - 14) / 2;
    const gutterDp = 10.5 + INLINE_LINK_ROW_MARGIN_DP;
    expect(overflowDp + INLINE_LINK_VERTICAL_HIT_SLOP_DP).toBeLessThanOrEqual(gutterDp);
    expect(overflowDp).toBe(7);

    const row = renderer.root.find(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'View' &&
        String(n.props.className).includes('flex-wrap')
    );
    expect(String(row.props.className)).toContain(INLINE_LINK_ROW_CLASS);

    for (const link of linkPressables(renderer.root)) {
      const slop = link.props.hitSlop as {
        top: number;
        bottom: number;
        left: number;
        right: number;
      };
      expect(slop.top).toBe(INLINE_LINK_VERTICAL_HIT_SLOP_DP);
      expect(slop.bottom).toBe(INLINE_LINK_VERTICAL_HIT_SLOP_DP);
      expect(overflowDp + slop.top).toBeLessThanOrEqual(gutterDp);
      expect(overflowDp + slop.bottom).toBeLessThanOrEqual(gutterDp);
      // The region the gutter bounds is still the full design target.
      const box = boxDp(link.props.className as string);
      expect(box.height + slop.top + slop.bottom).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    }

    act(() => {
      renderer.unmount();
    });
  });
});

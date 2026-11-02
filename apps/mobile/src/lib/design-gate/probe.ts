import { router } from 'expo-router';
import { Appearance, Dimensions, I18nManager, Linking, PixelRatio, Platform } from 'react-native';

import { i18n } from '@/i18n';
import { applyLanguagePreference } from '@/i18n/apply-language';
import { type SupportedLanguage } from '@/i18n/languages';
import { MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import {
  collect,
  type Document,
  type Insets,
  pressElement,
  type ProbeNode,
} from '@/lib/design-gate/collect';
import {
  getLanguagePreference,
  getResolvedLanguage,
  type LanguagePreference,
} from '@/lib/hooks/use-language-preference';
import { createSampler } from '@/lib/design-gate/sampler';

/**
 * Development-only layout probe for the design gate (`pnpm dev:mobile:design-gate`).
 * `DesignGateProbe` registers `globalThis.__kiloDesignGate` from the root layout.
 * The runner calls it over the Metro inspector with `Runtime.evaluate` and reads
 * the frame of every host element in dp, relative to the surface root, with
 * transforms applied. Layout-only Views are included: the element tree mirrors
 * the shadow tree, not the flattened native views.
 */

type ProbeEnv = Readonly<{
  platform: string;
  osVersion: string;
  route: string;
  window: Readonly<{ width: number; height: number }>;
  pixelRatio: number;
  fontScale: number;
  colorScheme: string;
  isRTL: boolean;
  language: string;
  languagePreference: string;
  safeArea: Insets;
  tapTarget: Readonly<{ min: number; touch: number }>;
}>;

type ProbeDump = Readonly<{ version: 1; env: ProbeEnv; nodes: readonly ProbeNode[] }>;

type ProbeSource = Readonly<{
  document: () => Document | null;
  route: () => string;
  safeArea: () => Insets;
}>;

function environment(source: ProbeSource): ProbeEnv {
  const window = Dimensions.get('window');
  return {
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    route: source.route(),
    window: { width: window.width, height: window.height },
    pixelRatio: PixelRatio.get(),
    fontScale: PixelRatio.getFontScale(),
    colorScheme: Appearance.getColorScheme() ?? 'unspecified',
    isRTL: I18nManager.isRTL,
    language: i18n.language,
    languagePreference: getLanguagePreference(),
    safeArea: source.safeArea(),
    tapTarget: { min: MIN_TAP_TARGET_DP, touch: TOUCH_TARGET_DP },
  };
}

// Hermes' inspector cannot await the app's promises, so commands start their work and
// return at once; the runner waits for the route, language, or reload it expects, and
// reads `lastOutcome()` when that change does not come.
export type DesignGateApi = Readonly<{
  ready: () => boolean;
  dump: () => string;
  startSampling: (intervalMs: number, maxMs: number) => void;
  stopSampling: () => string;
  dispose: () => void;
  setLanguage: (preference: LanguagePreference, resolved: SupportedLanguage) => void;
  resolvedLanguage: () => string;
  openLink: (url: string) => void;
  resetNavigation: () => void;
  press: (query: string) => string;
  lastOutcome: () => string;
}>;

export function createDesignGateApi(source: ProbeSource): DesignGateApi {
  let lastOutcome = 'none';
  const record = async (label: string, work: () => Promise<string>) => {
    lastOutcome = `${label}: pending`;
    try {
      lastOutcome = `${label}: ${await work()}`;
    } catch (error) {
      lastOutcome = `${label}: failed (${String(error)})`;
    }
  };
  const snapshot = (): ProbeDump => {
    const document = source.document();
    return {
      version: 1,
      env: environment(source),
      nodes: document === null ? [] : collect(document),
    };
  };
  const sampler = createSampler(snapshot);
  return {
    ready: () => source.document() !== null,
    dump: () => JSON.stringify(snapshot()),
    startSampling: (intervalMs, maxMs) => {
      sampler.start(intervalMs, maxMs);
    },
    stopSampling: () => JSON.stringify({ samples: sampler.stop(), truncated: sampler.truncated() }),
    dispose: () => {
      sampler.stop();
    },
    setLanguage: (preference, resolved) => {
      void record(`setLanguage ${preference}`, async () => {
        const outcome = await applyLanguagePreference(preference, resolved);
        return outcome.kind;
      });
    },
    resolvedLanguage: () => getResolvedLanguage(),
    // iOS asks "Open in Kilo?" for every URL a simulator command opens; the app's own
    // Linking call reaches the same native-intent path without that prompt.
    openLink: url => {
      void record(`openLink ${url}`, async () => {
        await Linking.openURL(url);
        return 'opened';
      });
    },
    // Every target opens from the root screen: a relaunch that restored the target route
    // still sees its link change the screen, and headers compare across cells.
    resetNavigation: () => {
      router.dismissTo('/');
    },
    // iOS has no tap command; the runner presses through the element's own handler.
    press: query => {
      const document = source.document();
      return document === null ? 'not-found' : pressElement(document, query);
    },
    lastOutcome: () => lastOutcome,
  };
}

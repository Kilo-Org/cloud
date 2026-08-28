/* eslint-disable import/no-nodejs-modules -- this CI inventory reads source, not runtime device data */
/* eslint-disable max-lines -- the complete presentation and dependency classifications form one audited contract */
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Counts = Record<string, number>;

function presentations(text: string): Counts {
  const source = ts.createSourceFile(
    'presentation.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const aliases = new Map<string, string>();
  const counts: Counts = {};
  const add = (family: string) => {
    counts[family] = (counts[family] ?? 0) + 1;
  };
  function nameOf(expression: ts.Node): string {
    if (ts.isIdentifier(expression)) {
      return aliases.get(expression.text) ?? expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = nameOf(expression.expression);
      return owner === 'Alert' ? `${owner}.${expression.name.text}` : expression.name.text;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteral(expression.argumentExpression)
    ) {
      const owner = nameOf(expression.expression);
      return owner === 'Alert'
        ? `${owner}.${expression.argumentExpression.text}`
        : expression.argumentExpression.text;
    }
    return '';
  }
  function visit(node: ts.Node) {
    if (ts.isImportSpecifier(node)) {
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        aliases.set(node.name.text, nameOf(node.initializer));
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            const property = element.propertyName?.getText(source) ?? element.name.text;
            aliases.set(
              element.name.text,
              nameOf(node.initializer) === 'Alert' ? `Alert.${property}` : property
            );
          }
        }
      }
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      nameOf(node.tagName) === 'Modal'
    ) {
      add('react-native-modal');
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ['NativeModules', 'TurboModuleRegistry'].includes(nameOf(node.expression))
    ) {
      add(`native-entry:${nameOf(node.expression)}`);
    }
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression);
      if (name === 'Alert.alert' || name === 'Alert.prompt') {
        add(name);
      }
      if (name === 'showActionSheetWithOptions') {
        add('action-sheet');
      }
      if (name === 'createElement' && node.arguments[0] && nameOf(node.arguments[0]) === 'Modal') {
        add('react-native-modal');
      }
      if (
        [
          'requireNativeModule',
          'requireOptionalNativeModule',
          'requireNativeComponent',
          'requireNativeView',
        ].includes(name)
      ) {
        const argument = node.arguments[0];
        add(`native-entry:${argument && ts.isStringLiteral(argument) ? argument.text : 'dynamic'}`);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source).replaceAll(/['"]/g, '') === 'presentation'
    ) {
      let value = node.initializer;
      while (
        ts.isAsExpression(value) ||
        ts.isParenthesizedExpression(value) ||
        ts.isSatisfiesExpression(value)
      ) {
        value = value.expression;
      }
      if (ts.isStringLiteral(value)) {
        add(`native-stack:${value.text}`);
      } else {
        let parent: ts.Node = node.parent;
        while (!ts.isSourceFile(parent) && !ts.isJsxAttribute(parent)) {
          parent = parent.parent;
        }
        if (
          ts.isJsxAttribute(parent) &&
          ['options', 'screenOptions'].includes(parent.name.getText(source))
        ) {
          add('native-stack:dynamic');
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return counts;
}

// r4's full presentation inventory, plus multiline Modal sites. No alert payload is a safe exception.
// Android: native-stack = Activity content; action-sheet = root/Modal. iOS: all belong to scene windows.
const inventory: Record<string, Counts> = {
  'app/(app)/(tabs)/(1_kiloclaw)/_layout.tsx': { 'native-stack:formSheet': 1 },
  'app/(app)/(tabs)/(2_agents)/index.tsx': { 'Alert.alert': 2 },
  'app/(app)/(tabs)/(3_profile)/organization/_layout.tsx': { 'native-stack:formSheet': 1 },
  'app/(app)/(tabs)/(3_profile)/security-agent/[scope]/_layout.tsx': {
    'native-stack:formSheet': 2,
  },
  'app/(app)/_layout.tsx': { 'native-stack:formSheet': 7, 'native-stack:modal': 3 },
  'app/(app)/agent-chat/use-new-session-discard-guard.ts': { 'Alert.alert': 1 },
  'app/(app)/kiloclaw/[instance-id]/changelog.tsx': { 'Alert.alert': 1 },
  'app/(app)/kiloclaw/[instance-id]/dashboard.tsx': { 'Alert.alert': 1 },
  'app/(app)/kiloclaw/[instance-id]/settings/device-pairing.tsx': { 'Alert.alert': 2 },
  'app/(app)/kiloclaw/[instance-id]/settings/google.tsx': { 'Alert.alert': 2 },
  'app/(app)/kiloclaw/[instance-id]/settings/version-pin.tsx': { 'Alert.alert': 1 },
  'app/(app)/pr-review/[owner]/[repo]/[number]/_layout.tsx': { 'native-stack:formSheet': 1 },
  'app/(auth)/_layout.tsx': { 'native-stack:formSheet': 1 },
  'components/agents/attachment-picker.ts': { 'Alert.alert': 1, 'action-sheet': 1 },
  'components/agents/attachment-preview-strip.tsx': { 'action-sheet': 1 },
  'components/agents/chat-markdown-text.tsx': { 'action-sheet': 2 },
  'components/agents/file-part-renderer.tsx': { 'action-sheet': 1 },
  'components/agents/markdown-link-confirm.ts': { 'Alert.alert': 1 },
  'components/agents/markdown-table.tsx': { 'react-native-modal': 1 },
  'components/agents/message-details-sheet.tsx': { 'Alert.alert': 1 },
  'components/agents/platform-filter-modal.tsx': { 'react-native-modal': 1 },
  'components/agents/question-card.tsx': { 'Alert.alert': 1 },
  'components/agents/remote-session-exit-alert.ts': { 'Alert.alert': 1 },
  'components/agents/session-page-sheet.tsx': { 'react-native-modal': 2 },
  'components/agents/session-row-actions.ts': {
    'Alert.alert': 1,
    'Alert.prompt': 1,
    'action-sheet': 1,
  },
  'components/agents/use-message-copy.ts': { 'action-sheet': 1 },
  'components/code-reviewer/review-detail-screen.tsx': { 'Alert.alert': 2 },
  'components/consent/consent-card.tsx': { 'Alert.alert': 1 },
  'components/device-sessions-screen.tsx': { 'Alert.alert': 2 },
  'components/image-viewer-modal.tsx': { 'react-native-modal': 1 },
  'components/kilo-chat/conversation-row.tsx': { 'Alert.alert': 1, 'action-sheet': 1 },
  'components/kilo-chat/hooks/use-conversation-message-actions.ts': {
    'Alert.alert': 1,
    'action-sheet': 1,
  },
  'components/kilo-chat/hooks/use-conversation-options-sheet.ts': {
    'Alert.alert': 1,
    'action-sheet': 1,
  },
  'components/kilo-chat/message-attachment-picker.ts': { 'Alert.alert': 1 },
  'components/kilo-chat/message-input-attachment-queue.tsx': { 'action-sheet': 1 },
  'components/kiloclaw/instance-controls.tsx': { 'Alert.alert': 4 },
  'components/kiloclaw/onboarding/identity-step.tsx': { 'Alert.alert': 1 },
  'components/kiloclaw/onboarding/notifications-step.tsx': { 'Alert.alert': 1 },
  'components/kiloclaw/settings-card.tsx': { 'Alert.alert': 1 },
  'components/notifications-screen.tsx': { 'Alert.alert': 2 },
  'components/organization/invited-member-row.tsx': { 'Alert.alert': 1, 'action-sheet': 1 },
  'components/organization/member-row.tsx': { 'Alert.alert': 1, 'action-sheet': 2 },
  'components/pr-review/discussion/comment-row.tsx': { 'Alert.alert': 1, 'action-sheet': 1 },
  'components/pr-review/discussion/reaction-picker-sheet.tsx': { 'react-native-modal': 1 },
  'components/pr-review/discussion/reply-input.tsx': { 'Alert.alert': 2 },
  'components/pr-review/merge/pr-merge-sheet.tsx': { 'Alert.alert': 2 },
  'components/pr-review/pr-review-comment-composer-screen.tsx': { 'Alert.alert': 1 },
  'components/pr-review/pr-review-comment-composer.tsx': { 'Alert.alert': 1 },
  'components/pr-review/pr-review-entry-screen.tsx': { 'Alert.alert': 1 },
  'components/pr-review/pr-review-submit.tsx': { 'Alert.alert': 1 },
  'components/profile-credits-card.tsx': { 'action-sheet': 1 },
  'components/profile-screen.tsx': { 'Alert.alert': 2 },
  'components/rename-modal.tsx': { 'react-native-modal': 1 },
  'components/security-agent/automation-settings-screen.tsx': { 'Alert.alert': 1 },
  'components/security-agent/dashboard-screen.tsx': { 'action-sheet': 1 },
  'components/security-agent/finding-analysis-panel.tsx': { 'Alert.alert': 1 },
  'components/security-agent/finding-remediation-panel.tsx': { 'Alert.alert': 1 },
  'components/share/share-gate-sheet.tsx': { 'Alert.alert': 2 },
  'lib/feedback.ts': { 'Alert.alert': 1 },
  'lib/hooks/use-settings-back-guard.ts': { 'Alert.alert': 1 },
  'lib/hooks/use-tracking-permission-prompt.ts': { 'Alert.alert': 1 },
  'lib/local-access-privacy.ts': { 'native-entry:LocalAccessPrivacy': 1 },
  'lib/voice-input/use-voice-input-actions.ts': { 'Alert.alert': 2 },
};

// Classify every dependency, not just names matching "expo" or "native". A new window library must fail closed.
const libraries = {
  applicationWindows: [
    'react-native',
    'react-native-screens',
    'expo-router',
    '@expo/react-native-action-sheet',
  ],
  rootContent: [
    '@rn-primitives/portal',
    '@rn-primitives/slot',
    'sonner-native',
    '@shopify/flash-list',
    'react-native-marked',
  ],
  systemPresentation: [
    '@react-native-google-signin/google-signin',
    'expo-apple-authentication',
    'expo-clipboard',
    'expo-document-picker',
    'expo-iap',
    'expo-image-picker',
    'expo-local-authentication',
    'expo-location',
    'expo-notifications',
    'expo-share-intent',
    'expo-sharing',
    'expo-speech-recognition',
    'expo-store-review',
    'expo-tracking-transparency',
    'expo-web-browser',
  ],
  noAdditionalProductWindows: [
    '@expo-google-fonts/jetbrains-mono',
    '@expo/app-integrity',
    '@formatjs/intl-durationformat',
    '@formatjs/intl-listformat',
    '@formatjs/intl-locale',
    '@formatjs/intl-numberformat',
    '@formatjs/intl-pluralrules',
    '@formatjs/intl-relativetimeformat',
    '@formatjs/intl-segmenter',
    '@kilocode/app-shared',
    '@kilocode/cloud-agent-sdk',
    '@kilocode/event-service',
    '@kilocode/kilo-chat',
    '@kilocode/kilo-chat-hooks',
    '@kilocode/notifications',
    '@kilocode/trpc',
    '@react-native-community/netinfo',
    '@sentry/react-native',
    '@tailwindcss/postcss',
    '@tanstack/query-async-storage-persister',
    '@tanstack/react-query',
    '@tanstack/react-query-persist-client',
    '@trpc/client',
    '@trpc/tanstack-react-query',
    'class-variance-authority',
    'clsx',
    'drizzle-orm',
    'expo',
    'expo-application',
    'expo-blur',
    'expo-build-properties',
    'expo-constants',
    'expo-crypto',
    'expo-dev-client',
    'expo-device',
    'expo-file-system',
    'expo-font',
    'expo-haptics',
    'expo-image',
    'expo-image-manipulator',
    'expo-keep-awake',
    'expo-linear-gradient',
    'expo-linking',
    'expo-localization',
    'expo-screen-capture',
    'expo-screen-corner-radius',
    'expo-secure-store',
    'expo-splash-screen',
    'expo-sqlite',
    'expo-status-bar',
    'i18next',
    'jotai',
    'lowlight',
    'lucide-react-native',
    'nativewind',
    'posthog-react-native',
    'react',
    'react-i18next',
    'react-native-appsflyer',
    'react-native-css',
    'react-native-gesture-handler',
    'react-native-reanimated',
    'react-native-safe-area-context',
    'react-native-svg',
    'react-native-worklets',
    'tailwind-merge',
    'tailwindcss',
    'ulid',
    'zod',
  ],
};
const knownLibraries = Object.values(libraries).flat();

function assertLibraries(names: string[]) {
  expect(names.toSorted(), 'Unclassified dependency or retired window contract').toEqual(
    knownLibraries.toSorted()
  );
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' ? [] : sources(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.|test-helpers|test-utils/.test(entry.name)
      ? [path]
      : [];
  });
}

function assertClassified(file: string, text: string) {
  expect(presentations(text), `Unclassified native presentation: ${file}`).toEqual(
    inventory[file] ?? {}
  );
}

describe('application presentation inventory', () => {
  it('classifies every current presentation, including multiline Modals and every alert', () => {
    const root = resolve('src');
    const actual = Object.fromEntries(
      sources(root)
        .map<[string, Counts]>(file => [
          relative(root, file),
          presentations(readFileSync(file, 'utf8')),
        ])
        .filter(([, counts]) => Object.keys(counts).length > 0)
    );
    expect(actual).toEqual(inventory);
  });
  it.each([
    'import { Modal as Sheet } from "react-native"; const view = <Sheet />;',
    'import * as Native from "react-native"; const view = <Native.Modal />;',
    'import { Modal } from "react-native"; React.createElement(Modal);',
    'import { Alert as Dialog } from "react-native"; Dialog.alert("secret");',
    'const { prompt: show } = Alert; show("secret");',
    'const show = Alert["alert"]; show("secret");',
    'const view = <Stack.Screen options={{ presentation: "formSheet" }} />;',
    'const view = <Stack.Screen options={{ presentation: "transparentModal" }} />;',
    'const view = <Stack.Screen options={{ presentation: unknownMode }} />;',
    'ActionSheetIOS.showActionSheetWithOptions({});',
    'const { showActionSheetWithOptions: show } = useActionSheet(); show({});',
    'requireNativeView("UnregisteredWindow");',
    'NativeModules.UnregisteredDialog.show();',
    'TurboModuleRegistry.getEnforcing("UnregisteredWindow");',
  ])('rejects a new unclassified presentation: %s', fixture => {
    expect(() => {
      assertClassified('unclassified.tsx', fixture);
    }).toThrow();
  });
  it('rejects an additional family inside an already classified file', () => {
    expect(() => {
      assertClassified('components/rename-modal.tsx', '<><Modal /><Extra /><Modal /></>');
    }).toThrow();
  });
  it('requires a classification for each installed dependency', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assertLibraries(Object.keys(manifest.dependencies));
  });
  it('rejects a new library without relying on a native naming convention', () => {
    expect(() => {
      assertLibraries([...knownLibraries, 'another-window-kit']);
    }).toThrow();
  });
});

const moduleRoot = resolve('modules/local-access-privacy');
const android = 'android/src/main/java/expo/modules/localaccessprivacy/';
const source = (path: string) => readFileSync(resolve(moduleRoot, path), 'utf8');

function assertImmediateOpacity(text: string) {
  expect(text).not.toMatch(
    /asyncAfter|postDelayed|UIView\.animate|ValueAnimator|enableAppSwitcherProtection|isSecureTextEntry/
  );
}

type NativeRegistration = {
  platforms: string[];
  apple: { modules: string[]; appDelegateSubscribers: string[] };
  android: { modules: string[] };
};

function assertNativeRegistration(config: NativeRegistration) {
  const swift = /public final class (\w+): Module\b/.exec(
    source('ios/LocalAccessPrivacyModule.swift')
  )?.[1];
  const subscriber = /public final class (\w+): ExpoAppDelegateSubscriber\b/.exec(
    source('ios/LocalAccessPrivacyAppDelegateSubscriber.swift')
  )?.[1];
  const kotlin = source(`${android}LocalAccessPrivacyModule.kt`);
  const packageName = /^package (\S+)/m.exec(kotlin)?.[1];
  const className = /^class (\w+) : Module\(\)/m.exec(kotlin)?.[1];
  expect(config.platforms.toSorted()).toEqual(['android', 'apple']);
  expect(config.apple.modules).toEqual([swift]);
  expect(config.apple.appDelegateSubscribers).toEqual([subscriber]);
  expect(config.android.modules).toEqual([`${packageName}.${className}`]);
}

function assertNativeLibraries(gradle: string, podspec: string) {
  const androidImports = [
    ...gradle.matchAll(/^\s*(?:implementation|api|compileOnly|runtimeOnly)\b(.+)$/gm),
  ].map(match => match[1]?.trim());
  const appleImports = [...podspec.matchAll(/\bs\.dependency\s+(.+)/g)].map(match =>
    match[1]?.trim()
  );
  expect(androidImports).toEqual(["'androidx.fragment:fragment-ktx:1.8.9'"]);
  expect(appleImports).toEqual(["'ExpoModulesCore'"]);
}

function assertNativeModules(names: string[]) {
  expect(
    names.toSorted(),
    'A new local native module needs a window-family classification'
  ).toEqual(['local-access-privacy']);
}

describe('native window source contracts, not device snapshot proof', () => {
  it('classifies local native modules and both native dependency declarations', () => {
    assertNativeModules(
      readdirSync('modules', { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    );
    assertNativeLibraries(source('android/build.gradle'), source('ios/LocalAccessPrivacy.podspec'));
  });
  it('rejects an unclassified local native module', () => {
    expect(() => {
      assertNativeModules(['local-access-privacy', 'new-window-module']);
    }).toThrow();
  });
  it.each(['android', 'apple'])('rejects an unclassified native dependency on %s', platform => {
    const gradle = source('android/build.gradle');
    const podspec = source('ios/LocalAccessPrivacy.podspec');
    const changedGradle =
      platform === 'android'
        ? gradle.replace(
            "implementation 'androidx.fragment:fragment-ktx:1.8.9'",
            "implementation 'androidx.fragment:fragment-ktx:1.8.9'\n  implementation('unclassified:window:1')"
          )
        : gradle;
    const changedPodspec =
      platform === 'apple'
        ? podspec.replace(
            "s.dependency 'ExpoModulesCore'",
            "s.dependency 'ExpoModulesCore'\n  s.dependency 'UnclassifiedWindow'"
          )
        : podspec;
    expect(() => {
      assertNativeLibraries(changedGradle, changedPodspec);
    }).toThrow();
  });
  it.each(['platforms', 'apple-module', 'subscriber', 'android-module'])(
    'rejects missing native registration: %s',
    field => {
      const config = JSON.parse(source('expo-module.config.json')) as NativeRegistration;
      if (field === 'platforms') {
        config.platforms = [];
      } else if (field === 'apple-module') {
        config.apple.modules = [];
      } else if (field === 'subscriber') {
        config.apple.appDelegateSubscribers = [];
      } else {
        config.android.modules = [];
      }
      expect(() => {
        assertNativeRegistration(config);
      }).toThrow();
    }
  );
  it('connects the Expo registration to real modules, subscribers, and the TypeScript native entry', () => {
    const config = JSON.parse(source('expo-module.config.json')) as NativeRegistration;
    assertNativeRegistration(config);
    const entry = /requireNativeModule<PrivacyModule>\('([^']+)'\)/.exec(
      readFileSync('src/lib/local-access-privacy.ts', 'utf8')
    )?.[1];
    expect(entry).toBeDefined();
    expect(source('ios/LocalAccessPrivacyModule.swift')).toContain(`Name("${entry}")`);
    expect(source(`${android}LocalAccessPrivacyModule.kt`)).toContain(`Name("${entry}")`);
    expect(source(`${android}LocalAccessPrivacyPackage.kt`)).toMatch(
      /import expo\.modules\.core\.interfaces\.Package/
    );
    expect(source('ios/LocalAccessPrivacy.podspec')).toContain("s.dependency 'ExpoModulesCore'");
    expect(source('android/build.gradle')).toContain("id 'expo-module-gradle-plugin'");
  });
  it('covers UIKit scenes and alert+1 application windows without changing system windows', () => {
    const coordinator = source('ios/LocalAccessPrivacy.swift');
    expect(coordinator).toMatch(/connectedScenes[\s\S]*scene\.windows/);
    expect(coordinator).toContain('UIScene.willDeactivateNotification');
    expect(coordinator).toContain('UIWindow.didBecomeVisibleNotification');
    expect(coordinator).toContain('UIApplication.shared.windows');
    expect(coordinator).toContain('updateLegacyWindows(legacyWindows)');
    expect(coordinator).toContain('level: topLevel + 1');
    expect(coordinator).toContain('window.accessibilityElementsHidden = true');
    expect(coordinator).toContain('window.accessibilityElementsHidden = previousAccessibility');
    expect(source('ios/LocalAccessPrivacyAppDelegateSubscriber.swift')).toMatch(
      /applicationWillResignActive[\s\S]*applicationActive\(false\)/
    );
    expect(source('ios/PrivacySceneWindow.swift')).toContain(
      'override var canBecomeKey: Bool { acceptsKey }'
    );
    const alert = readFileSync(
      'node_modules/react-native/React/CoreModules/RCTAlertController.mm',
      'utf8'
    );
    expect(alert).toContain('UIWindowLevelAlert + 1');
  });
  it('registers immediate Android lifecycle, pre-show alerts, and synchronous Modal creation', () => {
    const coordinator = source(`${android}LocalAccessPrivacy.kt`);
    expect(coordinator).toContain('application.registerActivityLifecycleCallbacks(this)');
    expect(coordinator).toContain('registerFragmentLifecycleCallbacks(fragments, true)');
    expect(coordinator).toMatch(/onFragmentActivityCreated[\s\S]*registerDialog\(f\)/);
    expect(coordinator).toMatch(/dialog\.create\(\)[\s\S]*dialog\.window\?\.let \{ register/);
    expect(coordinator).toContain('context.addExtraWindowEventListener(this)');
    expect(coordinator).toContain('view is ReactModalHostView');
    expect(coordinator).toMatch(/onExtraWindowCreate[\s\S]*register\(window/);
    expect(coordinator).toContain('onDetach = { detachWindow(window) }');
    expect(coordinator).toContain('if (!window.decorView.isAttachedToWindow) unregister(window)');
    expect(coordinator).toContain('androidx.biometric.');
    const cover = source(`${android}ApplicationWindowCover.kt`);
    expect(cover).toContain('OnPreDrawListener');
    expect(cover).toContain('return@OnPreDrawListener false');
    expect(cover).toContain('IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS');
    expect(cover).toContain('view.importantForAccessibility = previous');
    expect(cover).toContain('hideSoftInputFromWindow');
    expect(cover).toContain('FLAG_SECURE');
  });
  it('keeps assertions synchronous and checks announcements after native queue waits', () => {
    for (const path of [
      'ios/LocalAccessPrivacyModule.swift',
      `${android}LocalAccessPrivacyModule.kt`,
    ]) {
      const text = source(path);
      expect(text).toMatch(/\n\s+Function\("isForegroundAllowed"\)/);
      expect(text).toMatch(/\n\s+Function\("publishVisibility"\)/);
      expect(text).toMatch(
        /AsyncFunction\("announce"\)[\s\S]*runOnQueue\((?:\.main|Queues.MAIN)\)/
      );
    }
    expect(source('ios/LocalAccessPrivacyModule.swift')).toMatch(
      /guard LocalAccessPrivacy.shared.admitsAnnouncement[\s\S]*UIAccessibility.post/
    );
    expect(source(`${android}LocalAccessPrivacy.kt`)).toMatch(
      /if \(!state.admitsAnnouncement[\s\S]*manager.sendAccessibilityEvent/
    );
  });
  it('uses immediate native opacity without delayed blur or secure-layer reparenting', () => {
    for (const path of [
      'ios/LocalAccessPrivacy.swift',
      'ios/PrivacySceneWindow.swift',
      'ios/LocalAccessPrivacyAppDelegateSubscriber.swift',
      `${android}LocalAccessPrivacy.kt`,
      `${android}ApplicationWindowCover.kt`,
    ]) {
      assertImmediateOpacity(source(path));
    }
  });
  it.each([
    'UIView.animate(withDuration: 0.3)',
    'handler.postDelayed(cover, 300)',
    'isSecureTextEntry = true',
  ])('rejects a delayed or incompatible opacity implementation: %s', fixture => {
    expect(() => {
      assertImmediateOpacity(fixture);
    }).toThrow();
  });
});

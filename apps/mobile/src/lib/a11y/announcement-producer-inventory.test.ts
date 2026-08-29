/* eslint-disable import/no-nodejs-modules -- this inventory reads application source, not device data */
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Counts = Record<string, number>;

const directNativeMethods = new Set([
  'announceForAccessibility',
  'announceForAccessibilityWithOptions',
  'sendAccessibilityEvent',
]);

function announcements(text: string): Counts {
  const source = ts.createSourceFile(
    'announcement.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const aliases = new Map<string, string>();
  const counts: Counts = {};
  const add = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  function nameOf(node: ts.Node): string {
    if (ts.isIdentifier(node)) {
      return aliases.get(node.text) ?? node.text;
    }
    if (ts.isStringLiteralLike(node)) {
      return node.text;
    }
    if (ts.isPropertyAccessExpression(node)) {
      return ['call', 'apply', 'bind'].includes(node.name.text)
        ? nameOf(node.expression)
        : node.name.text;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      return node.argumentExpression.text;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return nameOf(node.expression);
    }
    return '';
  }
  function bind(local: string, imported: string) {
    aliases.set(local, imported);
    if (directNativeMethods.has(imported)) {
      add('unguarded-native');
    }
  }
  function visit(node: ts.Node) {
    if (ts.isImportSpecifier(node)) {
      bind(node.name.text, node.propertyName?.text ?? node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        aliases.set(node.name.text, nameOf(node.initializer));
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            bind(element.name.text, nameOf(element.propertyName ?? element.name));
          }
        }
      }
    }
    // Detect native method references too: aliases and callback passing cannot hide a bypass.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (directNativeMethods.has(nameOf(node))) {
        add('unguarded-native');
      } else if (
        ts.isElementAccessExpression(node) &&
        !ts.isStringLiteralLike(node.argumentExpression) &&
        nameOf(node.expression) === 'AccessibilityInfo'
      ) {
        add('unguarded-native');
      }
    }
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression);
      if (name === 'announceForA11y') {
        add('protected-helper');
      } else if (name === 'announceLocalAccessPrivacy') {
        add(node.arguments.length === 1 ? 'protected-native-adapter' : 'explicit-native-kind');
      } else if (name === 'announce') {
        add('announcement-dispatch');
      }
    }
    if (
      (ts.isPropertyAssignment(node) && nameOf(node.initializer) === 'announceForA11y') ||
      (ts.isShorthandPropertyAssignment(node) && nameOf(node.name) === 'announceForA11y')
    ) {
      add('protected-callback');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return counts;
}

// Every application producer enters the protected helper, including injected blocking-card callbacks.
// The sole native dispatch belongs to the generation-fenced adapter; native suites verify its final guard.
const inventory: Record<string, Counts> = {
  'app/_layout.tsx': { 'protected-helper': 1 },
  'components/agents/blocking-card-state.ts': { 'announcement-dispatch': 1 },
  'components/agents/permission-card.tsx': { 'protected-callback': 1 },
  'components/agents/question-card.tsx': { 'protected-callback': 1 },
  'components/agents/session-message-list.tsx': { 'protected-helper': 1 },
  'components/agents/use-interaction-handlers.ts': { 'protected-helper': 3 },
  'components/kilo-chat/message-list.tsx': { 'protected-helper': 1 },
  'components/offline-banner.tsx': { 'protected-helper': 1 },
  'components/pr-review/pr-review-pending-comment-row.tsx': { 'protected-helper': 1 },
  'lib/a11y/announce.ts': { 'protected-native-adapter': 1 },
  'lib/a11y/announcing-toast.ts': { 'protected-helper': 3 },
  'lib/a11y/status-announcement.ts': { 'protected-helper': 1 },
  'lib/agent-attachments/use-agent-attachment-upload.ts': { 'protected-helper': 1 },
  'lib/local-access-privacy.ts': { 'announcement-dispatch': 1 },
  'lib/pr-review/diff/use-pr-diff-list-scroll.ts': { 'protected-helper': 1 },
  'lib/pr-review/merge/use-pr-merge-mutations.ts': { 'protected-helper': 2 },
  'lib/pr-review/use-pr-review-mutations.ts': { 'protected-helper': 2 },
  'lib/voice-input/use-voice-input-actions.ts': { 'protected-helper': 1 },
};

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' || entry.name === '__tests__' ? [] : sources(path);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.test\.|test-helpers|test-utils/.test(entry.name)
      ? [path]
      : [];
  });
}

function assertClassified(file: string, text: string) {
  expect(announcements(text), `Unclassified announcement producer: ${file}`).toEqual(
    inventory[file] ?? {}
  );
}

describe('application announcement producer inventory', () => {
  it('classifies every producer and permits no direct React Native announcement', () => {
    const root = resolve('src');
    const actual = Object.fromEntries(
      sources(root)
        .map<[string, Counts]>(file => [
          relative(root, file),
          announcements(readFileSync(file, 'utf8')),
        ])
        .filter(([, counts]) => Object.keys(counts).length > 0)
    );
    expect(actual).toEqual(inventory);
  });

  it.each([
    'AccessibilityInfo.announceForAccessibility("secret");',
    'AccessibilityInfo.announceForAccessibilityWithOptions("secret", { queue: true });',
    'import { AccessibilityInfo as Info } from "react-native"; Info.announceForAccessibility("secret");',
    'import * as Native from "react-native"; Native.AccessibilityInfo.announceForAccessibility("secret");',
    'const { announceForAccessibility: say } = AccessibilityInfo; say("secret");',
    'const { "announceForAccessibility": say } = AccessibilityInfo; say("secret");',
    'const say = AccessibilityInfo["announceForAccessibility"]; say("secret");',
    'const callback = AccessibilityInfo.announceForAccessibility;',
    'import { announceForAccessibility as say } from "react-native"; say("secret");',
    'AccessibilityInfo[method]("secret");',
    'NativeModules.AccessibilityManager.announceForAccessibility("secret");',
    'AccessibilityInfo.sendAccessibilityEvent(1, "announcement");',
    'announceForA11y("secret");',
    'import { announceForA11y as say } from "@/lib/a11y/announce"; say("secret");',
    'announceLocalAccessPrivacy("secret", "gate");',
    'const { announceLocalAccessPrivacy: say } = Privacy; say("secret", "gate");',
    'native.announce("secret", 0, true);',
  ])('rejects an unclassified producer: %s', fixture => {
    expect(() => {
      assertClassified('unclassified.tsx', fixture);
    }).toThrow('Unclassified announcement producer');
  });

  it.each([
    'AccessibilityInfo.announceForAccessibility("secret");',
    'announceForA11y("extra");',
    'announceLocalAccessPrivacy("secret", "gate");',
  ])('rejects an extra producer in an already classified file: %s', extra => {
    const file = 'components/agents/session-message-list.tsx';
    const current = readFileSync(resolve('src', file), 'utf8');
    expect(() => {
      assertClassified(file, `${current}\n${extra}`);
    }).toThrow('Unclassified announcement producer');
  });

  it.each([
    'announceLocalAccessPrivacy("secret", "gate");',
    'import { announceLocalAccessPrivacy as say } from "@/lib/local-access-privacy"; say("secret", "gate");',
    'announceLocalAccessPrivacy.call(null, "secret", "gate");',
  ])('rejects a protected helper changed to explicit native-kind delivery: %s', fixture => {
    expect(() => {
      assertClassified('lib/a11y/announce.ts', fixture);
    }).toThrow('Unclassified announcement producer');
  });

  it('ignores comments and unrelated accessibility methods', () => {
    assertClassified(
      'unclassified.tsx',
      '// AccessibilityInfo.announceForAccessibility("not executable");\nAccessibilityInfo.setAccessibilityFocus(42);'
    );
  });
});

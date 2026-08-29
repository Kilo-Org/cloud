/* eslint-disable import/no-nodejs-modules, max-depth, jest/no-conditional-in-test -- This Node-only inventory resolves storage aliases and tests forbidden syntax. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return /\.[cm]?[jt]sx?$/u.test(path) && !/\.(?:test|spec|d)\./u.test(path) ? [path] : [];
  });

const inventory = (path: string, text: string): string[] => {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const aliases = new Map<string, ts.Expression | string>();
  const literal = (node: ts.Node): string | undefined =>
    ts.isStringLiteralLike(node) || ts.isIdentifier(node) ? node.text : undefined;
  const name = (node: ts.Expression, seen = new Set<string>()): string => {
    if (ts.isIdentifier(node)) {
      const target = aliases.get(node.text);
      if (target === undefined || seen.has(node.text)) {
        return node.text;
      }
      return typeof target === 'string' ? target : name(target, new Set([...seen, node.text]));
    }
    if (ts.isPropertyAccessExpression(node)) {
      return `${name(node.expression, seen)}.${node.name.text}`;
    }
    if (ts.isElementAccessExpression(node)) {
      const property = node.argumentExpression;
      const target = ts.isIdentifier(property) ? aliases.get(property.text) : property;
      const key =
        target !== undefined && typeof target !== 'string' && ts.isStringLiteralLike(target)
          ? target.text
          : '*';
      return `${name(node.expression, seen)}.${key}`;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return name(node.expression, seen);
    }
    if (ts.isCallExpression(node) && name(node.expression, seen).endsWith('.bind')) {
      return name(node.expression, seen).slice(0, -5);
    }
    return '';
  };
  const bind = (binding: ts.BindingName, target: ts.Expression | string): void => {
    if (ts.isIdentifier(binding)) {
      aliases.set(binding.text, target);
    } else if (ts.isObjectBindingPattern(binding)) {
      for (const element of binding.elements) {
        const base = typeof target === 'string' ? target : name(target);
        bind(element.name, `${base}.${literal(element.propertyName ?? element.name) ?? '*'}`);
      }
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          aliases.set(element.name.text, imported);
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        aliases.set(bindings.name.text, module.includes('storage') ? 'wxt' : 'imports');
      }
      if (node.importClause?.name !== undefined && /browser|webextension-polyfill/u.test(module)) {
        aliases.set(node.importClause.name.text, 'browser');
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      bind(node.name, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      aliases.set(node.left.text, node.right);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const failures = new Set<string>();
  const report = (node: ts.Node): void => {
    failures.add(
      `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: unprotected local-storage clear`
    );
  };
  const inspect = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const resolved = name(node);
      // Reject extracting the method too; calling an alias cannot bypass the boundary.
      if (
        /(?:^|\.)(?:browser|chrome)\.storage\.(?:local|\*)\.(?:clear|\*)$/u.test(resolved) ||
        /(?:^|\.)storage\.(?:local|\*)\.(?:clear|\*)$/u.test(resolved)
      ) {
        report(node);
      }
    }
    if (ts.isCallExpression(node)) {
      const resolved = name(node.expression);
      const [argument] = node.arguments;
      const target =
        argument !== undefined && ts.isIdentifier(argument) ? aliases.get(argument.text) : argument;
      const area =
        target !== undefined && typeof target !== 'string' && ts.isStringLiteralLike(target)
          ? target.text
          : undefined;
      // Any clear('local') is forbidden, including a parameter alias or a future storage wrapper.
      if (
        /(?:^|\.)clear(?:\.call|\.apply)?$/u.test(resolved) &&
        !/\.storage\.(?:sync|session|managed)\.clear$/u.test(resolved) &&
        area !== 'sync' &&
        area !== 'session' &&
        area !== 'managed' &&
        (area === 'local' || /(?:^|\.)storage\./u.test(resolved))
      ) {
        report(node);
      }
      if (/(?:^|\.)(?:storage|storage\.local)\.\*$/u.test(resolved)) {
        report(node);
      }
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const resolved = name(node.name);
      if (/(?:^|\.)storage\.local\.clear$/u.test(resolved)) {
        report(node);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return [...failures];
};

const forbidden = [
  'browser.storage.local.clear()',
  'chrome.storage.local["clear"]()',
  'import { browser as api } from "#imports"; api.storage.local.clear()',
  'import { storage as saved } from "#imports"; saved.clear("local")',
  'import { storage as saved } from "wxt/utils/storage"; const wipe = saved.clear.bind(saved); wipe("local")',
  'import { storage as saved } from "@wxt-dev/storage"; saved["clear"]("local")',
  'import * as kit from "#imports"; kit.browser.storage.local.clear()',
  'import browserApi from "webextension-polyfill"; browserApi.storage.local.clear()',
  'const area = browser.storage.local; area.clear()',
  'const { local: area } = browser.storage; const { clear: wipe } = area; wipe()',
  'const wipe = browser.storage.local.clear; wipe()',
  'const key = "clear"; browser.storage.local[key]()',
  'browser.storage.local[unknownMethod]()',
  'storage[unknownMethod]("local")',
  'const area = "local"; storage.clear(area)',
  'storage.clear(unknownArea)',
  'storageArea.clear("local")',
  'import { storage as saved } from "#imports"; const { clear: wipe } = saved; wipe("local")',
  'const local = "local"; browser.storage[local].clear()',
  'const clearMethod = "clear"; storage[clearMethod]("local")',
];

describe('auth storage safety boundary', () => {
  it('reports every production clear site across extension sources', () => {
    const files = [...sources(join(root, 'entrypoints')), ...sources(join(root, 'src'))];
    const failures = files.flatMap(path =>
      inventory(relative(root, path), readFileSync(path, 'utf8'))
    );
    expect(failures).toStrictEqual([]);
  });

  it.each(forbidden)('rejects the mutation: %s', text => {
    expect(inventory('mutation.ts', text)).toStrictEqual(
      expect.arrayContaining([
        expect.stringMatching(/^mutation\.ts:\d+: unprotected local-storage clear$/u),
      ])
    );
  });

  it.each([
    'await storage.removeItems(["local:kiloAuth"]);',
    'await storage.snapshot("local");',
    'browser.storage.sync.clear();',
    'storage.clear("session");',
    'const text = "browser.storage.local.clear()";',
  ])('permits nondestructive or nonlocal storage operations: %s', text => {
    expect(inventory('allowed.ts', text)).toStrictEqual([]);
  });
});

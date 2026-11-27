#!/usr/bin/env node
/**
 * Which organization-write audit actions a web route handler can record.
 *
 * A Kilo admin's organization write through the admin bypass is recorded only
 * when the handler runs it inside `runElevatedOrganizationWrite`. The privileged
 * inventory lists, for every route behind an organization guard, the actions
 * its handler records that way; this script answers whether the handler still
 * reaches the wrapper with each of them, so dropping the wrapper from a route,
 * or from a callback module a platform dispatcher loads, fails the inventory
 * test instead of silently ending the audit.
 *
 * From a handler it follows every function, constant and class the code refers
 * to, through named imports and re-exports of the web and web-shared sources
 * and through `(await import('…')).member` loads, and collects the literal
 * `action` of each wrapper call it reaches. A helper that hands its caller's
 * action on to the wrapper is resolved at its call sites: the `action` values
 * those calls pass count as recorded. The walk over-approximates (a name is
 * followed wherever it appears), so it can say a route records an action it
 * no longer reaches only when the same action is recorded by other code the
 * route refers to.
 *
 * Usage: elevated-write-reachability.mjs <file> <export> [<file> <export> ...]
 * Prints a JSON array with the actions of each handler, in argument order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSourceFile, propertyName, stringLiteralValue } from '../lib/ast.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const AUDIT_MODULE_FILE = path.join(
  REPO_ROOT,
  'packages/web-shared/src/lib/admin/admin-action-audit.ts'
);
const ELEVATED_WRITE = 'runElevatedOrganizationWrite';
const SOURCE_MODULE_PREFIXES = [
  ['@/', path.join(REPO_ROOT, 'apps/web/src')],
  ['@kilocode/web-shared/', path.join(REPO_ROOT, 'packages/web-shared/src')],
];

/** The nodes directly below `node`. */
function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
        children.push(child);
      }
    }
  }
  return children;
}

function someNode(node, predicate) {
  return predicate(node) || childNodes(node).some(child => someNode(child, predicate));
}

function exportedName(name) {
  return name.type === 'Literal' ? name.value : name.name;
}

/** The file of a web or web-shared source module, or null for any other module. */
function resolveSourceModule(specifier, fromFile) {
  let base = specifier.startsWith('.') ? path.resolve(path.dirname(fromFile), specifier) : null;
  for (const [prefix, root] of SOURCE_MODULE_PREFIXES) {
    if (specifier.startsWith(prefix)) base = path.join(root, specifier.slice(prefix.length));
  }
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * One module's top-level declarations by name, and the names it imports or
 * re-exports from another source module, as `{ file, name }`.
 */
const parsedModules = new Map();

function parseModule(file) {
  const cached = parsedModules.get(file);
  if (cached) return cached;
  const { program, errors } = parseSourceFile(file, fs.readFileSync(file, 'utf8'));
  // A file that does not parse has an empty program, which would hide its calls.
  if (errors.length > 0) throw new Error(`${file}: cannot parse: ${errors[0].message}`);
  const parsed = { declarations: new Map(), imports: new Map() };
  const bindImport = (local, specifier, exported) => {
    const target = resolveSourceModule(specifier, file);
    if (target) parsed.imports.set(local, { file: target, name: exported });
  };
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          bindImport(
            specifier.local.name,
            statement.source.value,
            exportedName(specifier.imported)
          );
        }
      }
      continue;
    }
    if (statement.type === 'ExportNamedDeclaration' && statement.source) {
      for (const specifier of statement.specifiers) {
        bindImport(
          exportedName(specifier.exported),
          statement.source.value,
          exportedName(specifier.local)
        );
      }
      continue;
    }
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
      if (declaration.id) parsed.declarations.set(declaration.id.name, declaration);
    } else if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier') {
          parsed.declarations.set(declarator.id.name, declarator);
        }
      }
    }
  }
  parsedModules.set(file, parsed);
  return parsed;
}

/** What a name used in `file` refers to: one of its declarations or an import. */
function resolveName(file, name) {
  const parsed = parseModule(file);
  return parsed.declarations.has(name) ? { file, name } : (parsed.imports.get(name) ?? null);
}

/** The module an `(await import('…')).member` access loads, when it is a source module. */
function dynamicImportTarget(object, fromFile) {
  let inner = object;
  while (inner.type === 'ParenthesizedExpression' || inner.type === 'AwaitExpression') {
    inner = inner.type === 'AwaitExpression' ? inner.argument : inner.expression;
  }
  if (inner.type !== 'ImportExpression') return null;
  const specifier = stringLiteralValue(inner.source);
  return specifier === null ? null : resolveSourceModule(specifier, fromFile);
}

function isElevatedWriteCall(node, file) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return false;
  const callee = resolveName(file, node.callee.name);
  return callee?.file === AUDIT_MODULE_FILE && callee.name === ELEVATED_WRITE;
}

/** The literal `action` property of an object literal, or null. */
function actionProperty(node) {
  if (node?.type !== 'ObjectExpression') return null;
  const property = node.properties.find(candidate => propertyName(candidate) === 'action');
  return property ? stringLiteralValue(property.value) : null;
}

const elevatedWriteForwarders = new Map();

/** Whether a declaration passes an action it was given on to the wrapper. */
function forwardsElevatedWriteAction(symbol) {
  const key = `${symbol.file}#${symbol.name}`;
  if (!elevatedWriteForwarders.has(key)) {
    const declaration = parseModule(symbol.file).declarations.get(symbol.name);
    elevatedWriteForwarders.set(
      key,
      declaration !== undefined &&
        someNode(
          declaration,
          node =>
            isElevatedWriteCall(node, symbol.file) && actionProperty(node.arguments[1]) === null
        )
    );
  }
  return elevatedWriteForwarders.get(key);
}

/** The actions the handler `name` of `file` can record through the wrapper. */
function elevatedWriteActionsReachableFrom(file, name) {
  const actions = new Set();
  const visited = new Set();
  const pending = [{ file, name }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const key = `${next.file}#${next.name}`;
    if (visited.has(key) || next.file === AUDIT_MODULE_FILE) continue;
    visited.add(key);
    const moduleFile = next.file;
    const parsed = parseModule(moduleFile);
    const declaration = parsed.declarations.get(next.name);
    if (!declaration) {
      const reexported = parsed.imports.get(next.name);
      if (reexported) pending.push(reexported);
      continue;
    }
    const visit = node => {
      if (isElevatedWriteCall(node, moduleFile)) {
        const action = actionProperty(node.arguments[1]);
        if (action !== null) actions.add(action);
      } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const callee = resolveName(moduleFile, node.callee.name);
        if (callee && forwardsElevatedWriteAction(callee)) {
          for (const argument of node.arguments) {
            const action = actionProperty(argument);
            if (action !== null) actions.add(action);
          }
        }
      }
      if (node.type === 'Identifier') {
        const referenced = resolveName(moduleFile, node.name);
        if (referenced) pending.push(referenced);
      } else if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
        const imported = dynamicImportTarget(node.object, moduleFile);
        if (imported) pending.push({ file: imported, name: node.property.name });
      }
      for (const child of childNodes(node)) visit(child);
    };
    visit(declaration);
  }
  return [...actions].sort();
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('usage: elevated-write-reachability.mjs <file> <export> [<file> <export> ...]');
  process.exit(2);
}
const results = [];
for (let index = 0; index < args.length; index += 2) {
  results.push(elevatedWriteActionsReachableFrom(path.resolve(args[index]), args[index + 1]));
}
console.log(JSON.stringify(results));

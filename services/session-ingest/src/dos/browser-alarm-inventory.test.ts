import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type AlarmSite = { member: string; operation: string; kind: 'write' | 'alias'; line: number };

/** Conservatively track writer aliases inside this class, including aliases stored on this. */
function alarmInventory(text: string): AlarmSite[] {
  const source = ts.createSourceFile('UserConnectionDO.ts', text, ts.ScriptTarget.Latest, true);
  const target = source.statements.find(
    node => ts.isClassDeclaration(node) && node.name?.text === 'UserConnectionDO'
  );
  if (!target || !ts.isClassDeclaration(target)) throw new Error('UserConnectionDO is missing');
  const aliases = new Map<string, string>();
  const names = new Map<string, string>();
  const nodes: { node: ts.Node; member: string }[] = [];
  for (const member of target.members) {
    const name = member.name?.getText(source) ?? 'constructor';
    const visit = (node: ts.Node) => {
      // Other Durable Object classes do not belong to this inventory.
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
      nodes.push({ node, member: name });
      ts.forEachChild(node, visit);
    };
    visit(member);
  }

  function property(node: ts.Node | undefined): string | undefined {
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return names.get(node.text) ?? node.text;
    if (ts.isStringLiteralLike(node)) return node.text;
    return undefined;
  }

  function writer(node: ts.Expression): string | undefined {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return writer(node.expression);
    }
    const alias = aliases.get(node.getText(source));
    if (alias) return alias;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = property(
        ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
      );
      if (name === 'setAlarm' || name === 'deleteAlarm') return name;
      if (name === 'bind' || name === 'call' || name === 'apply') return writer(node.expression);
    }
    if (ts.isCallExpression(node)) return writer(node.expression);
    return undefined;
  }

  // A fixed point also catches assignment chains and references before declarations.
  let changed = true;
  while (changed) {
    const size = aliases.size + names.size;
    for (const { node } of nodes) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          if (ts.isStringLiteralLike(node.initializer))
            names.set(node.name.text, node.initializer.text);
          const operation = writer(node.initializer);
          if (operation) aliases.set(node.name.text, operation);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const operation = property(element.propertyName ?? element.name);
            if (operation === 'setAlarm' || operation === 'deleteAlarm') {
              aliases.set(element.name.getText(source), operation);
            }
          }
        }
      }
      if (ts.isPropertyDeclaration(node) && node.initializer) {
        const operation = writer(node.initializer);
        if (operation) aliases.set(`this.${node.name.getText(source)}`, operation);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const operation = writer(node.right);
        if (operation) aliases.set(node.left.getText(source), operation);
      }
    }
    changed = aliases.size + names.size !== size;
  }

  const sites: AlarmSite[] = [];
  for (const { node, member } of nodes) {
    let operation: string | undefined;
    let kind: AlarmSite['kind'] = 'alias';
    if (ts.isCallExpression(node)) {
      operation = writer(node.expression);
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isElementAccessExpression(node.expression)
          ? property(node.expression.argumentExpression)
          : undefined;
      if (name !== 'bind') kind = 'write';
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      operation = writer(node);
    } else if (ts.isBindingElement(node)) {
      operation = aliases.get(node.name.getText(source));
    }
    if (operation) {
      sites.push({
        member,
        operation,
        kind,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
  }
  return sites;
}

function checkAlarmOwnership(source: string): void {
  const sites = alarmInventory(source);
  const competing = sites.filter(site => site.member !== 'scheduleNextAlarm');
  if (competing.length || !sites.some(site => site.kind === 'write')) {
    throw new Error(
      `Competing or missing UserConnectionDO alarm writer: ${JSON.stringify(competing)}`
    );
  }
}

const composed =
  'scheduleNextAlarm() { this.ctx.storage.setAlarm(100); this.ctx.storage.deleteAlarm(); }';

describe('UserConnectionDO alarm ownership', () => {
  it('allows only the composed scheduler in the actual relay source', () => {
    checkAlarmOwnership(readFileSync(new URL('./UserConnectionDO.ts', import.meta.url), 'utf8'));
  });

  it.each([
    ['direct write', 'competing() { this.ctx.storage.setAlarm(1); }'],
    ['direct deletion', 'competing() { this.ctx.storage.deleteAlarm(); }'],
    ['receiver alias', 'competing() { const storage = this.ctx.storage; storage.setAlarm(1); }'],
    ['method alias', 'competing() { const write = this.ctx.storage.setAlarm; write(1); }'],
    [
      'destructured alias',
      'competing() { const { setAlarm: write } = this.ctx.storage; write(1); }',
    ],
    [
      'bound alias',
      'competing() { const write = this.ctx.storage.setAlarm.bind(this.ctx.storage); write(1); }',
    ],
    ['computed write', 'competing() { this.ctx.storage["setAlarm"](1); }'],
    ['computed key alias', 'competing() { const key = "setAlarm"; this.ctx.storage[key](1); }'],
    [
      'call alias',
      'competing() { const write = this.ctx.storage.setAlarm; write.call(this.ctx.storage, 1); }',
    ],
  ])('rejects a synthetic %s outside the scheduler', (_name, competing) => {
    expect(() =>
      checkAlarmOwnership(`class UserConnectionDO { ${composed} ${competing} }`)
    ).toThrow(/competing/);
  });

  it('rejects a writer stored inside the scheduler and invoked elsewhere', () => {
    expect(() =>
      checkAlarmOwnership(`class UserConnectionDO {
      scheduleNextAlarm() { this.write = this.ctx.storage.setAlarm.bind(this.ctx.storage); this.write(1); }
      competing() { const again = this.write; again(2); }
    }`)
    ).toThrow(/competing/);
  });

  it('rejects a missing target class instead of silently inspecting another Durable Object', () => {
    expect(() => checkAlarmOwnership(`class SessionIngestDO { ${composed} }`)).toThrow(/missing/);
  });

  it('rejects an empty scheduler inventory', () => {
    expect(() => checkAlarmOwnership('class UserConnectionDO { scheduleNextAlarm() {} }')).toThrow(
      /missing/
    );
  });

  it('excludes other Durable Object classes and unrelated similarly named text', () => {
    checkAlarmOwnership(`
      class SessionIngestDO { alarm() { this.ctx.storage.setAlarm(1); } }
      class UserConnectionDO { ${composed} note() { return 'storage.setAlarm(1)'; } }
      class SessionAccessCacheDO { alarm() { const { setAlarm: write } = this.ctx.storage; write(1); } }
    `);
  });
});

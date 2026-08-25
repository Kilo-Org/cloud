import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineRule, eslintCompatPlugin } from '@oxlint/plugins';

import type { ESTree } from '@oxlint/plugins';

/**
 * Copy props that must carry a translated string. A literal, template, or
 * concatenation in one of these positions is a leftover literal.
 */
const COPY_PROPS = new Set([
  'accessibilityHint',
  'accessibilityLabel',
  'actionLabel',
  'alt',
  'cancelLabel',
  'caption',
  'confirmLabel',
  'description',
  'doneLabel',
  'emptyDescription',
  'emptyTitle',
  'errorText',
  'headerTitle',
  'heading',
  'helperText',
  'hint',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'tabBarLabel',
  'text',
  'title',
]);

/**
 * Object keys that are unmistakably UI copy, e.g. an Alert button's `text` or
 * a card state's `actionLabel`. Deliberately narrower than `COPY_PROPS`:
 * `title`, `message`, and `description` also name fields on errors, tRPC
 * payloads, and analytics events, so flagging them on any object literal buries
 * the real findings.
 */
const OBJECT_COPY_PROPS = new Set([
  'accessibilityHint',
  'accessibilityLabel',
  'actionLabel',
  'cancelLabel',
  'confirmLabel',
  'doneLabel',
  'emptyDescription',
  'emptyTitle',
  'errorText',
  'headerTitle',
  'helperText',
  'placeholder',
  'tabBarLabel',
]);

const URL_PATTERN = /^(https?:\/\/|mailto:|tel:)/i;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// A catalog key, e.g. 'kiloPass.manage'. These reach a copy prop through t(),
// and a lookup table of keys is a normal shape, so a dotted identifier is not
// copy. A single word is NOT matched on purpose: `title="settings"` and
// `accessibilityLabel="hello"` are copy, and an earlier testID-shaped pattern
// waved both through.
const CATALOG_KEY_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;

const allowlistPath = fileURLToPath(new URL('./allowlist.json', import.meta.url));
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
  files?: string[];
  values?: string[];
  constants?: string[];
};
const allowedFiles = new Set(allowlist.files ?? []);
const allowedValues = new Set(allowlist.values ?? []);
// Constants that are a brand name, an acronym, a number, or a URL — not copy.
// Named one by one on purpose: the list is the review record for every
// SCREAMING_SNAKE value the app renders without translating it.
const allowedConstants = new Set(allowlist.constants ?? []);

function hasLetter(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

/**
 * True when the text holds a word, not a stray letter. `v{version}` renders
 * the JSXText "v", which is punctuation for a number, not copy to translate.
 */
function hasWord(value: string): boolean {
  return /[A-Za-z]{2}/.test(value);
}

function isIgnoredValue(value: string): boolean {
  if (allowedValues.has(value)) {
    return true;
  }
  if (URL_PATTERN.test(value)) {
    return true;
  }
  if (HEX_COLOR_PATTERN.test(value)) {
    return true;
  }
  if (CATALOG_KEY_PATTERN.test(value)) {
    return true;
  }
  return false;
}

function isAllowedFile(filename: string): boolean {
  return allowedFiles.has(filename);
}

/** Extract the static string value of a copy-prop expression, or null. */
function literalValue(node: ESTree.Expression): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral') {
    // Only a no-expression template is a single static string; interpolated
    // templates are still copy but flagged separately.
    if (node.expressions.length === 0) {
      return node.quasis[0]?.value.cooked ?? null;
    }
    return null;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = literalValue(node.left);
    const right = literalValue(node.right);
    if (left !== null && right !== null) {
      return left + right;
    }
  }
  return null;
}

/**
 * A SCREAMING_SNAKE constant in a copy position is copy that never went
 * through the catalog — the shape that let an English Kilo Pass string ship to
 * every locale from `packages/app-shared`. `t()` returns a call, never an
 * identifier, so this costs no false positives on translated copy.
 */
const SHOUTED_CONSTANT_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function isShoutedConstant(node: ESTree.Expression): boolean {
  return (
    node.type === 'Identifier' &&
    SHOUTED_CONSTANT_PATTERN.test(node.name) &&
    !allowedConstants.has(node.name)
  );
}

/** True when the expression is a literal/template/concat that is copy. */
function isCopyExpression(node: ESTree.Expression): boolean {
  if (isShoutedConstant(node)) {
    return true;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return hasLetter(node.value) && !isIgnoredValue(node.value);
  }
  if (node.type === 'TemplateLiteral') {
    return true;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return isCopyExpression(node.left) || isCopyExpression(node.right);
  }
  // `error.message || 'Something went wrong'`: the fallback is the string the
  // user reads whenever the server sends no message, so it is copy.
  if (node.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??')) {
    return isCopyExpression(node.left) || isCopyExpression(node.right);
  }
  // `error ? 'Something went wrong' : ''`: the user reads the branch when the
  // condition holds, so either branch is copy.
  if (node.type === 'ConditionalExpression') {
    return isCopyExpression(node.consequent) || isCopyExpression(node.alternate);
  }
  return false;
}

/** Report a string argument position (Alert.alert, toast helpers). */
function isStringArgument(node: ESTree.Expression | ESTree.SpreadElement): boolean {
  if (node.type === 'SpreadElement') {
    return false;
  }
  return isCopyExpression(node);
}

const noLiteralCopyRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow literal user-facing copy in mobile source; every string must go through the i18n catalog.',
    },
    messages: {
      literalCopy: 'Move this user-facing string into the i18n catalog and render it with t().',
    },
  },
  createOnce(context) {
    return {
      JSXText(node) {
        if (isAllowedFile(context.filename)) {
          return;
        }
        const text = node.value;
        if (!hasWord(text)) {
          return;
        }
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          return;
        }
        if (isIgnoredValue(trimmed)) {
          return;
        }
        context.report({ node, messageId: 'literalCopy' });
      },
      JSXExpressionContainer(node) {
        if (isAllowedFile(context.filename)) {
          return;
        }
        // Only a child container; an attribute value is handled below.
        if (node.parent?.type !== 'JSXElement' && node.parent?.type !== 'JSXFragment') {
          return;
        }
        const expression = node.expression;
        if (expression.type === 'JSXEmptyExpression') {
          return;
        }
        if (isShoutedConstant(expression)) {
          context.report({ node, messageId: 'literalCopy' });
        }
      },
      JSXAttribute(node) {
        if (isAllowedFile(context.filename)) {
          return;
        }
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
        if (name === null || !COPY_PROPS.has(name)) {
          return;
        }
        const value = node.value;
        if (value === null) {
          return;
        }
        if (value.type === 'Literal') {
          if (
            typeof value.value === 'string' &&
            hasLetter(value.value) &&
            !isIgnoredValue(value.value)
          ) {
            context.report({ node, messageId: 'literalCopy' });
          }
          return;
        }
        if (value.type === 'JSXExpressionContainer') {
          const expression = value.expression;
          if (expression.type === 'JSXEmptyExpression') {
            return;
          }
          if (isCopyExpression(expression)) {
            context.report({ node, messageId: 'literalCopy' });
          }
        }
      },
      Property(node) {
        if (isAllowedFile(context.filename)) {
          return;
        }
        if (node.computed || node.kind !== 'init') {
          return;
        }
        const key = node.key;
        const name =
          key.type === 'Identifier'
            ? key.name
            : key.type === 'Literal' && typeof key.value === 'string'
              ? key.value
              : null;
        if (name === null || !OBJECT_COPY_PROPS.has(name)) {
          return;
        }
        const value = node.value;
        if (
          value.type === 'AssignmentPattern' ||
          value.type === 'ArrayPattern' ||
          value.type === 'ObjectPattern' ||
          value.type === 'RestElement'
        ) {
          return;
        }
        if (isCopyExpression(value)) {
          context.report({ node, messageId: 'literalCopy' });
        }
      },
      CallExpression(node) {
        if (isAllowedFile(context.filename)) {
          return;
        }
        if (node.callee.type === 'Super' || node.callee.type === 'V8IntrinsicExpression') {
          return;
        }
        // Non-computed member call obj.method(...). oxlint's ESTree reports
        // static and computed member expressions with type 'MemberExpression';
        // the `computed` flag tells them apart.
        if (node.callee.type === 'MemberExpression' && !node.callee.computed) {
          const object = node.callee.object;
          const property = node.callee.property;
          const objectName = object.type === 'Identifier' ? object.name : null;
          const methodName = property.type === 'Identifier' ? property.name : null;
          // Alert.alert('title', 'message', [...])
          if (objectName === 'Alert' && methodName === 'alert') {
            const first = node.arguments[0];
            const second = node.arguments[1];
            if (first && isStringArgument(first)) {
              context.report({ node, messageId: 'literalCopy' });
            }
            if (second && isStringArgument(second)) {
              context.report({ node, messageId: 'literalCopy' });
            }
            return;
          }
          // toast.error / toast.success / toast.warning / toast.info /
          // toast.message / toast.loading, and the announcingToast alias.
          if (
            (objectName === 'toast' || objectName === 'announcingToast') &&
            methodName !== null &&
            (methodName === 'error' ||
              methodName === 'success' ||
              methodName === 'warning' ||
              methodName === 'info' ||
              methodName === 'message' ||
              methodName === 'loading')
          ) {
            const first = node.arguments[0];
            if (first && isStringArgument(first)) {
              context.report({ node, messageId: 'literalCopy' });
            }
            return;
          }
        }
        // Bare toast('message'), and announceForA11y('message') — a screen
        // reader speaks the argument, so an English literal there ships
        // English to every locale exactly like a visible label does.
        if (
          node.callee.type === 'Identifier' &&
          (node.callee.name === 'toast' || node.callee.name === 'announceForA11y')
        ) {
          const first = node.arguments[0];
          if (first && isStringArgument(first)) {
            context.report({ node, messageId: 'literalCopy' });
          }
        }
      },
    };
  },
});

const noLiteralCopyPlugin = eslintCompatPlugin({
  meta: { name: 'no-literal-copy' },
  rules: {
    'no-literal-copy': noLiteralCopyRule,
  },
});

export default noLiteralCopyPlugin;

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineRule, eslintCompatPlugin } from '@oxlint/plugins';

import type { ESTree } from '@oxlint/plugins';

/**
 * Copy props that must carry a translated string. A literal, template, or
 * concatenation in one of these positions is a leftover literal.
 */
const COPY_PROPS = new Set([
  'title',
  'subtitle',
  'label',
  'placeholder',
  'accessibilityLabel',
  'accessibilityHint',
  'headerTitle',
  'tabBarLabel',
  'text',
  'message',
  'description',
  'doneLabel',
  'emptyTitle',
]);

const URL_PATTERN = /^(https?:\/\/|mailto:|tel:)/i;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// testID-like: lowercase, no spaces, word chars separated by . _ -
const TEST_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const allowlistPath = fileURLToPath(new URL('./allowlist.json', import.meta.url));
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
  files?: string[];
  values?: string[];
};
const allowedFiles = new Set(allowlist.files ?? []);
const allowedValues = new Set(allowlist.values ?? []);

function hasLetter(value: string): boolean {
  return /[A-Za-z]/.test(value);
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
  if (TEST_ID_PATTERN.test(value)) {
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

/** True when the expression is a literal/template/concat that is copy. */
function isCopyExpression(node: ESTree.Expression): boolean {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return hasLetter(node.value) && !isIgnoredValue(node.value);
  }
  if (node.type === 'TemplateLiteral') {
    return true;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return isCopyExpression(node.left) || isCopyExpression(node.right);
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
      literalCopy:
        'Move this user-facing string into the i18n catalog and render it with t().',
    },
  },
  createOnce(context) {
    return {
      JSXText(node) {
        if (isAllowedFile(context.filename)) {
          return;
        }
        const text = node.value;
        if (!hasLetter(text)) {
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
          if (typeof value.value === 'string' && hasLetter(value.value) && !isIgnoredValue(value.value)) {
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
        // Bare toast('message')
        if (node.callee.type === 'Identifier' && node.callee.name === 'toast') {
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

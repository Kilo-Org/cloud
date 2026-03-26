// Oxlint JS plugin: drizzle enforce-delete-with-where / enforce-update-with-where.

function isDrizzleObjName(name, drizzleObjectName) {
  if (typeof drizzleObjectName === 'string') return name === drizzleObjectName;
  if (Array.isArray(drizzleObjectName)) {
    return drizzleObjectName.length === 0 || drizzleObjectName.includes(name);
  }
  return false;
}

function resolveMemberPath(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    const objectPath = resolveMemberPath(node.object);
    return objectPath ? `${objectPath}.${node.property.name}` : null;
  }
  if (node.type === 'ThisExpression') return 'this';
  return null;
}

function isDrizzleObj(node, drizzleObjectName) {
  // Check the object the method is called on (e.g. db in db.delete, ctx.db in ctx.db.delete)
  const objectPath = resolveMemberPath(node.object);
  if (objectPath && isDrizzleObjName(objectPath, drizzleObjectName)) {
    return true;
  }
  // Also check the callee for patterns like getDb().delete(...)
  if (node.object.type === 'CallExpression') {
    const calleePath = resolveMemberPath(node.object.callee);
    if (calleePath && isDrizzleObjName(calleePath, drizzleObjectName)) {
      return true;
    }
  }
  return false;
}

function hasWhereInChain(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'MemberExpression' &&
      current.property.type === 'Identifier' &&
      current.property.name === 'where'
    ) {
      return true;
    }
    if (
      current.type !== 'CallExpression' &&
      current.type !== 'MemberExpression' &&
      current.type !== 'AwaitExpression'
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
}

function resolveMemberExpressionPath(node) {
  let objectExpression = node.object;
  let fullName = '';
  const addToFullName = name => {
    const prefix = fullName ? '.' : '';
    fullName = `${name}${prefix}${fullName}`;
  };
  while (objectExpression) {
    if (objectExpression.type === 'MemberExpression') {
      if (objectExpression.property.type === 'Identifier') {
        addToFullName(objectExpression.property.name);
      }
      objectExpression = objectExpression.object;
    } else if (
      objectExpression.type === 'CallExpression' &&
      objectExpression.callee.type === 'Identifier'
    ) {
      addToFullName(`${objectExpression.callee.name}(...)`);
      break;
    } else if (
      objectExpression.type === 'CallExpression' &&
      objectExpression.callee.type === 'MemberExpression'
    ) {
      if (objectExpression.callee.property.type === 'Identifier') {
        addToFullName(`${objectExpression.callee.property.name}(...)`);
      }
      objectExpression = objectExpression.callee.object;
    } else if (objectExpression.type === 'Identifier') {
      addToFullName(objectExpression.name);
      break;
    } else if (objectExpression.type === 'ThisExpression') {
      addToFullName('this');
      break;
    } else {
      break;
    }
  }
  return fullName;
}

function createRule(method, messageId) {
  return {
    meta: {
      type: 'problem',
      messages: {
        [messageId]: `Without \`.where(...)\` you will ${method} all the rows in a table. Use \`{{ drizzleObjName }}.${method}(...).where(...)\` instead.`,
      },
      schema: [
        {
          type: 'object',
          properties: {
            drizzleObjectName: { type: ['string', 'array'] },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const drizzleObjectName = (context.options[0] && context.options[0].drizzleObjectName) || [];
      return {
        MemberExpression(node) {
          if (
            node.property.type === 'Identifier' &&
            node.property.name === method &&
            isDrizzleObj(node, drizzleObjectName) &&
            !hasWhereInChain(node)
          ) {
            context.report({
              node,
              messageId,
              data: { drizzleObjName: resolveMemberExpressionPath(node) },
            });
          }
        },
      };
    },
  };
}

module.exports = {
  rules: {
    'enforce-delete-with-where': createRule('delete', 'enforceDeleteWithWhere'),
    'enforce-update-with-where': createRule('update', 'enforceUpdateWithWhere'),
  },
};

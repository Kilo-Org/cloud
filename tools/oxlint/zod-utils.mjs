// Runs eslint-plugin-zod-utils under oxlint. The rule's type-aware check is
// optional (it branches on `parserServices.program`), but its
// `getParserServices(context, true)` call throws unless parserServices
// carries the tseslint node maps, which oxlint never provides. Handing it a
// stub with `program: null` lands it on its syntactic path.
import zodUtils from 'eslint-plugin-zod-utils';

const stubParserServices = {
  program: null,
  esTreeNodeToTSNodeMap: new WeakMap(),
  tsNodeToESTreeNodeMap: new WeakMap(),
};

function withStubParserServices(context) {
  if (context.sourceCode.parserServices?.esTreeNodeToTSNodeMap != null) {
    return context;
  }
  const sourceCode = Object.create(context.sourceCode, {
    parserServices: { value: stubParserServices },
  });
  return Object.create(context, { sourceCode: { value: sourceCode } });
}

export default {
  meta: { name: 'zod-utils' },
  rules: Object.fromEntries(
    Object.entries(zodUtils.rules).map(([name, rule]) => [
      name,
      { ...rule, create: context => rule.create(withStubParserServices(context)) },
    ])
  ),
};

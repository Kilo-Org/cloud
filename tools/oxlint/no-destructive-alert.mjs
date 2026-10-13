// A destructive confirmation must not go through the native `Alert.alert`: on
// Android the AppCompat alert paints EVERY button with the theme accent, so
// `style: 'destructive'` never reaches the screen. Use the app's own dialog
// (`useConfirmDialog` from `@/components/ui/dialog`), which carries the red
// affordance on both platforms.
//
// The 45 non-destructive `Alert.alert` confirms stay: the native alert is the
// cheapest correct dialog for a plain "are you ok with this", and it is the one
// implementation the Android theme overlay (`plugins/withAndroidAlertDialogTheme.js`)
// keeps on the app tokens.
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid a destructive-style Alert.alert button.' },
    messages: {
      destructive:
        'Use the in-app dialog (`useConfirmDialog` from @/components/ui/dialog): ' +
        'Android drops `style: "destructive"`.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const isAlertAlert =
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Alert' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'alert';
        if (!isAlertAlert) return;
        const destructive = node.arguments.some(
          arg =>
            arg.type === 'ArrayExpression' &&
            arg.elements.some(
              el =>
                el?.type === 'ObjectExpression' &&
                el.properties.some(
                  p =>
                    p.type === 'Property' &&
                    p.key?.name === 'style' &&
                    p.value?.type === 'Literal' &&
                    p.value.value === 'destructive'
                )
            )
        );
        if (destructive) context.report({ node, messageId: 'destructive' });
      },
    };
  },
};

export default {
  meta: { name: 'no-destructive-alert' },
  rules: { 'no-destructive-alert': rule },
};

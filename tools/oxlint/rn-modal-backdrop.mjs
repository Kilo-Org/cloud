// A react-native `Modal` paints its container `white`. On Android the Modal
// unmounts its children before the dismiss animation ends, so an opaque Modal
// shows a white flash on close. Every Modal must set `transparent` or a themed
// `backdropColor`.
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Require `transparent` or `backdropColor` on a react-native Modal.' },
    messages: {
      missingBackdrop:
        'Set `backdropColor={colors.background}` (or `transparent`) on this Modal. ' +
        'The default white container flashes on Android when the sheet closes.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'Modal') return;
        const hasBackdrop = node.attributes.some(
          attr =>
            attr.type === 'JSXAttribute' &&
            (attr.name.name === 'transparent' || attr.name.name === 'backdropColor')
        );
        if (!hasBackdrop) context.report({ node, messageId: 'missingBackdrop' });
      },
    };
  },
};

export default {
  meta: { name: 'rn-modal-backdrop' },
  rules: { 'require-backdrop': rule },
};

// Node readers for the review-memory proposal sheet's mounted suite. Every one
// takes a rendered node and returns what its component contract promises; the
// mocks and the fixtures stay in the test file, because `vi.mock` is hoisted per
// file and `h` is that file's hoisted state.
import { i18n } from '@/i18n';
import { type ReactTestInstance } from '@/test/renderer';

/** Every host element of one type in the rendered tree. */
export function hosts(root: ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The step a refusal offers, matched by the label it announces. */
export function billingStep(root: ReactTestInstance) {
  return hosts(root, 'Pressable').find(
    node => node.props.accessibilityLabel === i18n.t('organization.hub.manageBilling')
  );
}

/** The sentence the refusal renders. */
export function statusMessage(root: ReactTestInstance): string | null {
  const status = hosts(root, 'AccessibleStatus')[0];
  if (!status) {
    throw new Error('Missing AccessibleStatus');
  }
  return (status.props as { message: string | null }).message;
}

/** The presented sheet's own node: its `visible` and its dismissal report. */
export function sheet(root: ReactTestInstance) {
  const node = hosts(root, 'SessionPageSheet')[0];
  if (!node) {
    throw new Error('Missing SessionPageSheet');
  }
  return node;
}

/** A host prop as the callback its component contract promises. */
export function pressHandler(node: ReactTestInstance): () => void {
  const onPress = node.props.onPress as (() => void) | undefined;
  if (onPress === undefined) {
    throw new Error('Missing press handler');
  }
  return onPress;
}

export function changeHandler(node: ReactTestInstance): (text: string) => void {
  const onChangeText = node.props.onChangeText as ((text: string) => void) | undefined;
  if (onChangeText === undefined) {
    throw new Error('Missing change handler');
  }
  return onChangeText;
}

export function dismissHandler(node: ReactTestInstance): () => void {
  const onDismiss = node.props.onDismiss as (() => void) | undefined;
  if (onDismiss === undefined) {
    throw new Error('Missing dismissal report');
  }
  return onDismiss;
}

/** The header's Done control as the callback its contract promises. */
export function doneHandler(node: ReactTestInstance): () => void {
  const onDone = node.props.onDone as (() => void) | undefined;
  if (onDone === undefined) {
    throw new Error('Missing done handler');
  }
  return onDone;
}

import { createElement, useState } from 'react';

import { act, type ReactTestInstance } from '@/test/renderer';

/**
 * Shared harness for the MCP server sheet mounted tests. The `vi.mock` calls
 * stay in each test file (they must be hoisted per file); everything that does
 * not depend on the hoisted mock state lives here so no mounted test file grows
 * past the lint line budget.
 */

/**
 * The `FormField` stub models the uncontrolled native input inside the real
 * field: it takes its text from `defaultValue` when it mounts and changes it
 * only through `onChangeText`. A field that React reuses across a prop change
 * therefore keeps the text that was typed into the branch it replaced, which is
 * what the server-type suite checks.
 */
export function McpFormFieldStub(props: {
  label: string;
  defaultValue?: string;
  onChangeText?: (text: string) => void;
}) {
  const [text, setText] = useState(props.defaultValue ?? '');
  return createElement('FormField', {
    ...props,
    text,
    onChangeText: (next: string) => {
      setText(next);
      props.onChangeText?.(next);
    },
  });
}

/** A host stub keeps the component's own props untyped; these suites call one handler each. */
export function voidHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => void;
}

/** The sheet's dismissal request answers whether it may close. */
export function booleanHandler(value: unknown): () => boolean {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => boolean;
}

/** A field stub's onChangeText arrives untyped from the host element. */
export function textHandler(value: unknown): (text: string) => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a text handler');
  }
  return value as (text: string) => void;
}

export function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

export function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

export function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

/** The text the field's input shows: what the person reads on screen. */
export function fieldText(root: ReactTestInstance, label: string): unknown {
  return findField(root, label).props.text;
}

export function changeText(root: ReactTestInstance, label: string, value: string): void {
  const onChangeText = textHandler(findField(root, label).props.onChangeText);
  act(() => {
    onChangeText(value);
  });
}

export function pressCancel(root: ReactTestInstance): void {
  const onCancel = voidHandler(findOne(root, 'SheetHeader').props.onCancel);
  act(() => {
    onCancel();
  });
}

export function pressDone(root: ReactTestInstance): void {
  const onDone = voidHandler(findOne(root, 'SheetHeader').props.onDone);
  act(() => {
    onDone();
  });
}

/** A field stub's inline error, read from the renderer's untyped props. */
export function fieldError(root: ReactTestInstance, label: string): unknown {
  return findAll(root, 'FormField').find(node => node.props.label === label)?.props.error;
}

/** Register a field block's offset the way the scroll view reports it after layout. */
export function layoutField(root: ReactTestInstance, label: string, y: number): void {
  const field = findField(root, label);
  // The block's layout is on the field itself, or on the view that wraps the
  // field when it has no `containerOnLayout` of its own.
  const handler: unknown = field.props.containerOnLayout ?? ancestorLayout(field);
  if (typeof handler !== 'function') {
    throw new TypeError(`field ${label} has no layout handler`);
  }
  act(() => {
    (handler as (event: { nativeEvent: { layout: { y: number } } }) => void)({
      nativeEvent: { layout: { y } },
    });
  });
}

function ancestorLayout(field: ReactTestInstance): unknown {
  for (let node = field.parent; node !== null; node = node.parent) {
    if (typeof node.props.onLayout === 'function') {
      return node.props.onLayout;
    }
  }
  return undefined;
}

/** Press one side of the server-type control. */
export function chooseType(root: ReactTestInstance, value: 'local' | 'remote'): void {
  const onChange = textHandler(findOne(root, 'SegmentedControl').props.onChange);
  act(() => {
    onChange(value);
  });
}

import { type ComponentPropsWithRef, createElement, useImperativeHandle } from 'react';
import { type TextInput } from 'react-native';
import { vi } from 'vitest';

export function MockTextInput({ ref, ...props }: ComponentPropsWithRef<typeof TextInput>) {
  useImperativeHandle(ref, () => {
    const handle: Partial<TextInput> = { focus: vi.fn<() => void>(), clear: vi.fn<() => void>() };
    return handle as TextInput;
  }, []);
  return createElement('TextInput', props);
}

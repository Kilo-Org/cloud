import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { EmailOtpForm } from './email-otp-form';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

describe('EmailOtpForm', () => {
  const baseProps = {
    email: 'user@example.com',
    busy: undefined as ReturnType<
      typeof import('@/lib/auth/use-native-auth').useNativeAuth
    >['busy'],
    onVerify: vi.fn(),
    onResend: vi.fn(),
    onBack: vi.fn(),
  };

  it('shows the eligibility line', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(createElement(EmailOtpForm, baseProps));
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const texts = renderer.root.findAll(
      node => typeof node.type === 'string' && node.type === ('Text' as string)
    );

    const eligibilityText = texts.find(
      t => typeof t.props.children === 'string' && t.props.children.includes('eligible')
    );

    expect(eligibilityText).toBeDefined();
    expect(eligibilityText!.props.children).toBe(
      'If this address is eligible, the code arrives within a minute.'
    );

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});

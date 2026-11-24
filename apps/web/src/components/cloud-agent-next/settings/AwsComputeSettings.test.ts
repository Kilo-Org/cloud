import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from 'react-dom/server';
import type { AwsComputeSettings as AwsComputeSettingsComponent } from './AwsComputeSettings';

const mockAccess = jest.fn();
const mockData = jest.fn();
jest.mock('@/hooks/useAwsComputeAccess', () => ({ useAwsComputeAccess: () => mockAccess() }));
jest.mock('@/hooks/useAwsComputeData', () => ({ useAwsComputeData: () => mockData() }));

const { AwsComputeSettings } = jest.requireActual<{
  AwsComputeSettings: typeof AwsComputeSettingsComponent;
}>('./AwsComputeSettings');

beforeEach(() => {
  mockAccess.mockReturnValue(true);
  const mutation = { submittedAt: 0, isPending: false, error: null };
  mockData.mockReturnValue({
    enrollment: { isSuccess: true, data: { enrolled: false, available: false } },
    status: { isSuccess: true, data: null },
    prepare: mutation,
    instructions: mutation,
    validate: mutation,
    discard: mutation,
  });
});

describe('AWS compute settings', () => {
  it('describes ECS without a provider choice and explains an unenrolled owner', () => {
    const markup = renderToStaticMarkup(createElement(AwsComputeSettings));
    expect(markup).toContain('isolated ECS tasks');
    expect(markup).not.toContain('AWS provider');
    expect(markup).not.toContain('MicroVM');
    expect(markup).toContain('AWS compute is not enabled. Contact Kilo.');
    expect(markup).not.toContain('This connection remains saved.');
  });

  it('hides the card without access or a saved configuration', () => {
    mockAccess.mockReturnValue(false);
    expect(renderToStaticMarkup(createElement(AwsComputeSettings))).toBe('');
  });
});

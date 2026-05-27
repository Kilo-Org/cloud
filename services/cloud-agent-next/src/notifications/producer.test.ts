import { describe, expect, it } from 'vitest';

import { buildCloudAgentPushBody, truncatePushSnippet } from './producer.js';

describe('push notification body helpers', () => {
  it('uses completed snippet or fallback', () => {
    expect(buildCloudAgentPushBody('completed', ' Done ')).toBe('Done');
    expect(buildCloudAgentPushBody('completed', undefined)).toBe('Task completed');
  });

  it('prefixes failed and interrupted bodies with fallbacks', () => {
    expect(buildCloudAgentPushBody('failed', 'bad')).toBe('Failed: bad');
    expect(buildCloudAgentPushBody('failed', undefined, 'boom')).toBe('Failed: boom');
    expect(buildCloudAgentPushBody('failed', undefined)).toBe('Failed: Task failed');
    expect(buildCloudAgentPushBody('interrupted', 'stopped')).toBe('Interrupted: stopped');
    expect(buildCloudAgentPushBody('interrupted', undefined)).toBe('Interrupted: Task interrupted');
  });

  it('truncates and normalizes snippets', () => {
    expect(truncatePushSnippet('abcdefghij', 6)).toBe('abc...');
    expect(truncatePushSnippet('hello\n\nworld')).toBe('hello world');
  });
});

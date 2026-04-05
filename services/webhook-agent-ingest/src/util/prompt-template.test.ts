import { describe, it, expect } from 'vitest';
import { renderPromptTemplate } from './prompt-template';

describe('renderPromptTemplate', () => {
  const baseRequest = {
    body: '{"event": "test"}',
    method: 'POST',
    path: '/webhook',
    headers: { 'content-type': 'application/json', 'x-custom': 'value' },
    queryString: 'foo=bar',
    sourceIp: '192.168.1.1',
    timestamp: '2024-01-15T12:00:00Z',
  };

  it('replaces {{body}} with raw body', () => {
    const template = 'Body: {{body}}';
    const result = renderPromptTemplate(template, baseRequest);
    expect(result).toBe('Body: {"event": "test"}');
  });

  it('replaces {{bodyJson}} with pretty-printed JSON', () => {
    const template = 'Body:\n{{bodyJson}}';
    const result = renderPromptTemplate(template, baseRequest);
    expect(result).toBe('Body:\n{\n  "event": "test"\n}');
  });

  it('returns raw body for {{bodyJson}} when body is not valid JSON', () => {
    const template = 'Body: {{bodyJson}}';
    const request = { ...baseRequest, body: 'plain text body' };
    const result = renderPromptTemplate(template, request);
    expect(result).toBe('Body: plain text body');
  });

  it('replaces multiple placeholders in a template', () => {
    const template = `Process this {{method}} webhook to {{path}}:

Request body:
{{bodyJson}}

Headers:
{{headers}}

Query: {{query}}
From: {{sourceIp}}
At: {{timestamp}}`;

    const result = renderPromptTemplate(template, baseRequest);

    expect(result).toContain('Process this POST webhook to /webhook');
    expect(result).toContain('"event": "test"');
    expect(result).toContain('"content-type": "application/json"');
    expect(result).toContain('Query: foo=bar');
    expect(result).toContain('From: 192.168.1.1');
    expect(result).toContain('At: 2024-01-15T12:00:00Z');
  });
});

import { describe, test, expect } from '@jest/globals';
import { carriesBedrockMethod, storedBedrockMethod } from './credential-method';

describe('carriesBedrockMethod', () => {
  test('accepts a Bedrock provider', () => {
    expect(carriesBedrockMethod('bedrock')).toBe(true);
    expect(carriesBedrockMethod('bedrock-byok')).toBe(true);
  });

  test('rejects a provider without a structured credential', () => {
    expect(carriesBedrockMethod('anthropic')).toBe(false);
    expect(carriesBedrockMethod('azure')).toBe(false);
  });
});

describe('storedBedrockMethod', () => {
  test('reads the IAM key pair shape as access keys', () => {
    const credential = JSON.stringify({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      region: 'us-east-1',
    });

    expect(storedBedrockMethod('bedrock', credential)).toBe('accessKeys');
    expect(storedBedrockMethod('bedrock-byok', credential)).toBe('accessKeys');
  });

  test('reads the single API key shape as an API key', () => {
    const credential = JSON.stringify({ apiKey: 'stored-key', region: 'us-west-2' });

    expect(storedBedrockMethod('bedrock', credential)).toBe('apiKey');
  });

  test('reads an empty access key id as neither shape', () => {
    const credential = JSON.stringify({ accessKeyId: '', secretAccessKey: 'secret' });

    expect(storedBedrockMethod('bedrock', credential)).toBeNull();
  });

  test('reads a credential that is not JSON as unknown', () => {
    expect(storedBedrockMethod('bedrock', 'not json')).toBeNull();
  });

  test('reads a JSON value that is not an object as unknown', () => {
    expect(storedBedrockMethod('bedrock', JSON.stringify('stored-key'))).toBeNull();
    expect(storedBedrockMethod('bedrock', 'null')).toBeNull();
    expect(storedBedrockMethod('bedrock', JSON.stringify(['stored-key']))).toBeNull();
  });

  test('reads a provider without a structured credential as unknown', () => {
    const credential = JSON.stringify({ apiKey: 'stored-key', region: 'us-west-2' });

    expect(storedBedrockMethod('anthropic', credential)).toBeNull();
  });
});

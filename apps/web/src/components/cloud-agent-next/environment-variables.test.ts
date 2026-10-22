import { describe, expect, it } from '@jest/globals';
import {
  buildEnvironmentVariableChanges,
  formatEnvironmentVariables,
  parseEnvironmentVariables,
} from './environment-variables';

describe('environment variable text', () => {
  it('reads comments, exports, equals signs, quoted hashes, multiline values and empty values without expansion', () => {
    expect(
      parseEnvironmentVariables(
        '# comment\nexport NODE_ENV=production # comment\nURL="https://example.test?a=b#c"\nCONFIG="first  \nsecond"\nLITERAL=\'${HOME} $(echo no)\'\nEMPTY='
      )
    ).toEqual([
      { key: 'NODE_ENV', value: 'production' },
      { key: 'URL', value: 'https://example.test?a=b#c' },
      { key: 'CONFIG', value: 'first  \nsecond' },
      { key: 'LITERAL', value: '${HOME} $(echo no)' },
      { key: 'EMPTY', value: '' },
    ]);
  });
  it('round trips legacy plaintext without changing whitespace or escapes', () => {
    const variables = [{ key: 'CONFIG', value: '  a="b"\r\nC:\\path\\n\tend  ' }];
    expect(parseEnvironmentVariables(formatEnvironmentVariables(variables))).toEqual(variables);
  });
  it.each([
    ['TOKEN=value\nTOKEN=other', 'entered twice'],
    ['TOKEN="unterminated', 'close the quoted value'],
    ['TOKEN="value" trailing', 'unexpected text'],
    ['missing assignment', 'use KEY=value'],
    ['HOME=/tmp', 'Reserved environment variable'],
    ['TOKEN=' + 'a'.repeat(8193), '8192'],
  ])('rejects invalid input', (input, message) => {
    expect(() => parseEnvironmentVariables(input)).toThrow(message);
  });
  it('never includes secret text in syntax errors', () => {
    expect(() => parseEnvironmentVariables('PRIVATE="sensitive-value" bad')).toThrow(
      'unexpected text'
    );
    try {
      parseEnvironmentVariables('PRIVATE="sensitive-value" bad');
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-value');
    }
  });
});

describe('single-editor secret changes', () => {
  it('formats saved secrets in the editor without their values', () => {
    expect(formatEnvironmentVariables([{ key: 'MODE', value: 'debug' }], ['TOKEN'])).toBe(
      'MODE="debug"\nTOKEN=<unchanged>'
    );
  });
  it('retains hidden secrets and plaintext on an unchanged save without sending placeholders', () => {
    expect(
      buildEnvironmentVariableChanges(
        'MODE="debug"\nTOKEN=<unchanged>',
        [{ key: 'MODE', value: 'debug' }],
        ['TOKEN']
      )
    ).toEqual({
      plainVars: { MODE: 'debug' },
      secrets: [],
      keys: ['MODE', 'TOKEN'],
      removedKeys: [],
    });
  });
  it('encrypts new and deliberately empty values', () => {
    expect(buildEnvironmentVariableChanges('NODE_ENV=production\nEMPTY=', [], [])).toEqual({
      plainVars: {},
      secrets: [
        { key: 'NODE_ENV', value: 'production' },
        { key: 'EMPTY', value: '' },
      ],
      keys: ['NODE_ENV', 'EMPTY'],
      removedKeys: [],
    });
  });
  it('replaces a saved secret when its marker is edited, including an empty value', () => {
    expect(
      buildEnvironmentVariableChanges(
        'TOKEN=\nMODE=info',
        [{ key: 'MODE', value: 'debug' }],
        ['TOKEN']
      )
    ).toEqual({
      plainVars: {},
      secrets: [
        { key: 'TOKEN', value: '' },
        { key: 'MODE', value: 'info' },
      ],
      keys: ['TOKEN', 'MODE'],
      removedKeys: [],
    });
  });
  it('deletes only saved lines that the user removed', () => {
    expect(
      buildEnvironmentVariableChanges(
        'KEEP=<unchanged>',
        [{ key: 'LEGACY', value: 'old' }],
        ['DELETE', 'KEEP']
      )
    ).toEqual({
      plainVars: {},
      secrets: [{ key: 'DELETE', delete: true }],
      keys: ['KEEP'],
      removedKeys: ['DELETE'],
    });
  });
  it('rejects a renamed secret marker or marker for a new key', () => {
    expect(() => buildEnvironmentVariableChanges('NEW=<unchanged>', [], ['OLD'])).toThrow(
      'NEW has no saved secret'
    );
  });
  it('allows a quoted marker as an intentional literal value', () => {
    expect(buildEnvironmentVariableChanges('TOKEN="<unchanged>"', [], ['TOKEN']).secrets).toEqual([
      { key: 'TOKEN', value: '<unchanged>' },
    ]);
  });
  it('retains a saved secret when a comment follows its marker', () => {
    expect(
      buildEnvironmentVariableChanges('TOKEN=<unchanged> # retain this value', [], ['TOKEN'])
        .secrets
    ).toEqual([]);
  });
  it('counts retained secrets when enforcing the variable limit', () => {
    const keys = Array.from({ length: 50 }, (_, i) => `KEY_${i}`);
    const text = formatEnvironmentVariables([], keys);
    expect(() => buildEnvironmentVariableChanges(text + '\nNEW=value', [], keys)).toThrow(
      'Maximum 50'
    );
    expect(buildEnvironmentVariableChanges(text, [], keys).keys).toHaveLength(50);
  });
});

import { describe, expect, it } from 'vitest';

import { passwordFor } from './password';

const host = { id: 'host-1', password: 'saved' };

describe('passwordFor', () => {
  it('sends a password typed in this session over the saved one', () => {
    const prompted = new Map([['host-1', 'typed']]);

    expect(passwordFor(host, prompted)).toBe('typed');
  });

  it('sends the saved password when nothing was typed for this host', () => {
    expect(passwordFor(host, new Map())).toBe('saved');
    expect(passwordFor(host, new Map([['host-2', 'typed']]))).toBe('saved');
  });

  it('asks when the host stores no password and none was typed', () => {
    expect(passwordFor({ id: 'host-1', password: null }, new Map())).toBeNull();
  });
});

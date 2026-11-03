import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';

describe('getLowerDomainFromEmail', () => {
  it.each([
    ['foo', null],
    ['a@', null],
    ['', null],
    ['@example.com', 'example.com'],
    ['A@Example.COM', 'example.com'],
    ['a@b@c.com', 'c.com'],
    ['user@gmail.com', 'gmail.com'],
  ])('%j -> %j', (email, expected) => {
    expect(getLowerDomainFromEmail(email)).toBe(expected);
  });
});

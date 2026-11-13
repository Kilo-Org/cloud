import { callerAddressFromHeaders, callerAddressOrNull } from './caller-address';

describe('callerAddressOrNull', () => {
  it('returns the first hop of the platform-observed header', () => {
    expect(
      callerAddressOrNull(new Headers({ 'x-vercel-forwarded-for': '203.0.113.7, 70.41.3.18' }))
    ).toBe('203.0.113.7');
  });

  it('returns null when neither platform header carries a hop', () => {
    expect(callerAddressOrNull(new Headers({ 'x-forwarded-for': '192.0.2.11' }))).toBeNull();
    expect(callerAddressOrNull(new Headers({ 'x-vercel-forwarded-for': ' ' }))).toBeNull();
  });
});

describe('callerAddressFromHeaders', () => {
  it('returns the first hop of the platform-observed header', () => {
    expect(
      callerAddressFromHeaders(new Headers({ 'x-vercel-forwarded-for': '203.0.113.7, 70.41.3.18' }))
    ).toBe('203.0.113.7');
  });

  it('prefers the platform-observed header when another forwarding header is present', () => {
    expect(
      callerAddressFromHeaders(
        new Headers({
          'x-vercel-forwarded-for': '203.0.113.7',
          'x-forwarded-for': '192.0.2.11, 10.0.0.1',
          'x-real-ip': '198.51.100.4',
        })
      )
    ).toBe('203.0.113.7');
  });

  it('falls back to the real-ip header', () => {
    expect(callerAddressFromHeaders(new Headers({ 'x-real-ip': ' 198.51.100.4 ' }))).toBe(
      '198.51.100.4'
    );
  });

  it('returns unknown when only the generic forwarding header is present', () => {
    expect(callerAddressFromHeaders(new Headers({ 'x-forwarded-for': '192.0.2.11' }))).toBe(
      'unknown'
    );
  });

  it('skips an empty first hop and keeps the key non-empty', () => {
    expect(
      callerAddressFromHeaders(
        new Headers({ 'x-vercel-forwarded-for': ' , 70.41.3.18', 'x-real-ip': '198.51.100.4' })
      )
    ).toBe('198.51.100.4');

    expect(callerAddressFromHeaders(new Headers({ 'x-vercel-forwarded-for': ' ' }))).toBe(
      'unknown'
    );
  });
});

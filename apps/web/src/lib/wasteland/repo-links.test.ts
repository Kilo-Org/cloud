import { forkItemHref, repoPathWithQuery } from './repo-links';

describe('repoPathWithQuery', () => {
  it('leaves the address unchanged without a query', () => {
    expect(repoPathWithQuery('octo', 'commons', '')).toBe('/wasteland/octo/commons');
  });

  it('appends the query string', () => {
    expect(repoPathWithQuery('octo', 'commons', 'wastelandId=wl-1')).toBe(
      '/wasteland/octo/commons?wastelandId=wl-1'
    );
  });
});

describe('forkItemHref', () => {
  it('points at the fork view of the upstream', () => {
    expect(forkItemHref('/wasteland/octo/commons', 'item-1')).toBe(
      '/wasteland/octo/commons/fork?wantedId=item-1'
    );
  });

  it('keeps the query already on the address', () => {
    expect(forkItemHref('/wasteland/octo/commons?wastelandId=wl-1', 'item-1')).toBe(
      '/wasteland/octo/commons/fork?wastelandId=wl-1&wantedId=item-1'
    );
  });

  it('encodes the wanted id', () => {
    expect(forkItemHref('/wasteland/octo/commons', 'a b/c')).toBe(
      '/wasteland/octo/commons/fork?wantedId=a+b%2Fc'
    );
  });
});

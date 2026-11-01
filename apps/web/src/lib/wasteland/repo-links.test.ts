import { forkItemHref, pathWithSelection, repoPathWithQuery } from './repo-links';

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

describe('pathWithSelection', () => {
  it('adds the selection to the root of the address', () => {
    expect(pathWithSelection('/wasteland/octo/commons', '', 'wl-1')).toBe(
      '/wasteland/octo/commons?wastelandId=wl-1'
    );
  });

  it('keeps the section the caller is on', () => {
    expect(pathWithSelection('/wasteland/octo/commons/pulls', '', 'wl-1')).toBe(
      '/wasteland/octo/commons/pulls?wastelandId=wl-1'
    );
  });

  it('keeps the fork view and the item it asked for', () => {
    expect(pathWithSelection('/wasteland/octo/commons/fork', 'wantedId=item-1', 'wl-1')).toBe(
      '/wasteland/octo/commons/fork?wantedId=item-1&wastelandId=wl-1'
    );
  });

  it('keeps a nested section and its filters', () => {
    expect(
      pathWithSelection('/wasteland/octo/commons/settings', 'status=open&q=needle', 'wl-1')
    ).toBe('/wasteland/octo/commons/settings?status=open&q=needle&wastelandId=wl-1');
  });

  it('replaces a selection that is already in the address', () => {
    expect(
      pathWithSelection('/wasteland/octo/commons', 'wastelandId=wl-0&wantedId=item-1', 'wl-1')
    ).toBe('/wasteland/octo/commons?wastelandId=wl-1&wantedId=item-1');
  });

  it('encodes the selection', () => {
    expect(pathWithSelection('/wasteland/octo/commons', '', 'a b/c')).toBe(
      '/wasteland/octo/commons?wastelandId=a+b%2Fc'
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

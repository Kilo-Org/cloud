import { parsePreviewLinkTarget, previewLinkUrl } from './preview-link';

describe('parsePreviewLinkTarget', () => {
  it.each([
    ['http://localhost:3001', { port: 3001, path: '/' }],
    ['http://localhost:5173/app/page?tab=2#top', { port: 5173, path: '/app/page?tab=2#top' }],
    ['https://127.0.0.1:8443/', { port: 8443, path: '/' }],
    ['http://0.0.0.0:8080/health', { port: 8080, path: '/health' }],
    ['http://[::1]:4000/', { port: 4000, path: '/' }],
    ['http://[::]:4000/', { port: 4000, path: '/' }],
    ['http://LOCALHOST:3001/', { port: 3001, path: '/' }],
  ])('maps %s to a sandbox port', (href, expected) => {
    expect(parsePreviewLinkTarget(href)).toEqual(expected);
  });

  it.each([
    ['no link', undefined],
    ['not a URL', 'localhost:3001'],
    ['public host', 'https://example.com:3001/'],
    ['loopback-like subdomain', 'http://app.localhost:3001/'],
    ['no port', 'http://localhost/'],
    ['default port', 'http://localhost:80/'],
    ['port below the preview range', 'http://localhost:1023/'],
    ['credentials', 'http://user:secret@localhost:3001/'],
    ['other scheme', 'ws://localhost:3001/'],
  ])('ignores a link with %s', (_name, href) => {
    expect(parsePreviewLinkTarget(href)).toBeNull();
  });

  it('opens an over-length path at the root', () => {
    expect(parsePreviewLinkTarget(`http://localhost:3001/${'a'.repeat(2048)}`)).toEqual({
      port: 3001,
      path: '/',
    });
  });
});

describe('previewLinkUrl', () => {
  it('fills the port and appends the path', () => {
    expect(
      previewLinkUrl('https://p{port}-abc.preview.example.test', { port: 5173, path: '/app?x=1' })
    ).toBe('https://p5173-abc.preview.example.test/app?x=1');
    expect(previewLinkUrl('http://p{port}-abc.localhost:12094', { port: 3001, path: '/' })).toBe(
      'http://p3001-abc.localhost:12094/'
    );
  });
});

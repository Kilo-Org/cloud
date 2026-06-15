import type { DeploymentFile } from '../types';
import {
  MAX_TOTAL_BYTES,
  getUploadFormat,
  parseHtmlFile,
  parseMultipartFiles,
  parseTtlHeader,
  validateStaticAssets,
} from '../html-deploy/validator';

function file(path: string): DeploymentFile {
  return {
    path,
    content: Buffer.from('<html></html>', 'utf-8'),
    mimeType: 'text/html',
  };
}

describe('HTML deployment asset validation', () => {
  it('requires index.html at the deployment root', () => {
    expect(validateStaticAssets([file('docs/index.html')])).toBe(
      'index.html is required at the root'
    );
    expect(validateStaticAssets([file('index.html'), file('docs/index.html')])).toBeNull();
  });

  it('recognizes only supported upload media types', () => {
    expect(getUploadFormat('text/html; charset=utf-8')).toBe('html');
    expect(getUploadFormat('multipart/form-data; boundary=test')).toBe('multipart');
    expect(getUploadFormat('application/json')).toBeNull();
  });

  it('limits raw HTML uploads by UTF-8 byte length', async () => {
    const oversizedHtml = 'x'.repeat(MAX_TOTAL_BYTES + 1);
    const request = new Request('https://builder.test/deploy-html', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: oversizedHtml,
    });

    await expect(parseHtmlFile(request)).rejects.toThrow('Request exceeds the 10 MB limit');
  });

  it.each([
    ['exact duplicates', 'index.html', 'index.html'],
    ['slash aliases', 'assets\\app.js', 'assets/app.js'],
  ])('rejects duplicate normalized multipart paths from %s', async (_, firstPath, secondPath) => {
    const formData = new FormData();
    formData.append(firstPath, new Blob(['first']));
    formData.append(secondPath, new Blob(['second']));
    const request = new Request('https://builder.test/deploy-html', {
      method: 'POST',
      body: formData,
    });

    await expect(parseMultipartFiles(request)).rejects.toThrow(
      `Duplicate file path: "${secondPath.replace(/\\/g, '/')}"`
    );
  });

  it('uses the default TTL only when the expiration header is absent', () => {
    expect(parseTtlHeader(null, { defaultTtl: 86_400, maxTtl: 604_800 })).toBe(86_400);
  });

  it.each(['', '0', '-1', '3600seconds', '1e6', ' 3600', '3600 ', '+3600', '1.5'])(
    'rejects malformed explicit TTL value %p',
    header => {
      expect(() => parseTtlHeader(header, { defaultTtl: 86_400, maxTtl: 604_800 })).toThrow(
        'X-Expires-In must be a positive base-10 integer'
      );
    }
  );

  it('clamps explicit TTL values to the configured maximum', () => {
    expect(parseTtlHeader('604801', { defaultTtl: 86_400, maxTtl: 604_800 })).toBe(604_800);
  });
});

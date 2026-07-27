import { readFileSync } from 'fs';
import { join } from 'path';

import { aasaComponents } from '@kilocode/app-shared/universal-links';

const wellKnownDir = join(__dirname, '../../public/.well-known');

const ANDROID_UPLOAD_CERT_FINGERPRINT =
  '39:87:0D:39:0E:45:88:4F:B8:B0:2D:A5:0C:E4:97:9B:EC:67:B2:CF:5F:69:D9:A8:84:79:5E:65:FD:B8:85:E7';

describe('apple-app-site-association', () => {
  const raw = readFileSync(join(wellKnownDir, 'apple-app-site-association'), 'utf8');
  const parsed = JSON.parse(raw) as {
    applinks: {
      details: Array<{
        appIDs: string[];
        components: ReturnType<typeof aasaComponents>;
      }>;
    };
    webcredentials?: unknown;
  };

  it('parses as JSON with a single applinks.details entry', () => {
    expect(parsed.applinks.details).toHaveLength(1);
  });

  it('targets the Kilo iOS app ID', () => {
    expect(parsed.applinks.details[0]?.appIDs).toEqual(['X96D76J65Z.com.kilocode.kiloapp']);
  });

  it('components match aasaComponents() from app-shared', () => {
    expect(parsed.applinks.details[0]?.components).toEqual(aasaComponents());
  });

  it('does not declare webcredentials', () => {
    expect(parsed).not.toHaveProperty('webcredentials');
  });
});

describe('assetlinks.json', () => {
  const raw = readFileSync(join(wellKnownDir, 'assetlinks.json'), 'utf8');
  const parsed = JSON.parse(raw) as Array<{
    relation: string[];
    target: {
      namespace: string;
      package_name: string;
      sha256_cert_fingerprints: string[];
    };
  }>;

  it('is a single-entry Digital Asset Links array', () => {
    expect(parsed).toHaveLength(1);
  });

  it('delegates handle_all_urls to the Android app package', () => {
    const entry = parsed[0];
    expect(entry?.relation).toContain('delegate_permission/common.handle_all_urls');
    expect(entry?.target.namespace).toBe('android_app');
    expect(entry?.target.package_name).toBe('com.kilocode.kiloapp');
  });

  it('lists only the verified EAS upload-certificate fingerprint', () => {
    expect(parsed[0]?.target.sha256_cert_fingerprints).toEqual([ANDROID_UPLOAD_CERT_FINGERPRINT]);
  });
});

import { afterEach, beforeEach, describe, expect, it, mock, vi, type Mock } from 'bun:test';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockAppendFileSync = vi.fn();

// oxlint-disable-next-line no-floating-promises -- Bun hoists this call above the cert import
mock.module('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync,
}));

import { installInterceptTrustIfEnabled, trustRuntimeCert } from './cert';

const DEFAULT_CERT_PATH = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const PRIMARY_SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const FALLBACK_SYSTEM_CA_BUNDLE = '/etc/pki/tls/certs/ca-bundle.crt';
const SYSTEM_CA_BUNDLE_PATHS = [
  PRIMARY_SYSTEM_CA_BUNDLE,
  FALLBACK_SYSTEM_CA_BUNDLE,
  '/etc/ssl/ca-bundle.pem',
  '/etc/ssl/cert.pem',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/etc/pki/tls/cert.pem',
];

let mockProcessExit: Mock<(code?: string | number | null) => never>;

let sleepSpy: { mockRestore: () => void } | undefined;
let dateSpy: { mockRestore: () => void } | undefined;

function isKnownFsPath(path: string): boolean {
  return path === DEFAULT_CERT_PATH || SYSTEM_CA_BUNDLE_PATHS.includes(path);
}

function existsSyncResult(presentPaths: readonly string[]): (path: string) => boolean {
  return (path: string) => {
    if (!isKnownFsPath(path)) throw new Error(`Unexpected existsSync path: ${path}`);
    return presentPaths.includes(path);
  };
}

function installDefaultFsMocks(): void {
  mockExistsSync.mockImplementation(existsSyncResult([]));
  mockReadFileSync.mockImplementation((path: string) => {
    throw new Error(`Unexpected readFileSync path: ${path}`);
  });
  mockAppendFileSync.mockImplementation((path: string) => {
    if (!SYSTEM_CA_BUNDLE_PATHS.includes(path)) {
      throw new Error(`Unexpected appendFileSync path: ${path}`);
    }
  });
}

function clearCaEnv(): void {
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.SSL_CERT_FILE;
  delete process.env.CURL_CA_BUNDLE;
  delete process.env.REQUESTS_CA_BUNDLE;
  delete process.env.GIT_SSL_CAINFO;
  delete process.env.SANDBOX_INTERCEPT_HTTPS;
}

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockAppendFileSync.mockReset();
  installDefaultFsMocks();
  mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((): never => {
    throw new Error('process.exit');
  });
  clearCaEnv();
});

afterEach(() => {
  sleepSpy?.mockRestore();
  dateSpy?.mockRestore();
  mockProcessExit.mockRestore();
  sleepSpy = undefined;
  dateSpy = undefined;
  clearCaEnv();
});

describe('trustRuntimeCert', () => {
  it('exits with code 1 when the cert file is not found', async () => {
    mockExistsSync.mockImplementation(existsSyncResult([]));
    sleepSpy = vi.spyOn(Bun, 'sleep').mockResolvedValue();
    dateSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
    const log = vi.fn();

    await trustRuntimeCert(log).catch(() => undefined);

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(log.mock.calls[0]?.[0]).toContain('Certificate not found');
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('exits with code 1 when reading the runtime cert fails', async () => {
    mockExistsSync.mockImplementation(existsSyncResult([DEFAULT_CERT_PATH]));
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) throw new Error('read failed');
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });

    await trustRuntimeCert(vi.fn()).catch(() => undefined);

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('exits with code 1 when appending to the system bundle fails', async () => {
    mockExistsSync.mockImplementation(
      existsSyncResult([DEFAULT_CERT_PATH, PRIMARY_SYSTEM_CA_BUNDLE])
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return 'cert-content';
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });
    mockAppendFileSync.mockImplementation(() => {
      throw new Error('append failed');
    });

    await trustRuntimeCert(vi.fn()).catch(() => undefined);

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(process.env.SSL_CERT_FILE).toBeUndefined();
    expect(process.env.CURL_CA_BUNDLE).toBeUndefined();
    expect(process.env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined();
  });

  it('appends the cert content to the primary system bundle when it exists', async () => {
    const certContent = '-----BEGIN CERTIFICATE-----\nABCDEF\n-----END CERTIFICATE-----\n';
    mockExistsSync.mockImplementation(
      existsSyncResult([DEFAULT_CERT_PATH, PRIMARY_SYSTEM_CA_BUNDLE])
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return certContent;
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });

    await trustRuntimeCert(vi.fn());

    expect(mockReadFileSync).toHaveBeenCalledWith(DEFAULT_CERT_PATH, 'utf8');
    expect(mockAppendFileSync).toHaveBeenCalledWith(PRIMARY_SYSTEM_CA_BUNDLE, `\n${certContent}`);
    expect(process.env.SSL_CERT_FILE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.CURL_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.GIT_SSL_CAINFO).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('leaves a pre-existing NODE_EXTRA_CA_CERTS value unchanged after a successful append', async () => {
    const certContent = 'cert-content';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/existing-node-extra-ca-certs';
    mockExistsSync.mockImplementation(
      existsSyncResult([DEFAULT_CERT_PATH, PRIMARY_SYSTEM_CA_BUNDLE])
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return certContent;
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });

    await trustRuntimeCert(vi.fn());

    expect(mockAppendFileSync).toHaveBeenCalledWith(PRIMARY_SYSTEM_CA_BUNDLE, `\n${certContent}`);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe('/tmp/existing-node-extra-ca-certs');
    expect(process.env.SSL_CERT_FILE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.CURL_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.GIT_SSL_CAINFO).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
  });

  it('appends to the first existing fallback system bundle when the primary is absent', async () => {
    const certContent = 'cert-content';
    mockExistsSync.mockImplementation(
      existsSyncResult([DEFAULT_CERT_PATH, FALLBACK_SYSTEM_CA_BUNDLE])
    );
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return certContent;
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });

    await trustRuntimeCert(vi.fn());

    expect(mockAppendFileSync).toHaveBeenCalledWith(FALLBACK_SYSTEM_CA_BUNDLE, `\n${certContent}`);
    expect(process.env.SSL_CERT_FILE).toBe(FALLBACK_SYSTEM_CA_BUNDLE);
    expect(process.env.CURL_CA_BUNDLE).toBe(FALLBACK_SYSTEM_CA_BUNDLE);
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(FALLBACK_SYSTEM_CA_BUNDLE);
    expect(process.env.GIT_SSL_CAINFO).toBe(FALLBACK_SYSTEM_CA_BUNDLE);
  });

  it('leaves pre-existing bundle vars and NODE_EXTRA_CA_CERTS when no system bundle exists', async () => {
    process.env.SSL_CERT_FILE = '/tmp/existing-ssl-cert-file';
    process.env.CURL_CA_BUNDLE = '/tmp/existing-curl-ca-bundle';
    process.env.REQUESTS_CA_BUNDLE = '/tmp/existing-requests-ca-bundle';
    process.env.GIT_SSL_CAINFO = '/tmp/existing-git-ssl-cainfo';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/existing-node-extra-ca-certs';
    mockExistsSync.mockImplementation(existsSyncResult([DEFAULT_CERT_PATH]));
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return 'cert-content';
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });

    await trustRuntimeCert(vi.fn());

    expect(process.env.NODE_EXTRA_CA_CERTS).toBe('/tmp/existing-node-extra-ca-certs');
    expect(process.env.SSL_CERT_FILE).toBe('/tmp/existing-ssl-cert-file');
    expect(process.env.CURL_CA_BUNDLE).toBe('/tmp/existing-curl-ca-bundle');
    expect(process.env.REQUESTS_CA_BUNDLE).toBe('/tmp/existing-requests-ca-bundle');
    expect(process.env.GIT_SSL_CAINFO).toBe('/tmp/existing-git-ssl-cainfo');
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('leaves NODE_EXTRA_CA_CERTS undefined when no system bundle exists', async () => {
    mockExistsSync.mockImplementation(existsSyncResult([DEFAULT_CERT_PATH]));
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return 'cert-content';
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });

    await trustRuntimeCert(vi.fn());

    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(process.env.SSL_CERT_FILE).toBeUndefined();
    expect(process.env.CURL_CA_BUNDLE).toBeUndefined();
    expect(process.env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});

describe('installInterceptTrustIfEnabled', () => {
  it('does no fs work and never exits when the marker is absent', async () => {
    await installInterceptTrustIfEnabled(vi.fn());

    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  it('does not exit or append bundle vars until a delayed cert file appears', async () => {
    process.env.SANDBOX_INTERCEPT_HTTPS = '1';
    let certPresent = false;
    mockExistsSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return certPresent;
      if (path === PRIMARY_SYSTEM_CA_BUNDLE) return true;
      if (isKnownFsPath(path)) return false;
      throw new Error(`Unexpected existsSync path: ${path}`);
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === DEFAULT_CERT_PATH) return 'cert-content';
      throw new Error(`Unexpected readFileSync path: ${path}`);
    });
    let releaseSleep: (() => void) | undefined;
    sleepSpy = vi
      .spyOn(Bun, 'sleep')
      .mockImplementation(() => new Promise<void>(resolve => (releaseSleep = resolve)));
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(0);

    const installPromise = installInterceptTrustIfEnabled(vi.fn());

    await Promise.resolve();
    expect(releaseSleep).toBeDefined();
    expect(mockExistsSync).toHaveBeenCalled();
    expect(mockProcessExit).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(process.env.SSL_CERT_FILE).toBeUndefined();
    expect(process.env.CURL_CA_BUNDLE).toBeUndefined();
    expect(process.env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined();

    certPresent = true;
    releaseSleep?.();
    await installPromise;

    expect(mockAppendFileSync).toHaveBeenCalledWith(PRIMARY_SYSTEM_CA_BUNDLE, '\ncert-content');
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(process.env.SSL_CERT_FILE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.CURL_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(process.env.GIT_SSL_CAINFO).toBe(PRIMARY_SYSTEM_CA_BUNDLE);
    expect(mockProcessExit).not.toHaveBeenCalled();
  });
});

describe('control wrapper bootstrap trust ordering', () => {
  it('awaits intercept trust before starting telemetry and main', async () => {
    const source = (await Bun.file(new URL('./main.ts', import.meta.url)).text()).replace(
      /\s+/g,
      ' '
    );

    const starting = source.indexOf("phase: 'starting'");
    const install = source.indexOf('await installInterceptTrustIfEnabled(logToFile)');
    const diagnosticsStart = source.indexOf('diagnostics.start()');
    const fileLogsStart = source.indexOf('fileLogs.start()');
    const mainCall = source.indexOf('main(diagnostics, fileLogs, wrapperInstanceId)');

    expect(starting).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(starting);
    expect(diagnosticsStart).toBeGreaterThan(install);
    expect(fileLogsStart).toBeGreaterThan(install);
    expect(mainCall).toBeGreaterThan(install);
  });
});

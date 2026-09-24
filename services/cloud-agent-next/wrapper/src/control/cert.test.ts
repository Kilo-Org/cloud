import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installInterceptTrustIfEnabled, trustRuntimeCert, type RuntimeCertPaths } from './cert';

const CERT_CONTENT = '-----BEGIN CERTIFICATE-----\nABCDEF\n-----END CERTIFICATE-----\n';
const BUNDLE_CONTENT = '# system bundle\n';

const BUNDLE_NAMES = [
  'ca-certificates.crt',
  'ca-bundle.crt',
  'ca-bundle.pem',
  'cert.pem',
  'tls-ca-bundle.pem',
  'legacy-cert.pem',
];

let root: string;
let certPath: string;
let systemBundlePaths: string[];
let runtimePaths: RuntimeCertPaths;

let mockProcessExit: Mock<(code?: string | number | null) => never>;
let sleepSpy: { mockRestore: () => void } | undefined;
let dateSpy: { mockRestore: () => void } | undefined;

function bundlePath(index: number): string {
  const bundle = systemBundlePaths[index];
  if (bundle === undefined) throw new Error(`No bundle at index ${index}`);
  return bundle;
}

function writeCert(content = CERT_CONTENT): void {
  writeFileSync(certPath, content);
}

function writeBundle(index: number, content = BUNDLE_CONTENT): void {
  writeFileSync(bundlePath(index), content);
}

function expectBundleAppended(index: number, certContent = CERT_CONTENT): void {
  expect(readFileSync(bundlePath(index), 'utf8')).toBe(`${BUNDLE_CONTENT}\n${certContent}`);
}

function expectBundleVarsPointAt(bundle: string): void {
  expect(process.env.SSL_CERT_FILE).toBe(bundle);
  expect(process.env.CURL_CA_BUNDLE).toBe(bundle);
  expect(process.env.REQUESTS_CA_BUNDLE).toBe(bundle);
  expect(process.env.GIT_SSL_CAINFO).toBe(bundle);
}

function expectBundleVarsUnset(): void {
  expect(process.env.SSL_CERT_FILE).toBeUndefined();
  expect(process.env.CURL_CA_BUNDLE).toBeUndefined();
  expect(process.env.REQUESTS_CA_BUNDLE).toBeUndefined();
  expect(process.env.GIT_SSL_CAINFO).toBeUndefined();
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
  root = mkdtempSync(path.join(os.tmpdir(), 'intercept-cert-'));
  certPath = path.join(root, 'cloudflare-containers-ca.crt');
  systemBundlePaths = BUNDLE_NAMES.map(name => path.join(root, name));
  runtimePaths = { certPath, systemBundlePaths };
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
  rmSync(root, { recursive: true, force: true });
});

describe('trustRuntimeCert', () => {
  it('exits with code 1 when the cert file is not found', async () => {
    const log = vi.fn();
    sleepSpy = vi.spyOn(Bun, 'sleep').mockResolvedValue();
    dateSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);

    await trustRuntimeCert(log, runtimePaths).catch(() => undefined);

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(log.mock.calls[0]?.[0]).toContain('Certificate not found');
    expectBundleVarsUnset();
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('exits with code 1 when reading the runtime cert fails', async () => {
    mkdirSync(certPath);
    writeBundle(0);

    await trustRuntimeCert(vi.fn(), runtimePaths).catch(() => undefined);

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(readFileSync(bundlePath(0), 'utf8')).toBe(BUNDLE_CONTENT);
    expectBundleVarsUnset();
  });

  it('exits with code 1 when appending to the system bundle fails', async () => {
    writeCert();
    mkdirSync(bundlePath(0));

    await trustRuntimeCert(vi.fn(), runtimePaths).catch(() => undefined);

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expectBundleVarsUnset();
  });

  it('appends the cert content to the primary system bundle when it exists', async () => {
    writeCert();
    writeBundle(0);

    await trustRuntimeCert(vi.fn(), runtimePaths);

    expectBundleAppended(0);
    expectBundleVarsPointAt(bundlePath(0));
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('leaves a pre-existing NODE_EXTRA_CA_CERTS value unchanged after a successful append', async () => {
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/existing-node-extra-ca-certs';
    writeCert();
    writeBundle(0);

    await trustRuntimeCert(vi.fn(), runtimePaths);

    expectBundleAppended(0);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe('/tmp/existing-node-extra-ca-certs');
    expectBundleVarsPointAt(bundlePath(0));
  });

  it('appends to the first existing fallback system bundle when the primary is absent', async () => {
    writeCert();
    writeBundle(1);

    await trustRuntimeCert(vi.fn(), runtimePaths);

    expectBundleAppended(1);
    expectBundleVarsPointAt(bundlePath(1));
  });

  it('leaves pre-existing bundle vars and NODE_EXTRA_CA_CERTS when no system bundle exists', async () => {
    process.env.SSL_CERT_FILE = '/tmp/existing-ssl-cert-file';
    process.env.CURL_CA_BUNDLE = '/tmp/existing-curl-ca-bundle';
    process.env.REQUESTS_CA_BUNDLE = '/tmp/existing-requests-ca-bundle';
    process.env.GIT_SSL_CAINFO = '/tmp/existing-git-ssl-cainfo';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/existing-node-extra-ca-certs';
    writeCert();

    await trustRuntimeCert(vi.fn(), runtimePaths);

    expect(process.env.NODE_EXTRA_CA_CERTS).toBe('/tmp/existing-node-extra-ca-certs');
    expect(process.env.SSL_CERT_FILE).toBe('/tmp/existing-ssl-cert-file');
    expect(process.env.CURL_CA_BUNDLE).toBe('/tmp/existing-curl-ca-bundle');
    expect(process.env.REQUESTS_CA_BUNDLE).toBe('/tmp/existing-requests-ca-bundle');
    expect(process.env.GIT_SSL_CAINFO).toBe('/tmp/existing-git-ssl-cainfo');
    expect(readdirSync(root)).toEqual(['cloudflare-containers-ca.crt']);
  });

  it('leaves NODE_EXTRA_CA_CERTS undefined when no system bundle exists', async () => {
    writeCert();

    await trustRuntimeCert(vi.fn(), runtimePaths);

    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expectBundleVarsUnset();
    expect(readdirSync(root)).toEqual(['cloudflare-containers-ca.crt']);
  });
});

describe('installInterceptTrustIfEnabled', () => {
  it('does nothing when the marker is absent', async () => {
    await installInterceptTrustIfEnabled(vi.fn(), runtimePaths);

    expect(mockProcessExit).not.toHaveBeenCalled();
    expectBundleVarsUnset();
    expect(readdirSync(root)).toEqual([]);
  });

  it('does not exit or append bundle vars until a delayed cert file appears', async () => {
    process.env.SANDBOX_INTERCEPT_HTTPS = '1';
    writeBundle(0);
    let releaseSleep: (() => void) | undefined;
    sleepSpy = vi
      .spyOn(Bun, 'sleep')
      .mockImplementation(() => new Promise<void>(resolve => (releaseSleep = resolve)));
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(0);

    const installPromise = installInterceptTrustIfEnabled(vi.fn(), runtimePaths);

    await Promise.resolve();
    expect(releaseSleep).toBeDefined();
    expect(mockProcessExit).not.toHaveBeenCalled();
    expect(readFileSync(bundlePath(0), 'utf8')).toBe(BUNDLE_CONTENT);
    expectBundleVarsUnset();

    writeCert();
    releaseSleep?.();
    await installPromise;

    expectBundleAppended(0);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expectBundleVarsPointAt(bundlePath(0));
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

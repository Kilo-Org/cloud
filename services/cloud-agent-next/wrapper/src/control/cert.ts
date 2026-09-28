import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  CONTAINERS_INTERCEPT_CA_PATH,
  SANDBOX_INTERCEPT_HTTPS_ENABLED,
  SANDBOX_INTERCEPT_HTTPS_ENV,
} from '../../../src/shared/container-intercept.js';

export type CertLogger = (message: string) => void;

const SYSTEM_CA_BUNDLE_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Alpine, Arch
  '/etc/pki/tls/certs/ca-bundle.crt', // Fedora, RHEL, CentOS
  '/etc/ssl/ca-bundle.pem', // SUSE and openSUSE
  '/etc/ssl/cert.pem', // Alpine and OpenSSL-compatible bundle symlink
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL-family extracted PEM bundle
  '/etc/pki/tls/cert.pem', // Older RHEL-family compatibility bundle
];
const CERT_WAIT_TIMEOUT_MS = 5000;
const CERT_WAIT_POLL_MS = 100;

export interface RuntimeCertPaths {
  readonly certPath: string;
  readonly systemBundlePaths: readonly string[];
}

const DEFAULT_RUNTIME_CERT_PATHS: RuntimeCertPaths = {
  certPath: CONTAINERS_INTERCEPT_CA_PATH,
  systemBundlePaths: SYSTEM_CA_BUNDLE_PATHS,
};

function findSystemBundle(systemBundlePaths: readonly string[]): string | undefined {
  return systemBundlePaths.find(bundlePath => existsSync(bundlePath));
}

async function waitForCertFile(certPath: string): Promise<boolean> {
  if (existsSync(certPath)) return true;

  const deadline = Date.now() + CERT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(certPath)) return true;
    await Bun.sleep(CERT_WAIT_POLL_MS);
  }
  return false;
}

export async function trustRuntimeCert(
  log: CertLogger = console.error,
  paths: RuntimeCertPaths = DEFAULT_RUNTIME_CERT_PATHS
): Promise<void> {
  const { certPath, systemBundlePaths } = paths;
  if (!(await waitForCertFile(certPath))) {
    log('Certificate not found, refusing to start without HTTPS interception enabled');
    process.exit(1);
  }

  let certContent: string;
  try {
    certContent = readFileSync(certPath, 'utf8');
  } catch {
    log('Failed to read runtime certificate, refusing to start without HTTPS interception enabled');
    process.exit(1);
  }

  const systemBundlePath = findSystemBundle(systemBundlePaths);
  if (!systemBundlePath) {
    log('No supported system CA bundle found');
    return;
  }

  try {
    appendFileSync(systemBundlePath, `\n${certContent}`);
  } catch {
    log(
      'Failed to append runtime certificate, refusing to start without HTTPS interception enabled'
    );
    process.exit(1);
  }

  // NODE_EXTRA_CA_CERTS is additive in Node/Bun; the rest replace the default
  // store entirely, so they must point to the full bundle.
  process.env.SSL_CERT_FILE = systemBundlePath;
  process.env.CURL_CA_BUNDLE = systemBundlePath;
  process.env.REQUESTS_CA_BUNDLE = systemBundlePath;
  process.env.GIT_SSL_CAINFO = systemBundlePath;
}

export async function installInterceptTrustIfEnabled(
  log: CertLogger = console.error,
  paths: RuntimeCertPaths = DEFAULT_RUNTIME_CERT_PATHS
): Promise<void> {
  if (process.env[SANDBOX_INTERCEPT_HTTPS_ENV] !== SANDBOX_INTERCEPT_HTTPS_ENABLED) return;
  await trustRuntimeCert(log, paths);
}

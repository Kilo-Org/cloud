import { execFile } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';

export type ScmAuthority = {
  caCertificate: string;
  certificate: string;
  privateKey: string;
  expiresAt: string;
};
const execute = promisify(execFile);

/** One static leaf per deployment removes certificate generation from the request path. */
export async function createScmAuthority(): Promise<ScmAuthority> {
  const directory = await mkdtemp(join(tmpdir(), 'kilo-egress-ca-'));
  const run = async (args: string[]) => {
    try {
      await execute('openssl', args, { cwd: directory, timeout: 15_000, maxBuffer: 16_384 });
    } catch {
      throw new Error('SCM certificate generation failed');
    }
  };
  try {
    await run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-noenc',
      '-sha256',
      '-days',
      '365',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-subj',
      '/CN=Kilo AWS SCM Proxy CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-addext',
      'nameConstraints=critical,permitted;DNS:github.com,permitted;DNS:gitlab.com,permitted;DNS:bitbucket.org',
    ]);
    await run([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-noenc',
      '-sha256',
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=Kilo AWS SCM Proxy',
    ]);
    await writeFile(
      join(directory, 'leaf.ext'),
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        'authorityKeyIdentifier=keyid,issuer',
        'subjectAltName=' + STANDARD_SCM_HOSTS.map(host => 'DNS:' + host).join(','),
      ].join('\n'),
      { mode: 0o600 }
    );
    await run([
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-set_serial',
      '0x' + randomBytes(16).toString('hex'),
      '-out',
      'leaf.pem',
      '-days',
      '30',
      '-sha256',
      '-extfile',
      'leaf.ext',
    ]);
    const [caCertificate, certificate, privateKey] = await Promise.all([
      readFile(join(directory, 'ca.pem'), 'utf8'),
      readFile(join(directory, 'leaf.pem'), 'utf8'),
      readFile(join(directory, 'leaf.key'), 'utf8'),
    ]);
    const ca = new X509Certificate(caCertificate);
    const leaf = new X509Certificate(certificate);
    if (
      !ca.ca ||
      !leaf.verify(ca.publicKey) ||
      STANDARD_SCM_HOSTS.some(host => leaf.checkHost(host) !== host)
    )
      throw new Error('SCM certificate validation failed');
    return {
      caCertificate,
      certificate,
      privateKey,
      expiresAt: new Date(Math.min(Date.parse(ca.validTo), Date.parse(leaf.validTo))).toISOString(),
    };
  } finally {
    // Immutable generations need no further signing. The CA private key is never persisted to S3.
    await rm(directory, { recursive: true, force: true });
  }
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { devNull } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateTarget } from './perf-common.mjs';
import {
  assertManifestIdentity,
  currentDeployment,
  inventory,
  listWorkerScripts,
  operatorAPI,
  resolveOperatorToken,
  retryTransient,
} from './perf-identity.mjs';

export async function runOperatorCLI(manifest, args, deadline, options = {}) {
  assert(manifest.wrangler.endsWith('/node_modules/.bin/wrangler'));
  assert(Date.now() < deadline, 'Teardown deadline exhausted');
  const token = await (options.resolveToken ?? resolveOperatorToken)(manifest.wrangler, deadline);
  assert(Date.now() < deadline, 'Teardown deadline exhausted');
  const child = spawn(manifest.wrangler, ['--config', manifest.configFile, ...args], {
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: manifest.accountID,
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // This bounded output is private classification input only; never return or echo it.
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  let timedOut = false;
  const capture = chunk => {
    if (bytes + chunk.length > 65536) {
      exceeded = true;
      child.kill('SIGKILL');
      return;
    }
    bytes += chunk.length;
    chunks.push(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.stdin.on('error', () => {});
  child.stdin.end('y\n');
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    },
    Math.max(1, Math.min(options.timeoutMs ?? 30000, deadline - Date.now()))
  );
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', () => reject(Error('Operator CLI spawn_failed')));
      child.once('close', resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  if (code === 0 && !exceeded && !timedOut) return { absent: false };
  const text = Buffer.concat(chunks).toString('utf8');
  const denied =
    /\b(?:401|403|10000|unauthorized|forbidden)\b|authentication|permission denied|not authorized|invalid (?:api )?token|access denied/i.test(
      text
    );
  const syntax =
    /unknown (?:argument|command)|not enough non-option|missing required|invalid argument|syntax error|usage:/i.test(
      text
    );
  const missing =
    /\b(?:HTTP(?: status)?|status(?: code)?)\s*[:=]?\s*404\b|\bNoSuchKey\b|specified key does not exist/i.test(
      text
    );
  if (!exceeded && !denied && !syntax && !timedOut && missing && options.allowAbsent)
    return { absent: true };
  const transient =
    !exceeded &&
    !denied &&
    !syntax &&
    (timedOut ||
      /\b(?:HTTP(?:\/[\d.]+)?(?: error| status)?|status(?: code)?|response(?: code)?)\s*[:=]?\s*(?:408|429|5\d\d)\b|(?:error|request failed|unexpected response)\D{0,32}\b(?:408|429|5\d\d)\b|gateway timeout|service unavailable|too many requests|\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED)\b/i.test(
        text
      ));
  const category = exceeded
    ? 'output_limit'
    : denied
      ? 'authorization_denied'
      : syntax
        ? 'invalid_command'
        : transient
          ? 'transient_failure'
          : 'permanent_failure';
  throw Object.assign(Error(`Operator CLI ${category}`), { operatorCLI: true, transient });
}

export async function cleanupOwned(manifest, api, cli, proof, save) {
  assertManifestIdentity(manifest, true);
  const account = `/accounts/${manifest.accountID}`;
  const deadline = proof.deadline ?? manifest.teardownAt + manifest.teardownTailSeconds * 1000;
  assert(Number.isFinite(deadline), 'Shared teardown deadline required');
  proof.expectedResources = {
    worker: manifest.workerName,
    namespaces: manifest.namespaceIDs,
    bucket: { name: manifest.r2Bucket, id: manifest.r2BucketID },
    hyperdrive: manifest.hyperdriveID,
    secrets: manifest.secrets,
    r2Keys: manifest.r2Keys ?? [],
  };
  // null means inventory unavailable, never a claim that an unobserved resource is absent.
  proof.remaining = {
    worker: null,
    namespaces: null,
    bucket: null,
    hyperdrive: null,
    secrets: null,
  };
  async function operation(name, action, retryCLI = false) {
    try {
      if (retryCLI)
        await retryTransient(async () => {
          try {
            await action();
          } catch (error) {
            // REST already has bounded retries; only classified CLI failures retry the operation.
            if (error.operatorCLI) throw error;
            throw Error(error.message);
          }
        }, deadline);
      else await action();
      proof.operations.push({ name, ok: true, at: Date.now() });
    } catch (error) {
      proof.errors.push({ name, error: error.message, at: Date.now() });
    }
    save();
  }
  // Highest-cost compute first; another resource's unavailable metadata must not block it.
  await operation(
    'delete_worker',
    async () => {
      const current = await currentDeployment(manifest, api);
      if (!current.absent) await cli(['delete', manifest.workerName, '--force']);
    },
    true
  );
  for (const key of manifest.r2Keys ?? []) {
    let attempt = 0;
    await operation(
      'delete_synthetic_object',
      async () => {
        assert(
          typeof key === 'string' &&
            /^[a-zA-Z0-9_./-]+$/.test(key) &&
            !key.startsWith('/') &&
            !key.split('/').some(part => part === '.' || part === '..')
        );
        const current = await api(
          'GET',
          `${account}/r2/buckets/${manifest.r2Bucket}/domains/managed`
        );
        if (!current.absent) {
          assert.equal(current.result.bucketId, manifest.r2BucketID);
          if (attempt++ > 0) {
            const object = await cli(
              ['r2', 'object', 'get', `${manifest.r2Bucket}/${key}`, '--remote', '--file', devNull],
              { allowAbsent: true }
            );
            if (object.absent) return;
          }
          await cli(['r2', 'object', 'delete', `${manifest.r2Bucket}/${key}`, '--remote']);
        }
      },
      true
    );
  }
  await operation(
    'delete_bucket',
    async () => {
      const current = await api(
        'GET',
        `${account}/r2/buckets/${manifest.r2Bucket}/domains/managed`
      );
      if (!current.absent) {
        assert.equal(current.result.bucketId, manifest.r2BucketID);
        await cli(['r2', 'bucket', 'delete', manifest.r2Bucket]);
      }
    },
    true
  );
  await operation('delete_hyperdrive', async () => {
    const path = `${account}/hyperdrive/configs/${manifest.hyperdriveID}`;
    const current = await api('GET', path);
    if (!current.absent) {
      assert.equal(current.result.name, manifest.workerName);
      await api('DELETE', path);
    }
  });
  const secretPath = `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`;
  for (const secret of manifest.secrets) {
    await operation('delete_staging_secret', async () => {
      assert(manifest.secretNames.includes(secret.name));
      const rows = await inventory(api, secretPath, result =>
        Array.isArray(result) ? result : result.secrets
      );
      const current = rows.find(item => item.id === secret.id);
      if (current) {
        assert.equal(current.name, secret.name);
        await api('DELETE', `${secretPath}/${secret.id}`);
      }
    });
  }
  await operation('verify_worker_absent', async () => {
    const rows = await listWorkerScripts(api);
    proof.remaining.worker = rows
      .filter(item => item.id === manifest.workerName)
      .map(item => item.id);
    assert.equal(proof.remaining.worker.length, 0);
  });
  await operation('verify_namespaces_absent', async () => {
    const rows = await inventory(api, `${account}/workers/durable_objects/namespaces`);
    proof.remaining.namespaces = rows
      .filter(
        item =>
          manifest.namespaceIDs.includes(item.id) ||
          item.script === manifest.workerName ||
          item.script_name === manifest.workerName
      )
      .map(item => item.id);
    assert.equal(proof.remaining.namespaces.length, 0);
  });
  for (const [name, path] of [
    ['bucket', `${account}/r2/buckets/${manifest.r2Bucket}`],
    ['hyperdrive', `${account}/hyperdrive/configs/${manifest.hyperdriveID}`],
  ])
    await operation(`verify_${name}_absent`, async () => {
      const current = await api('GET', path);
      proof.remaining[name] = current.absent
        ? []
        : [name === 'bucket' ? manifest.r2Bucket : manifest.hyperdriveID];
      assert.equal(proof.remaining[name].length, 0);
    });
  await operation('verify_secrets_absent', async () => {
    const rows = await inventory(api, secretPath, result =>
      Array.isArray(result) ? result : result.secrets
    );
    proof.remaining.secrets = rows
      .filter(
        secret =>
          manifest.secretNames.includes(secret.name) ||
          manifest.secrets.some(owned => owned.id === secret.id)
      )
      .map(secret => ({ id: secret.id, name: secret.name }));
    assert.equal(proof.remaining.secrets.length, 0);
  });
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  assert(
    ['arm', 'now'].includes(mode) && file,
    'Usage: perf-teardown.mjs arm|now target-manifest.json'
  );
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  validateTarget(
    { runID: manifest.runID, baseURL: manifest.baseURL, stopAt: manifest.teardownAt },
    manifest
  );
  assert(
    manifest.wrangler.endsWith('/node_modules/.bin/wrangler'),
    'Use the repository-pinned operator binary'
  );
  assert(manifest.teardownAt > Date.now() - 900000 && manifest.teardownAt <= Date.now() + 900000);
  const deadline = manifest.teardownAt + manifest.teardownTailSeconds * 1000;
  const proof = { startedAt: Date.now(), deadline, operations: [], errors: [] };
  const save = () =>
    writeFileSync(manifest.teardownProofFile, JSON.stringify(proof, null, 2), { mode: 0o600 });
  const rawAPI = operatorAPI(() => resolveOperatorToken(manifest.wrangler, deadline), { deadline });
  const api = (method, path) => retryTransient(() => rawAPI(method, path), deadline);
  const cli = (args, options) => runOperatorCLI(manifest, args, deadline, options);
  if (mode === 'arm') {
    assert(
      !(await currentDeployment(manifest, api)).absent,
      'Cannot arm against absent deployment'
    );
    const ready = () => {
      const value = {
        runID: manifest.runID,
        workerName: manifest.workerName,
        deploymentID: manifest.deploymentID,
        versionID: manifest.versionID,
        instanceID: manifest.independentWatchdogID,
        pid: process.pid,
        heartbeatAt: Date.now(),
        teardownAt: manifest.teardownAt,
      };
      writeFileSync(manifest.watchdogReadyFile + '.tmp', JSON.stringify(value), { mode: 0o600 });
      renameSync(manifest.watchdogReadyFile + '.tmp', manifest.watchdogReadyFile);
    };
    save();
    ready();
    const heartbeat = setInterval(ready, 2000);
    const wake = new AbortController();
    process.once('SIGTERM', () => wake.abort());
    process.once('SIGINT', () => wake.abort());
    try {
      await sleep(Math.max(0, manifest.teardownAt - Date.now()), undefined, {
        signal: wake.signal,
      });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
  await cleanupOwned(manifest, api, cli, proof, save);
  proof.finishedAt = Date.now();
  proof.passed = proof.errors.length === 0 && proof.finishedAt <= deadline;
  save();
  console.log(
    JSON.stringify({
      operations: proof.operations.length,
      errors: proof.errors.length,
      finishedAt: proof.finishedAt,
      passed: proof.passed,
    })
  );
  process.exitCode = proof.passed ? 0 : 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

// Lets an STS deploy token, which holds no Secrets Store permission, deploy a Worker that binds the
// shared Secrets Store. Each STS deploy job of deploy-workers.yml runs it right before
// `wrangler deploy` (services/sts/README.md, "Cloudflare deploy tokens").
//
// Usage: node scripts/ci/inherit-secret-bindings.mjs <Worker config> <production|staging>
//
// The config is the file the deploy uses (wrangler.jsonc, or a generated JSON config), and the
// environment picks its top level (production) or its `env.staging` block, as `--env` does.
// Without Secrets Store bindings there it changes nothing and calls nothing. Otherwise it:
//
// 1. reads the Worker's most recently uploaded version with CLOUDFLARE_API_TOKEN (the STS deploy
//    token) and fails unless each committed binding is there unchanged (type, store and secret).
//    Cloudflare copies an inherited binding from exactly that version, and fails with 10057 when
//    the name is missing, so a new or changed Secrets Store binding, or a new Worker with one,
//    cannot ship this way: it ships with DEPLOY_TOKEN_SOURCE `secret`. A binding there that the
//    config no longer has passes: this deploy removes it.
// 2. rewrites the config's `secrets_store_secrets` into `unsafe.bindings` entries
//    `{ type: "inherit", name: <binding> }`, written back as JSON (comments go; the checkout is
//    the job's own).
//
// Kilo-Org/bouncer runs the same two steps as scripts (check-latest-bindings.mjs,
// inherit-secret-bindings.mjs). It prints binding names, the differing field and Cloudflare's
// error codes, never a value, a response body or the token. Every request goes to
// https://api.cloudflare.com; only the local tests set INHERIT_BINDINGS_TEST=1, which lets
// CLOUDFLARE_API_URL point at a stub, and the script refuses it inside GitHub Actions.

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { jsoncToJson } from '../jsonc.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const TIMEOUT_MS = 30_000;
const SECRETS_STORE = 'secrets_store_secret';
// The most versions one list page may hold, so the newest-first check sees as many as it can.
const PER_PAGE = 100;
const FIELDS = ['store_id', 'secret_name'];
const WORD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const objectAt = value => (isObject(value) ? value : {});
const arrayAt = value => (Array.isArray(value) ? value : []);

/** A binding name or type from Cloudflare's answer, printed only when it is a plain word. */
function word(value) {
  return typeof value === 'string' && WORD.test(value) ? value : '(not a plain name)';
}

function apiBase(env) {
  if (env.INHERIT_BINDINGS_TEST !== '1') return API;
  if (env.GITHUB_ACTIONS === 'true')
    throw new Error('INHERIT_BINDINGS_TEST is for local tests only');
  if (!env.CLOUDFLARE_API_URL) throw new Error('INHERIT_BINDINGS_TEST needs CLOUDFLARE_API_URL');
  return env.CLOUDFLARE_API_URL;
}

/**
 * The block the environment deploys (the top level, or `env.<environment>`), the Worker's
 * deployed name, its account, and its committed Secrets Store bindings. `secrets_store_secrets`
 * and `unsafe` are not inherited by a named environment, so only that block's own count.
 */
export function deployTarget(file, config, environment) {
  if (!isObject(config)) throw new Error(`${file}: the config is not an object`);
  let block = config;
  let worker = config.name;
  if (environment !== 'production') {
    block = objectAt(config.env)[environment];
    if (!isObject(block)) throw new Error(`${file}: no env.${environment} block`);
    worker = block.name ?? `${config.name}-${environment}`;
  }
  const accountId = block.account_id ?? config.account_id;
  if (typeof worker !== 'string' || !WORKER_NAME.test(worker)) {
    throw new Error(`${file}: no usable Worker name for ${environment}`);
  }
  if (!ACCOUNT_ID.test(String(accountId))) {
    throw new Error(`${file}: no account_id for ${environment}`);
  }
  if (block.secrets_store_secrets !== undefined && !Array.isArray(block.secrets_store_secrets)) {
    throw new Error(`${file}: secrets_store_secrets is not a list`);
  }
  const bindings = arrayAt(block.secrets_store_secrets).map((entry, index) => {
    const { binding, secret_name: secretName, store_id: storeId } = objectAt(entry);
    if ([binding, secretName, storeId].some(field => typeof field !== 'string' || field === '')) {
      throw new Error(
        `${file}: secrets_store_secrets[${String(index)}] needs binding, store_id and secret_name`
      );
    }
    return { name: binding, secret_name: secretName, store_id: storeId };
  });
  if (new Set(bindings.map(binding => binding.name)).size !== bindings.length) {
    throw new Error(`${file}: secrets_store_secrets: a binding name repeats`);
  }
  return { accountId, block, bindings, worker };
}

/**
 * The config with the block's `secrets_store_secrets` replaced by inherited bindings. Refuses a
 * config that already has `unsafe` anywhere: none does today, and merging into one could change
 * a binding this check never looked at.
 */
export function inheritedConfig(file, config, block, bindings) {
  const blocks = [config, ...Object.values(objectAt(config.env))];
  if (blocks.some(candidate => isObject(candidate) && candidate.unsafe !== undefined)) {
    throw new Error(`${file}: has an unsafe block; refusing to merge inherited bindings into it`);
  }
  delete block.secrets_store_secrets;
  block.unsafe = { bindings: bindings.map(binding => ({ name: binding.name, type: 'inherit' })) };
  return config;
}

/** Sends the GET; a network failure or timeout throws with its kind only. */
async function send(base, token, path) {
  try {
    return await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const kind = error instanceof Error ? error.name : 'error';
    throw new Error(`GET ${path}: Cloudflare is unreachable (${kind})`, { cause: error });
  }
}

/** The `result` of a successful Cloudflare GET; anything else throws with status and codes. */
async function get(base, token, path) {
  const response = await send(base, token, path);
  const body = await response.json().catch(() => null);
  if (response.ok && isObject(body) && body.success === true && isObject(body.result)) {
    return body.result;
  }
  const codes = arrayAt(objectAt(body).errors)
    .map(error => objectAt(error).code)
    .filter(code => Number.isInteger(code));
  const detail = codes.length > 0 ? `, Cloudflare error ${codes.join(', ')}` : '';
  throw new Error(`GET ${path}: HTTP ${String(response.status)}${detail}`);
}

/**
 * The most recently uploaded version: the first listed, which Cloudflare returns newest first.
 * Fails closed unless that version also has the highest number on the page, and on any item
 * without a version id and an integer number.
 */
function latestVersion(path, result) {
  const versions = arrayAt(result.items);
  if (versions.length === 0) throw new Error(`GET ${path}: no version listed`);
  const malformed = versions.findIndex(
    item => !VERSION_ID.test(String(objectAt(item).id)) || !Number.isInteger(objectAt(item).number)
  );
  if (malformed !== -1) {
    throw new Error(`GET ${path}: item ${String(malformed)} has no version id or integer number`);
  }
  const [first] = versions;
  if (versions.some(version => version.number > first.number)) {
    throw new Error(`GET ${path}: the list does not start with the newest version`);
  }
  return first;
}

/** One line per committed binding that the version's bindings do not carry unchanged. */
export function differences(file, expected, bindings) {
  return expected.flatMap(entry => {
    const found = bindings.find(binding => objectAt(binding).name === entry.name);
    if (found === undefined)
      return [`${entry.name}: missing there; inheriting it fails with 10057`];
    if (found.type !== SECRETS_STORE) {
      return [`${entry.name}: is a ${word(found.type)} binding there, not ${SECRETS_STORE}`];
    }
    return FIELDS.filter(field => found[field] !== entry[field]).map(
      field => `${entry.name}: ${field} differs from ${file}`
    );
  });
}

/** The bindings of the Worker's most recently uploaded version, and that version's label. */
async function latestBindings(base, token, { accountId, worker }) {
  const listPath = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker)}/versions`;
  const latest = latestVersion(
    listPath,
    await get(base, token, `${listPath}?per_page=${PER_PAGE}`)
  );
  const versionPath = `${listPath}/${encodeURIComponent(latest.id)}`;
  const version = await get(base, token, versionPath);
  const { bindings } = objectAt(version.resources);
  if (!Array.isArray(bindings))
    throw new TypeError(`GET ${versionPath}: no bindings in the answer`);
  return { bindings, where: `${worker} version ${String(latest.number)} (${latest.id})` };
}

async function main(args, env) {
  if (args.length !== 2 || !['production', 'staging'].includes(args[1])) {
    throw new Error(
      'usage: node scripts/ci/inherit-secret-bindings.mjs <Worker config> <production|staging>'
    );
  }
  const [file, environment] = args;
  let config;
  try {
    config = JSON.parse(jsoncToJson(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`${file}: cannot read it as JSONC`, { cause: error });
  }
  const target = deployTarget(file, config, environment);
  if (target.bindings.length === 0) {
    process.stdout.write(`${file}: no Secrets Store bindings for ${environment}; unchanged\n`);
    return;
  }
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const latest = await latestBindings(apiBase(env), env.CLOUDFLARE_API_TOKEN, target);
  const problems = differences(file, target.bindings, latest.bindings);
  if (problems.length > 0) {
    throw new Error(
      `${file}: the Secrets Store bindings differ from ${latest.where}; deploy this change with DEPLOY_TOKEN_SOURCE secret:\n${problems.join('\n')}`
    );
  }
  writeFileSync(
    file,
    `${JSON.stringify(inheritedConfig(file, config, target.block, target.bindings))}\n`
  );
  const names = target.bindings.map(binding => binding.name).join(', ');
  process.stdout.write(`${file}: ${environment} inherits ${names} from ${latest.where}\n`);
}

/** A GitHub error annotation; its message escapes `%`, CR and LF as workflow commands require. */
function annotation(message) {
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return `::error::${escaped}\n`;
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    process.stdout.write(annotation(error.message));
    process.exitCode = 1;
  }
}

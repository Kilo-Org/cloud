#!/usr/bin/env node

/**
 * KiloClaw Google Account Setup
 *
 * Docker-based tool that:
 * 1. Validates the user's session token (JWT) against the kiloclaw worker
 * 2. Fetches the worker's RSA public key for credential encryption
 * 3. Signs into gcloud, creates/selects a GCP project, enables APIs
 * 4. Prompts user to create a Desktop OAuth client in Cloud Console
 * 5. Runs gog auth (credentials set + add) to authorize all services
 * 6. Tarballs the gog config, encrypts, and POSTs to the worker
 *
 * Usage:
 *   docker run -it ghcr.io/kilo-org/google-setup --token=<jwt>
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const tokenArg = args.find(a => a.startsWith('--token='));
const token = tokenArg?.substring(tokenArg.indexOf('=') + 1);

const workerUrlArg = args.find(a => a.startsWith('--worker-url='));
const workerUrl = workerUrlArg
  ? workerUrlArg.substring(workerUrlArg.indexOf('=') + 1)
  : 'https://claw.kilosessions.ai';

const gmailPushWorkerUrlArg = args.find(a => a.startsWith('--gmail-push-worker-url='));
const gmailPushWorkerUrl = gmailPushWorkerUrlArg
  ? gmailPushWorkerUrlArg.substring(gmailPushWorkerUrlArg.indexOf('=') + 1)
  : 'https://kiloclaw-gmail.kiloapps.io';

if (!token) {
  console.error('Usage: docker run -it ghcr.io/kilo-org/google-setup --token=<session-jwt>');
  process.exit(1);
}

// Validate worker URL scheme — reject non-HTTPS except for localhost dev.
try {
  const parsed = new URL(workerUrl);
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    console.error(
      `Error: --worker-url must use HTTPS (got ${parsed.protocol}). HTTP is only allowed for localhost.`
    );
    process.exit(1);
  }
  if (workerUrl !== 'https://claw.kilosessions.ai') {
    console.warn(`Warning: using non-default worker URL: ${workerUrl}`);
  }
} catch {
  console.error(`Error: invalid --worker-url: ${workerUrl}`);
  process.exit(1);
}

const authHeaders = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

// APIs to enable in the GCP project
const GCP_APIS = [
  'gmail.googleapis.com',
  'calendar-json.googleapis.com',
  'drive.googleapis.com',
  'docs.googleapis.com',
  'slides.googleapis.com',
  'sheets.googleapis.com',
  'tasks.googleapis.com',
  'people.googleapis.com',
  'forms.googleapis.com',
  'chat.googleapis.com',
  'classroom.googleapis.com',
  'script.googleapis.com',
  'pubsub.googleapis.com',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    );
    child.on('error', reject);
  });
}

function runCommandOutput(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// ---------------------------------------------------------------------------
// Step 1: Validate session token
// ---------------------------------------------------------------------------

console.log('Validating session token...');

const validateRes = await fetch(`${workerUrl}/health`);
if (!validateRes.ok) {
  console.error('Cannot reach kiloclaw worker at', workerUrl);
  process.exit(1);
}

const authCheckRes = await fetch(`${workerUrl}/api/admin/google-credentials`, {
  headers: authHeaders,
});

if (!authCheckRes.ok) {
  if (authCheckRes.status === 401 || authCheckRes.status === 403) {
    console.error('Invalid or expired session token. Log in to kilo.ai and copy a fresh token.');
  } else {
    console.error(`Worker returned unexpected status ${authCheckRes.status} during auth check.`);
  }
  process.exit(1);
}

console.log('Session token verified.\n');

// ---------------------------------------------------------------------------
// Step 2: Fetch public key for encryption
// ---------------------------------------------------------------------------

console.log('Fetching encryption public key...');

const pubKeyRes = await fetch(`${workerUrl}/api/admin/public-key`, { headers: authHeaders });
if (!pubKeyRes.ok) {
  console.error('Failed to fetch public key from worker.');
  process.exit(1);
}

const { publicKey: publicKeyPem } = await pubKeyRes.json();

if (!publicKeyPem || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
  console.error('Invalid public key received from worker.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: Sign into gcloud and set up GCP project + APIs
// ---------------------------------------------------------------------------

console.log('Signing into Google Cloud...');
console.log('A browser window will open for you to sign in.\n');

await runCommand('gcloud', ['auth', 'login', '--brief']);

const gcloudAccount = runCommandOutput('gcloud', ['config', 'get-value', 'account']);
console.log(`\nSigned in as: ${gcloudAccount}\n`);

// Project selection: create new or use existing
console.log('Google Cloud project setup:');
console.log('  1. Create a new project (recommended)');
console.log('  2. Use an existing project\n');

const projectChoice = await ask('Choose (1 or 2): ');
let projectId;

if (projectChoice === '2') {
  // List existing projects as a numbered menu
  console.log('\nFetching your projects...');
  let projects = [];
  try {
    const projectsJson = runCommandOutput('gcloud', [
      'projects',
      'list',
      '--format=json(projectId,name)',
      '--sort-by=name',
    ]);
    projects = JSON.parse(projectsJson);
  } catch {
    // fall through — empty list triggers manual entry
  }

  if (projects.length > 0) {
    console.log('');
    projects.forEach((p, i) => {
      const label = p.name ? `${p.projectId} (${p.name})` : p.projectId;
      console.log(`  ${i + 1}. ${label}`);
    });
    console.log('');
    const pick = await ask('Enter number (or project ID): ');
    const idx = parseInt(pick, 10);
    if (idx >= 1 && idx <= projects.length) {
      projectId = projects[idx - 1].projectId;
    } else {
      projectId = pick;
    }
  } else {
    console.warn('Could not list projects. You can still enter a project ID manually.');
    projectId = await ask('\nEnter your project ID: ');
  }
} else {
  const defaultId = `kiloclaw-${crypto.randomBytes(4).toString('hex')}`;
  const inputId = await ask(`Project ID [${defaultId}]: `);
  projectId = inputId || defaultId;

  console.log(`\nCreating project "${projectId}"...`);
  try {
    execFileSync('gcloud', ['projects', 'create', projectId, '--set-as-default'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('Project created.\n');
  } catch (err) {
    const errOutput = err.stderr?.toString() ?? err.message;
    if (/terms/i.test(errOutput)) {
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  You need to accept the Google Cloud Terms of Service first.');
      console.log('');
      console.log('  Open: https://console.cloud.google.com');
      console.log('  Sign in and accept the terms, then come back here.');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      await ask('Press Enter when done...');
      try {
        execFileSync('gcloud', ['projects', 'create', projectId, '--set-as-default'], {
          stdio: 'inherit',
        });
        console.log('Project created.\n');
      } catch {
        console.error(`Failed to create project "${projectId}" after accepting terms.`);
        console.error('Try a different name, or choose option 2 to use an existing project.');
        process.exit(1);
      }
    } else {
      console.error(`Failed to create project "${projectId}". It may already exist.`);
      console.error(
        'You may also need to accept the Google Cloud Terms of Service at https://console.cloud.google.com'
      );
      console.error('Try a different name, or choose option 2 to use an existing project.');
      console.error(`\nRaw error:\n${errOutput}`);
      process.exit(1);
    }
  }
}

// Set as active project
await runCommand('gcloud', ['config', 'set', 'project', projectId]);
console.log(`\nUsing project: ${projectId}`);

// Enable APIs
console.log('\nEnabling Google APIs (this may take a minute)...');
await runCommand('gcloud', ['services', 'enable', ...GCP_APIS, `--project=${projectId}`]);
console.log('APIs enabled.\n');

// ---------------------------------------------------------------------------
// Step 4: Configure OAuth consent screen + create OAuth client
// ---------------------------------------------------------------------------

const consentUrl = `https://console.cloud.google.com/auth/overview?project=${projectId}`;
const credentialsUrl = `https://console.cloud.google.com/apis/credentials?project=${projectId}`;

const audienceUrl = `https://console.cloud.google.com/auth/audience?project=${projectId}`;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Configure OAuth consent screen');
console.log('');
console.log(`  1. Open: ${consentUrl}`);
console.log('  2. Click "Get started"');
console.log('  3. App name: "KiloClaw", User support email: your email');
console.log('  4. Audience: select "External"');
console.log('  5. Contact email: your email');
console.log('  6. Finish and click "Create"');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

await ask('Press Enter when done...');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Add yourself as a test user');
console.log('');
console.log(`  1. Open: ${audienceUrl}`);
console.log(`  2. Under "Test users", click "Add users"`);
console.log(`  3. Enter: ${gcloudAccount}`);
console.log('  4. Click "Save"');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

await ask('Press Enter when done...');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Create an OAuth client');
console.log('');
console.log(`  1. Open: ${credentialsUrl}`);
console.log('  2. Click "Create Credentials" → "OAuth client ID"');
console.log('  3. Application type: "Desktop app"');
console.log('  4. Click "Create"');
console.log('  5. Copy the Client ID and Client Secret below');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const clientId = await ask('Client ID: ');
const clientSecret = await ask('Client Secret: ');

if (!clientId || !clientSecret) {
  console.error('Client ID and Client Secret are required.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 5: Run gog auth to set credentials and authorize account
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs';

// plaintext is base64-encoded binary data, but cipher.update('utf8') is fine
// because base64 is a strict ASCII subset — no encoding ambiguity.
function encryptEnvelope(plaintext, pemKey) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedData = Buffer.concat([iv, encrypted, tag]);
  const encryptedDEK = crypto.publicEncrypt(
    { key: pemKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    dek
  );
  return {
    encryptedData: encryptedData.toString('base64'),
    encryptedDEK: encryptedDEK.toString('base64'),
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  };
}

const gogHome = '/tmp/gogcli-home';
// GOG_KEYRING_PASSWORD is NOT a secret. The 99designs/keyring file backend
// requires a password to operate, but gog runs inside a single-tenant VM
// with no shared access. The value is arbitrary — it just needs to be
// consistent across setup (here), container bootstrap (controller/src/bootstrap.ts),
// and runtime (controller/src/gog-credentials.ts).
const gogEnv = {
  ...process.env,
  HOME: gogHome,
  GOG_KEYRING_BACKEND: 'file',
  GOG_KEYRING_PASSWORD: 'kiloclaw',
};

// Build client_secret.json in Google's standard format and feed it to gog
const clientSecretJson = JSON.stringify({
  installed: {
    client_id: clientId,
    project_id: projectId,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_secret: clientSecret,
    redirect_uris: ['http://localhost'],
  },
});

// Write to temp file so gog can read it
const clientSecretPath = '/tmp/client_secret.json';
writeFileSync(clientSecretPath, clientSecretJson);

console.log('\nSetting up gog credentials...');

try {
  await runCommand('gog', ['auth', 'credentials', 'set', clientSecretPath], {
    env: gogEnv,
  });
} catch (err) {
  console.error('gog auth credentials set failed:', err.message);
  process.exit(1);
}

// Use the gcloud account email for gog auth add
const userEmail = gcloudAccount;
console.log(`\nAuthorizing ${userEmail} with gog...`);
console.log('You will need to open a URL in your browser to authorize Google Workspace access.\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  gog will print an authorization URL.');
console.log('  1. Open the URL in your browser');
console.log('  2. Google will warn "Google hasn\'t verified this app"');
console.log('     → Click "Continue"');
console.log('  3. Select ALL permissions (check every box)');
console.log('  4. Click "Continue"');
console.log('  5. Copy the redirect URL from your browser and paste it here');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

try {
  await runCommand(
    'gog',
    ['auth', 'add', userEmail, '--services=all', '--force-consent', '--manual'],
    {
      env: gogEnv,
    }
  );
} catch (err) {
  console.error('gog auth add failed:', err.message);
  process.exit(1);
}

console.log(`\nAuthenticated as: ${userEmail}`);

// Verify the account was actually stored before tarballing
console.log('Verifying credentials...');
try {
  const authList = execFileSync('gog', ['auth', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: gogEnv,
  }).trim();
  const parsed = JSON.parse(authList);
  const accounts = Array.isArray(parsed) ? parsed : (parsed.accounts ?? []);
  const found = accounts.some(a => a.email === userEmail || a.account === userEmail);
  if (!found) {
    throw new Error(`Account ${userEmail} not found in gog auth list`);
  }
  console.log('Credentials verified.\n');
} catch (err) {
  console.error(
    'Credential verification failed — the OAuth flow may not have completed correctly.'
  );
  console.error(err.message);
  console.error('Please re-run the setup and try again.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Gmail Pub/Sub setup (for push notifications)
// ---------------------------------------------------------------------------

console.log('\nSetting up Gmail push notifications...');

// Track whether push setup succeeded — used in the final summary message.
let pushSetupOk = true;

// Step 1: Create Pub/Sub topic (idempotent)
console.log('Creating Pub/Sub topic gog-gmail-watch...');
try {
  execSync('gcloud pubsub topics create gog-gmail-watch --quiet', {
    stdio: 'pipe',
  });
  console.log('Topic created.');
} catch (topicErr) {
  const topicOutput = topicErr.stderr?.toString() ?? topicErr.message;
  if (topicOutput.includes('ALREADY_EXISTS') || topicOutput.includes('already exists')) {
    console.log('Topic already exists (ok).');
  } else {
    console.error('Error: Could not create Pub/Sub topic. Gmail push notifications will not work.');
    console.error(topicOutput);
    pushSetupOk = false;
  }
}

// Step 2: Grant Gmail API push publisher role
console.log('Granting Gmail push publisher role...');
try {
  execSync(
    'gcloud pubsub topics add-iam-policy-binding gog-gmail-watch ' +
      '--member="serviceAccount:gmail-api-push@system.gserviceaccount.com" ' +
      '--role="roles/pubsub.publisher" --quiet',
    { stdio: 'pipe' }
  );
  console.log('Publisher role granted.');
} catch (err) {
  const errOutput = err.stderr?.toString() ?? err.message;
  if (errOutput.includes('allowedPolicyMemberDomains')) {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Your GCP organization restricts external service accounts.');
    console.log('  Gmail push notifications require this binding.');
    console.log('');
    console.log('  Fix it in the Cloud Console:');
    console.log(
      `  1. Open: https://console.cloud.google.com/iam-admin/orgpolicies/iam-allowedPolicyMemberDomains?project=${projectId}`
    );
    console.log('  2. Click "Manage Policy"');
    console.log('  3. Under "Policy source", select "Override parent\'s policy"');
    console.log('  4. Under "Policy enforcement", select "Replace"');
    console.log('  5. Click "Add a rule" → set to "Allow All"');
    console.log('  6. Click "Set Policy"');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    await ask('Press Enter when done...');
    try {
      execSync(
        'gcloud pubsub topics add-iam-policy-binding gog-gmail-watch ' +
          '--member="serviceAccount:gmail-api-push@system.gserviceaccount.com" ' +
          '--role="roles/pubsub.publisher" --quiet',
        { stdio: 'pipe' }
      );
      console.log('Publisher role granted.');
    } catch (retryErr) {
      console.error(
        'Error: Still could not grant publisher role. Gmail push notifications will not work.'
      );
      pushSetupOk = false;
    }
  } else {
    console.error('Error: Could not grant publisher role. Gmail push notifications will not work.');
    console.error(errOutput);
    pushSetupOk = false;
  }
}

// Step 3: Extract userId from JWT for the push subscription URL
let pushUserId;
try {
  const [, jwtPayload] = token.split('.');
  const claims = JSON.parse(Buffer.from(jwtPayload, 'base64url').toString());
  pushUserId = claims.kiloUserId ?? claims.sub;
} catch {
  // fall through
}

if (!pushUserId) {
  console.warn('Warning: Could not extract userId from token. Skipping Pub/Sub setup.');
  console.warn('Gmail push notifications will not work, but Google Workspace access will.');
  pushSetupOk = false;
}

let pushSaEmail = null;

if (pushUserId && pushSetupOk) {
  // Get GCP project ID for topic path and SA email
  const gcpProject = execSync('gcloud config get-value project', { encoding: 'utf8' }).trim();
  if (!gcpProject || gcpProject === '(unset)') {
    console.error('Error: No active GCP project. Run setup again from the beginning.');
    pushSetupOk = false;
  }

  // Create a project-level service account for Pub/Sub push OIDC auth.
  // Each user's GCP project gets its own SA — the worker validates
  // issuer + audience + SA email (stored in DO on credential upload).
  const pushSaName = 'gmail-push';
  pushSaEmail = `${pushSaName}@${gcpProject}.iam.gserviceaccount.com`;
  console.log(`Creating push auth service account ${pushSaEmail}...`);
  try {
    execSync(
      `gcloud iam service-accounts create ${pushSaName} ` +
        `--display-name="Gmail push notification auth" --quiet`,
      { stdio: 'pipe' }
    );
    console.log('Service account created.');
  } catch (saErr) {
    const saOutput = saErr.stderr?.toString() ?? saErr.message;
    if (saOutput.includes('already exists')) {
      console.log('Service account already exists (ok).');
    } else {
      console.error(
        'Error: Could not create push auth service account. Gmail push notifications will not work.'
      );
      console.error(saOutput);
      pushSetupOk = false;
    }
  }

  // Grant the Pub/Sub service agent permission to create OIDC tokens for the SA
  if (pushSetupOk) {
    console.log('Granting Pub/Sub token creator role...');
    try {
      const projectNumber = execSync(
        `gcloud projects describe ${gcpProject} --format="value(projectNumber)"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      execSync(
        `gcloud iam service-accounts add-iam-policy-binding ${pushSaEmail} ` +
          `--member="serviceAccount:service-${projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com" ` +
          `--role="roles/iam.serviceAccountTokenCreator" --quiet`,
        { stdio: 'pipe' }
      );
      console.log('Token creator role granted.');
    } catch (tokenErr) {
      console.error(
        'Error: Could not grant token creator role. Pub/Sub will not be able to sign push requests.'
      );
      console.error(tokenErr.stderr?.toString() ?? tokenErr.message);
      console.error('Gmail push notifications will not work.');
      pushSetupOk = false;
    }
  }

  // Create or update push subscription
  if (pushSetupOk) {
    const safeId = pushUserId.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
    const subscriptionName = `gog-gmail-push-${safeId.slice(0, 8)}`;
    const pushEndpoint = `${gmailPushWorkerUrl}/push/user/${encodeURIComponent(pushUserId)}`;
    // The OIDC audience must always use the production domain so the worker's
    // OIDC_AUDIENCE_BASE validation matches, even when the push endpoint
    // targets a different environment (e.g. tunnel, dev).
    const pushAudience = `https://kiloclaw-gmail.kiloapps.io/push/user/${encodeURIComponent(pushUserId)}`;
    console.log(`Creating push subscription ${subscriptionName} → ${pushEndpoint}`);
    try {
      execSync(
        `gcloud pubsub subscriptions create ${subscriptionName} ` +
          `--topic=gog-gmail-watch ` +
          `--push-endpoint="${pushEndpoint}" ` +
          `--push-auth-service-account="${pushSaEmail}" ` +
          `--push-auth-token-audience="${pushAudience}" ` +
          `--ack-deadline=30 --quiet`,
        { stdio: 'pipe' }
      );
      console.log('Push subscription created.');
    } catch (createErr) {
      const createOutput = createErr.stderr?.toString() ?? createErr.message;
      if (createOutput.includes('ALREADY_EXISTS') || createOutput.includes('already exists')) {
        // Subscription exists — update it
        try {
          execSync(
            `gcloud pubsub subscriptions update ${subscriptionName} ` +
              `--push-endpoint="${pushEndpoint}" ` +
              `--push-auth-service-account="${pushSaEmail}" ` +
              `--push-auth-token-audience="${pushAudience}" ` +
              `--quiet`,
            { stdio: 'pipe' }
          );
          console.log('Push subscription updated.');
        } catch (updateErr) {
          console.error(
            'Error: Could not update push subscription:',
            updateErr.stderr?.toString() ?? updateErr.message
          );
          pushSetupOk = false;
        }
      } else {
        console.error('Error: Could not create push subscription:');
        console.error(createOutput);
        pushSetupOk = false;
      }
    }
  }

  // Register Gmail watch
  if (pushSetupOk) {
    console.log('Registering Gmail watch...');
    try {
      execSync(
        `gog gmail watch start --account="${userEmail}" ` +
          `--topic="projects/${gcpProject}/topics/gog-gmail-watch"`,
        { stdio: 'inherit', env: gogEnv }
      );
      console.log('Gmail watch registered successfully.');
    } catch (err) {
      console.error('Error: Gmail watch registration failed:', err.message);
      console.error('Re-run the setup to retry.');
      pushSetupOk = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: Create config tarball, encrypt, and POST
// (After gmail watch start so watch state is included in the tarball)
// ---------------------------------------------------------------------------

console.log('\nCreating config tarball...');
const tarballBuffer = execSync(`tar czf - -C ${gogHome}/.config gogcli`, {
  maxBuffer: 1024 * 1024,
});
const tarballBase64 = tarballBuffer.toString('base64');

console.log(`Config tarball size: ${tarballBuffer.length} bytes`);

console.log('Encrypting config tarball...');

const encryptedBundle = {
  gogConfigTarball: encryptEnvelope(tarballBase64, publicKeyPem),
  email: userEmail,
  ...(pushSaEmail ? { gmailPushOidcEmail: pushSaEmail } : {}),
};

// ---------------------------------------------------------------------------
// POST encrypted credentials to worker
// ---------------------------------------------------------------------------

console.log('Sending credentials to your kiloclaw instance...');

const postRes = await fetch(`${workerUrl}/api/admin/google-credentials`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ googleCredentials: encryptedBundle }),
});

if (!postRes.ok) {
  const body = await postRes.text();
  console.error('Failed to store credentials:', body);
  process.exit(1);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Setup complete!');
console.log('');
console.log(`  Google account connected: ${userEmail}`);
console.log('  Your bot can now use Gmail, Calendar, Drive, Docs, Sheets, and more.');
console.log('');
console.log('  Next steps:');
console.log('  1. Redeploy your kiloclaw instance to activate Google services');
console.log('     Go to: https://app.kilo.ai/claw#settings');
if (pushSetupOk) {
  console.log('  2. Gmail push notifications have been enabled automatically.');
} else {
  console.log('  2. Gmail push notifications could not be set up (see errors above).');
  console.log('     Google Workspace access will still work. Re-run setup to retry.');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

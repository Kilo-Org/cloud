#!/usr/bin/env node

/**
 * KiloClaw Google Setup — Admin Mode
 *
 * For org admins who set up the GCP project, OAuth client, and push infra
 * once, then share credentials with org members.
 *
 * Usage:
 *   docker run -it ghcr.io/kilo-org/google-setup --admin
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ask, runCommand, runCommandOutput, GCP_APIS } from './shared.mjs';

// ---------------------------------------------------------------------------
// Step 1: Sign into gcloud
// ---------------------------------------------------------------------------

console.log('KiloClaw Google Setup — Admin Mode\n');
console.log('This will set up the GCP project and credentials for your organization.');
console.log('Members will run a separate, simpler command afterwards.\n');

if (!process.stdin.isTTY) {
  console.error('Error: stdin is not a TTY. This script requires an interactive terminal.');
  console.error('If running via Docker, make sure to use "docker run -it ..." (both -i and -t).');
  process.exit(1);
}

console.log('Signing into Google Cloud...');
console.log('You will be shown a URL to open in your browser. Sign in, copy the');
console.log('verification code back here, and press Enter.\n');

await runCommand('gcloud', ['auth', 'login', '--brief']);

const gcloudAccount = runCommandOutput('gcloud', ['config', 'get-value', 'account']);
console.log(`\nSigned in as: ${gcloudAccount}\n`);

// ---------------------------------------------------------------------------
// Step 2: Create or select GCP project
// ---------------------------------------------------------------------------

console.log('Google Cloud project setup:');
console.log('  1. Create a new project (recommended)');
console.log('  2. Use an existing project\n');

const projectChoice = await ask('Choose (1 or 2): ');
let projectId;

if (projectChoice === '2') {
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

// ---------------------------------------------------------------------------
// Step 3: Enable APIs
// ---------------------------------------------------------------------------

console.log('\nEnabling Google APIs (this may take a minute)...');
await runCommand('gcloud', ['services', 'enable', ...GCP_APIS, `--project=${projectId}`]);
console.log('APIs enabled.\n');

// ---------------------------------------------------------------------------
// Step 4: OAuth consent screen + client
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
// Step 5: Push notification infra (Pub/Sub topic, SA, IAM)
// ---------------------------------------------------------------------------

console.log('\nSetting up Gmail push notification infrastructure...');

let pushSetupOk = true;

// Create Pub/Sub topic
console.log('Creating Pub/Sub topic gog-gmail-watch...');
try {
  execFileSync('gcloud', ['pubsub', 'topics', 'create', 'gog-gmail-watch', '--quiet'], {
    stdio: 'pipe',
  });
  console.log('Topic created.');
} catch (topicErr) {
  const topicOutput = topicErr.stderr?.toString() ?? topicErr.message;
  if (topicOutput.includes('ALREADY_EXISTS') || topicOutput.includes('already exists')) {
    console.log('Topic already exists (ok).');
  } else {
    console.error('Error: Could not create Pub/Sub topic.');
    console.error(topicOutput);
    pushSetupOk = false;
  }
}

// Grant Gmail API push publisher role
if (pushSetupOk) {
  console.log('Granting Gmail push publisher role...');
  try {
    execFileSync(
      'gcloud',
      [
        'pubsub',
        'topics',
        'add-iam-policy-binding',
        'gog-gmail-watch',
        '--member=serviceAccount:gmail-api-push@system.gserviceaccount.com',
        '--role=roles/pubsub.publisher',
        '--quiet',
      ],
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
        execFileSync(
          'gcloud',
          [
            'pubsub',
            'topics',
            'add-iam-policy-binding',
            'gog-gmail-watch',
            '--member=serviceAccount:gmail-api-push@system.gserviceaccount.com',
            '--role=roles/pubsub.publisher',
            '--quiet',
          ],
          { stdio: 'pipe' }
        );
        console.log('Publisher role granted.');
      } catch {
        console.error('Error: Still could not grant publisher role.');
        pushSetupOk = false;
      }
    } else {
      console.error('Error: Could not grant publisher role.');
      console.error(errOutput);
      pushSetupOk = false;
    }
  }
}

// Create push auth service account
const pushSaName = 'gmail-push';
const pushSaEmail = `${pushSaName}@${projectId}.iam.gserviceaccount.com`;

if (pushSetupOk) {
  console.log(`Creating push auth service account ${pushSaEmail}...`);
  try {
    execFileSync(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'create',
        pushSaName,
        '--display-name=Gmail push notification auth',
        '--quiet',
      ],
      { stdio: 'pipe' }
    );
    console.log('Service account created.');
  } catch (saErr) {
    const saOutput = saErr.stderr?.toString() ?? saErr.message;
    if (saOutput.includes('already exists')) {
      console.log('Service account already exists (ok).');
    } else {
      console.error('Error: Could not create push auth service account.');
      console.error(saOutput);
      pushSetupOk = false;
    }
  }
}

// Grant Pub/Sub token creator role on the SA
if (pushSetupOk) {
  console.log('Granting Pub/Sub token creator role...');
  try {
    const projectNumber = execFileSync(
      'gcloud',
      ['projects', 'describe', projectId, '--format=value(projectNumber)'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    execFileSync(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'add-iam-policy-binding',
        pushSaEmail,
        `--member=serviceAccount:service-${projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`,
        '--role=roles/iam.serviceAccountTokenCreator',
        '--quiet',
      ],
      { stdio: 'pipe' }
    );
    console.log('Token creator role granted.');
  } catch (tokenErr) {
    console.error('Error: Could not grant token creator role.');
    console.error(tokenErr.stderr?.toString() ?? tokenErr.message);
    pushSetupOk = false;
  }
}

// ---------------------------------------------------------------------------
// Step 6: Add org members
// ---------------------------------------------------------------------------

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Add organization members');
console.log('');
console.log('  Enter the Google email addresses of members who will connect');
console.log('  their accounts. You can add more later by re-running with --admin.');
console.log('');
console.log('  Enter emails one per line, blank line when done:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const memberEmails = [];
while (true) {
  const email = await ask('Email (or Enter to finish): ');
  if (!email) break;
  memberEmails.push(email);
}

if (memberEmails.length > 0) {
  // Grant IAM roles for push subscription creation
  if (pushSetupOk) {
    console.log('\nGranting member permissions for push notifications...');
    for (const email of memberEmails) {
      console.log(`  ${email}:`);
      try {
        execFileSync(
          'gcloud',
          [
            'projects',
            'add-iam-policy-binding',
            projectId,
            `--member=user:${email}`,
            '--role=roles/pubsub.editor',
            '--quiet',
          ],
          { stdio: 'pipe' }
        );
        console.log('    Pub/Sub Editor granted');
      } catch (err) {
        console.error(`    Pub/Sub Editor failed: ${err.stderr?.toString() ?? err.message}`);
      }
      try {
        execFileSync(
          'gcloud',
          [
            'iam',
            'service-accounts',
            'add-iam-policy-binding',
            pushSaEmail,
            `--member=user:${email}`,
            '--role=roles/iam.serviceAccountUser',
            '--quiet',
          ],
          { stdio: 'pipe' }
        );
        console.log('    Service Account User granted');
      } catch (err) {
        console.error(`    Service Account User failed: ${err.stderr?.toString() ?? err.message}`);
      }
    }
  }

  // Instruct admin to add test users on consent screen
  const allEmails = [gcloudAccount, ...memberEmails];
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Add test users to the OAuth consent screen');
  console.log('');
  console.log(`  1. Open: ${audienceUrl}`);
  console.log('  2. Under "Test users", click "Add users"');
  console.log('  3. Add these emails:');
  for (const email of allEmails) {
    console.log(`     - ${email}`);
  }
  console.log('  4. Click "Save"');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  await ask('Press Enter when done...');
} else {
  // No members — just add admin as test user
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Add yourself as a test user');
  console.log('');
  console.log(`  1. Open: ${audienceUrl}`);
  console.log('  2. Under "Test users", click "Add users"');
  console.log(`  3. Enter: ${gcloudAccount}`);
  console.log('  4. Click "Save"');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  await ask('Press Enter when done...');
}

// ---------------------------------------------------------------------------
// Done — print member command
// ---------------------------------------------------------------------------

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Admin setup complete!');
console.log('');
console.log(`  Project: ${projectId}`);
console.log(`  OAuth Client ID: ${clientId}`);
if (pushSetupOk) {
  console.log('  Push notifications: configured');
} else {
  console.log('  Push notifications: not configured (see errors above)');
}
console.log('');
console.log('  Share this command with org members:');
console.log('');
console.log('  docker pull ghcr.io/kilo-org/google-setup:latest');
console.log('  docker run -it --network host ghcr.io/kilo-org/google-setup \\');
console.log('    --token=<THEIR_TOKEN> \\');
console.log(`    --client-id="${clientId}" \\`);
console.log(`    --client-secret="${clientSecret}" \\`);
console.log(`    --project-id="${projectId}" \\`);
console.log('    --instance-id=<ORG_INSTANCE_ID>');
console.log('');
console.log('  Each member needs their own --token from https://app.kilo.ai');
console.log('  and the <ORG_INSTANCE_ID> of the org KiloClaw instance to target');
console.log('  (visible in the Kilo web app). Without --instance-id, credentials');
console.log("  upload to the member's personal instance instead of the org.");
if (memberEmails.length > 0) {
  console.log('');
  console.log('  To add more members later, grant them access with:');
  console.log(
    `    gcloud projects add-iam-policy-binding ${projectId} --member="user:EMAIL" --role="roles/pubsub.editor"`
  );
  console.log(
    `    gcloud iam service-accounts add-iam-policy-binding ${pushSaEmail} --member="user:EMAIL" --role="roles/iam.serviceAccountUser"`
  );
  console.log('  Then add them as test users on the consent screen:');
  console.log(`    ${audienceUrl}`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

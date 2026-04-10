import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';

export const GCP_APIS = [
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

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    );
    child.on('error', reject);
  });
}

export function runCommandOutput(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

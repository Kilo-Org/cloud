import { createInterface } from 'readline';

export async function cliConfirm(message: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(`${message} (y/N): `, answer => {
      rl.close();

      const response = answer.trim().toLowerCase();

      if (response === 'y' || response === 'yes') {
        resolve();
      } else {
        console.log("Exiting because you didn't confirm");
        process.exit(0);
      }
    });
  });
}

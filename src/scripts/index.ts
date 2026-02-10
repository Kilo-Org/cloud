// Load environment variables before any other imports
import '../lib/load-env';

// get all folders in the src/scripts directory excluding './lib'
import { readdirSync } from 'fs';
import { join } from 'path';
import { closeAllDrizzleConnections } from '@/lib/drizzle';

// set this to true so other files can look & see if different config is needed
// primarily used in the database file to configure database connections
process.env.IS_SCRIPT = 'true';

const scriptsDir = join(__dirname, '../scripts');
const folders = readdirSync(scriptsDir, { withFileTypes: true })
  .filter(dir => dir.isDirectory() && dir.name !== 'lib')
  .map(dir => dir.name);

const args = process.argv.slice(2);

// if no arguments print out all available scripts by listing all folders
// and each file in the folder
if (args.length === 0) {
  console.log('Available scripts:');
  folders.forEach(folder => {
    console.log(`${folder}`);
    const files = readdirSync(join(scriptsDir, folder)).filter(
      file => file.endsWith('.ts') || file.endsWith('.js')
    );
    files.forEach(file => {
      console.log(`  ${file.replace('.ts', '')}`);
    });
  });
  process.exit(0);
}

// first arg is script folder, second is file name
const scriptFolder = args[0];
const scriptFile = `${args[1]}.ts`;

// if the file exports an async run function, call it
if (folders.includes(scriptFolder)) {
  const scriptPath = join(scriptsDir, scriptFolder, scriptFile);
  import(scriptPath)
    .then(async module => {
      if (module.run && typeof module.run === 'function') {
        // call run with args minus the two we used in this script
        const res = module.run(...args.slice(2));
        if (!res || !(res instanceof Promise)) {
          console.error(`The run function in ${scriptFile} must return a Promise.`);
          process.exit(1);
        }
        await res;
        // Close database pool after successful script completion
        await closeAllDrizzleConnections();
        process.exit(0);
      } else {
        console.error(`No run function found in ${scriptFile}`);
        process.exit(1);
      }
    })
    .catch(async err => {
      console.error(`Error running script ${scriptFile}:`, err);
      // Close database pool even on error
      try {
        await closeAllDrizzleConnections();
      } catch (closeErr) {
        console.error('Error closing database connections:', closeErr);
      }
      process.exit(1);
    });
} else {
  console.error(
    `Script folder ${scriptFolder} does not exist. Available folders: ${folders.join(', ')}`
  );
  process.exit(1);
}

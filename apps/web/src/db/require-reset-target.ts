/**
 * Applies the reset-target decision before the shared drizzle module chooses its connection.
 *
 * Must be imported after `./load-env` and before anything that imports
 * `@kilocode/web-shared/lib/drizzle`, because module evaluation follows import order and drizzle
 * reads `IS_SCRIPT` and the connection URL once, at load.
 */
import { refusalMessage, resolveResetTarget } from './reset-target';

const target = resolveResetTarget(process.env.POSTGRES_URL, process.env.POSTGRES_SCRIPT_URL);

if (target.kind === 'refuse') {
  console.error(refusalMessage(target));
  process.exit(1);
}

process.env.POSTGRES_SCRIPT_URL = target.scriptUrl;

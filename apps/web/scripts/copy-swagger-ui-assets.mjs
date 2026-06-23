import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const swaggerUiDist = require('swagger-ui-dist');

const swaggerUiVersion = '5.32.6';
const sourceDir = swaggerUiDist.getAbsoluteFSPath();
const destinationDir = new URL(
  `../public/api-docs/swagger-ui/${swaggerUiVersion}/`,
  import.meta.url
);

await mkdir(destinationDir, { recursive: true });

await Promise.all([
  copyFile(
    join(sourceDir, 'swagger-ui-bundle.js'),
    new URL('swagger-ui-bundle.js', destinationDir)
  ),
  copyFile(join(sourceDir, 'swagger-ui.css'), new URL('swagger-ui.css', destinationDir)),
]);

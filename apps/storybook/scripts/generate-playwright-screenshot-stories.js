import { readdir, readFile, mkdir, writeFile, copyFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Convert a string to camelCase
 */
function camelCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[A-Z]/, chr => chr.toLowerCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Sanitize a filename for use in file system
 */
function sanitizeFileName(str) {
  return str
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if a file is a screenshot (PNG)
 */
function isScreenshotFile(filename) {
  return filename.toLowerCase().endsWith('.png');
}

/**
 * Parse screenshot name to extract metadata
 * Our screenshots use simple names like "profile.png", "organizations.png"
 */
function parseScreenshotName(filename) {
  const name = basename(filename, '.png');

  // Convert "profile" -> "Profile", "cloud-chat" -> "Cloud Chat"
  const displayName = name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return {
    testSuite: 'Playwright Screenshots',
    testName: 'Top-Level Pages',
    screenshotName: camelCase(name),
    displayName: displayName,
    fileName: filename,
  };
}

/**
 * Find all Playwright screenshots
 */
async function findPlaywrightScreenshots() {
  const testResultsDir = join(__dirname, '../../test-results/screenshots');

  try {
    const files = await readdir(testResultsDir);
    const screenshots = files.filter(isScreenshotFile).map(file => ({
      path: join(testResultsDir, file),
      fileName: file,
      ...parseScreenshotName(file),
    }));

    return screenshots;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`⚠️  Screenshot directory not found: ${testResultsDir}`);
      console.warn('   Run Playwright tests first to generate screenshots.');
      return [];
    }
    throw error;
  }
}

/**
 * Create story content for a group of screenshots
 */
function createStoryContent(screenshots) {
  if (screenshots.length === 0) {
    return '';
  }

  let storyIndex = 1;
  const storyExports = [];

  // Generate a story export for each screenshot
  screenshots.forEach(screenshot => {
    const storyName = screenshot.displayName;
    const storyId = `Story${storyIndex}`;

    storyExports.push(`export const ${storyId} = {
  name: '${storyName}',
  render: () => (
    <div className="size-full flex items-center justify-center p-4">
      <img
        src="/screenshots/${screenshot.fileName}"
        alt="${storyName}"
        className="max-w-full h-auto"
        style={{ maxHeight: '80vh' }}
      />
    </div>
  ),
}`);

    storyIndex++;
  });

  // Generate complete TypeScript story file
  return `import type { Meta, StoryObj } from '@storybook/react';

const meta: Meta = {
  title: 'Playwright Screenshots/Top-Level Pages',
  parameters: {
    layout: 'fullscreen',
    disableChromaticDualThemeSnapshot: true,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

${storyExports.join('\n\n')}
`;
}

/**
 * Generate Storybook story files from screenshots
 */
async function generateScreenshotStories(screenshots) {
  if (screenshots.length === 0) {
    console.log('📸 No screenshots found. Skipping story generation.');
    return;
  }

  const storiesDir = join(__dirname, '../stories/generated');
  await mkdir(storiesDir, { recursive: true });

  // Create one story file for all screenshots
  const storyContent = createStoryContent(screenshots);
  const storyFileName = 'playwright-screenshots.stories.tsx';
  const storyFilePath = join(storiesDir, storyFileName);

  await writeFile(storyFilePath, storyContent);
  console.log(`✅ Generated story file: ${storyFileName} (${screenshots.length} screenshots)`);
}

/**
 * Copy screenshots to Storybook public directory
 */
async function copyScreenshotsToStorybook(screenshots) {
  if (screenshots.length === 0) {
    return;
  }

  const staticDir = join(__dirname, '../public/screenshots');
  await mkdir(staticDir, { recursive: true });

  await Promise.all(
    screenshots.map(async screenshot => {
      const destPath = join(staticDir, screenshot.fileName);
      await copyFile(screenshot.path, destPath);
    })
  );

  console.log(`✅ Copied ${screenshots.length} screenshot(s) to public/screenshots/`);
}

/**
 * Main function
 */
async function main() {
  console.log('📸 Generating Storybook stories from Playwright screenshots...\n');

  // Find all screenshots
  const screenshots = await findPlaywrightScreenshots();

  if (screenshots.length === 0) {
    console.log('⚠️  No screenshots found. Make sure to run Playwright tests first.');
    process.exit(0);
  }

  console.log(`📸 Found ${screenshots.length} screenshot(s)\n`);

  // Generate story files
  await generateScreenshotStories(screenshots);

  // Copy screenshots to Storybook public directory
  await copyScreenshotsToStorybook(screenshots);

  console.log('\n✅ Story generation complete!');
}

main().catch(error => {
  console.error('❌ Error generating stories:', error);
  process.exit(1);
});

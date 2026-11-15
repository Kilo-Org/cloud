import { z } from 'zod';

type MaybePromise<Value> = Promise<Value> | Value;

const permissionsGetAllSchema = z
  .object({
    data_collection: z.array(z.string()).optional(),
  })
  .loose();

type FirefoxPermissionsReader = () => MaybePromise<unknown>;

// eslint-disable-next-line unicorn/no-useless-undefined -- explicit unset sentinel
let firefoxPermissionsReader: FirefoxPermissionsReader | undefined = undefined;

/** Test-only seam for Firefox permission reads under Vitest (node, no chrome global). */
export const __setFirefoxPermissionsReaderForTests = (reader?: FirefoxPermissionsReader): void => {
  firefoxPermissionsReader = reader;
};

/* `wxt/browser` is imported lazily because Vitest runs these modules in node,
   where a static import of the WXT browser entrypoint fails to resolve. */
const readFirefoxPermissions = async (): Promise<z.infer<
  typeof permissionsGetAllSchema
> | null> => {
  const raw = await (async () => {
    if (firefoxPermissionsReader) {
      return firefoxPermissionsReader();
    }
    const { browser } = await import('wxt/browser');
    return browser.permissions.getAll();
  })();

  const parsed = permissionsGetAllSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const isTruthyEnvFlag = (value: unknown): boolean => value === true || value === 'true';

// Vite injects DEV; WXT injects FIREFOX as a boolean. Vitest stubs non-DEV keys as strings.
export const isDevBuild = (): boolean => isTruthyEnvFlag(import.meta.env.DEV);

export const isFirefoxBuild = (): boolean => isTruthyEnvFlag(import.meta.env.FIREFOX);

export const getFirefoxUsageDataGranted = async (): Promise<boolean> => {
  if (!isFirefoxBuild()) {
    return true;
  }

  const parsed = await readFirefoxPermissions();
  if (parsed === null) {
    return false;
  }

  const dataCollection = parsed.data_collection;
  if (dataCollection === undefined) {
    // Firefox < 140: no built-in data_collection consent surface.
    return false;
  }

  return dataCollection.includes('technicalAndInteraction');
};

type ExtensionVersionReader = () => MaybePromise<string | undefined>;

// eslint-disable-next-line unicorn/no-useless-undefined -- explicit unset sentinel
let extensionVersionReader: ExtensionVersionReader | undefined = undefined;

/** Test-only seam for the manifest version read under Vitest (node, no browser.runtime). */
export const __setExtensionVersionReaderForTests = (reader?: ExtensionVersionReader): void => {
  extensionVersionReader = reader;
};

const manifestVersionSchema = z.string().trim().min(1);

/**
 * Reads the shipped extension version for the `extension_version` super property.
 * Resolves `undefined` (property omitted) rather than failing startup when the
 * manifest is unreadable.
 */
export const readExtensionVersion = async (): Promise<string | undefined> => {
  try {
    const raw = await (async () => {
      if (extensionVersionReader) {
        return extensionVersionReader();
      }
      // Lazy for the same node/Vitest reason as readFirefoxPermissions.
      const { browser } = await import('wxt/browser');
      return browser.runtime.getManifest().version;
    })();

    const parsed = manifestVersionSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

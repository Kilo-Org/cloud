import { z } from 'zod';

import { type CatalogModel, GGUF_CATALOG } from './gguf-catalog';

const HF_ORIGIN = 'https://huggingface.co';
const HF_LIST = `${HF_ORIGIN}/api/models`;
const PAGE_SIZE = 20;

const REPO_ID = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** llama.rn loads one file; a model split across files cannot run. */
const SPLIT_FILE = /-\d{5}-of-\d{5}\.gguf$/i;
const PROJECTOR_FILE = /mmproj/i;
const QUANT =
  /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|TQ\d_\d|MXFP4(?:_MOE)?|BF16|FP16|F16|F32))(?=[-_.]|$)/i;

const count = z.number().nonnegative().default(0);
const entries = z.array(z.unknown());

const listedModel = z.object({
  id: z.string().regex(REPO_ID),
  downloads: count,
  likes: count,
  pipeline_tag: z.string().optional(),
  gguf: z.object({ total: z.number().positive().optional() }).optional(),
});

export type HfListedModel = {
  readonly id: string;
  readonly downloads: number;
  readonly likes: number;
  readonly parameters: number | undefined;
  readonly vision: boolean;
};

export type HfModelPage = {
  readonly models: readonly HfListedModel[];
  /** The next page as Hugging Face links it, or undefined on the last page. */
  readonly next: string | undefined;
};

const VISION_PIPELINE = 'image-text-to-text';

/**
 * GGUF repositories with a chat template, most downloaded first. A device
 * limit filters by parameter count on the server, so every page stays full.
 */
export function hfListUrl(input: {
  readonly search: string;
  readonly maxParameters: number | undefined;
}): string {
  const params = new URLSearchParams([
    ['filter', 'gguf'],
    ['filter', 'conversational'],
    ['sort', 'downloads'],
    ['direction', '-1'],
    ['limit', String(PAGE_SIZE)],
    ['expand[]', 'downloads'],
    ['expand[]', 'likes'],
    ['expand[]', 'pipeline_tag'],
    ['expand[]', 'gguf'],
  ]);
  const search = input.search.trim();
  if (search !== '') {
    params.set('search', search);
  }
  if (input.maxParameters !== undefined) {
    params.set('num_parameters', `min:0,max:${Math.floor(input.maxParameters)}`);
  }
  return `${HF_LIST}?${params.toString()}`;
}

/** Only a next link back to the same listing is followed. */
function nextPage(link: string | null): string | undefined {
  const target = link?.match(/<([^>]+)>\s*;\s*rel="next"/)?.[1];
  return target?.startsWith(`${HF_LIST}?`) === true ? target : undefined;
}

export function readModelPage(body: unknown, link: string | null): HfModelPage {
  const models: HfListedModel[] = [];
  for (const entry of entries.parse(body)) {
    const model = listedModel.safeParse(entry);
    if (model.success) {
      models.push({
        id: model.data.id,
        downloads: model.data.downloads,
        likes: model.data.likes,
        parameters: model.data.gguf?.total,
        vision: model.data.pipeline_tag === VISION_PIPELINE,
      });
    }
  }
  return { models, next: nextPage(link) };
}

export const hfRepoInfo = z.object({
  id: z.string().regex(REPO_ID),
  sha: z.string().regex(REVISION),
  gated: z.union([z.boolean(), z.string()]).default(false),
  downloads: count,
  likes: count,
  pipeline_tag: z.string().optional(),
  cardData: z
    .object({
      license: z.union([z.string(), z.array(z.string())]).optional(),
      license_name: z.string().optional(),
    })
    .optional(),
  gguf: z
    .object({
      total: z.number().positive().optional(),
      architecture: z.string().optional(),
      context_length: z.number().positive().optional(),
      chat_template: z.string().optional(),
    })
    .optional(),
});

const treeEntry = z.object({
  type: z.literal('file'),
  path: z.string().min(1),
  size: z.number().int().positive(),
  lfs: z.object({ oid: z.string().regex(SHA256) }),
});

type HfFile = { readonly path: string; readonly sizeBytes: number; readonly sha256: string };

/** One downloadable quantization: the file, its projector, and the pinned revision. */
export type HfQuant = {
  readonly label: string;
  readonly path: string;
  readonly model: CatalogModel;
};

export type HfModelDetail = {
  readonly id: string;
  readonly revision: string;
  /** A gated repository needs a Hugging Face account, which this app never holds. */
  readonly gated: boolean;
  readonly downloads: number;
  readonly likes: number;
  readonly license: string | undefined;
  readonly parameters: number | undefined;
  readonly architecture: string | undefined;
  readonly contextLength: number | undefined;
  /** The published chat template mentions tools; the download still verifies it. */
  readonly tools: boolean;
  readonly vision: boolean;
  readonly quants: readonly HfQuant[];
};

export const hfRepoUrl = (id: string) => `${HF_LIST}/${id}`;

export const hfTreeUrl = (id: string, revision: string) =>
  `${HF_LIST}/${id}/tree/${revision}?recursive=true`;
/** A route parameter names a repository only in Hugging Face's own id shape. */
export const isHfRepoId = (id: string) => REPO_ID.test(id);

const resolveUrl = (id: string, revision: string, path: string) =>
  `${HF_ORIGIN}/${id}/resolve/${revision}/${path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')}`;

export type HfRepoInfo = z.infer<typeof hfRepoInfo>;

/** SPDX ids a card may state, mapped to the license's own display name. */
const LICENSE_NAMES: Readonly<Record<string, string>> = {
  'agpl-3.0': 'AGPL 3.0',
  'apache-2.0': 'Apache 2.0',
  'bsd-2-clause': 'BSD 2-Clause',
  'bsd-3-clause': 'BSD 3-Clause',
  'cc-by-4.0': 'CC BY 4.0',
  'cc-by-sa-4.0': 'CC BY-SA 4.0',
  'cc0-1.0': 'CC0 1.0',
  'gpl-2.0': 'GPL 2.0',
  'gpl-3.0': 'GPL 3.0',
  'lgpl-2.1': 'LGPL 2.1',
  'lgpl-3.0': 'LGPL 3.0',
  llama2: 'Llama 2',
  llama3: 'Llama 3',
  'llama3.1': 'Llama 3.1',
  'llama3.2': 'Llama 3.2',
  'llama3.3': 'Llama 3.3',
  mit: 'MIT',
  'mpl-2.0': 'MPL 2.0',
  'qwen-research': 'Qwen Research',
  unlicense: 'Unlicense',
};

function licenseOf(card: HfRepoInfo['cardData']): string | undefined {
  const license = Array.isArray(card?.license) ? card.license[0] : card?.license;
  const named = license === 'other' ? (card?.license_name ?? license) : license;
  return named === undefined ? undefined : (LICENSE_NAMES[named.toLowerCase()] ?? named);
}

function quantOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? path;
  return QUANT.exec(name.slice(0, -'.gguf'.length))?.[1];
}

function quantLabel(path: string): string {
  const name = path.split('/').pop() ?? path;
  return quantOf(path) ?? name.slice(0, -'.gguf'.length);
}

/** Smallest first. */
function ggufFiles(tree: unknown): readonly HfFile[] {
  const files: HfFile[] = [];
  for (const entry of entries.parse(tree)) {
    const file = treeEntry.safeParse(entry);
    if (file.success && /\.gguf$/i.test(file.data.path) && !SPLIT_FILE.test(file.data.path)) {
      files.push({ path: file.data.path, sizeBytes: file.data.size, sha256: file.data.lfs.oid });
    }
  }
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes ships no Array.prototype.toSorted; the list is local
  return files.sort((a, b) => a.sizeBytes - b.sizeBytes);
}

/** The projector with the model's own quantization, else the smallest one. */
function projectorFor(label: string, projectors: readonly HfFile[]): HfFile | undefined {
  return (
    projectors.find(
      projector =>
        quantLabel(projector.path).localeCompare(label, 'en', { sensitivity: 'accent' }) === 0
    ) ?? projectors[0]
  );
}

/**
 * The model files, smallest first. When the repository names its
 * quantizations, a file without one is a draft model or an importance matrix,
 * not a quantization of the model.
 */
function quantFiles(files: readonly HfFile[]): readonly HfFile[] {
  const models = files.filter(file => !PROJECTOR_FILE.test(file.path));
  const named = models.filter(file => quantOf(file.path) !== undefined);
  return named.length > 0 ? named : models;
}

/** The bytes of the smallest quantization and its projector: the best fit the repository offers. */
export function smallestDownloadBytes(tree: unknown): number | undefined {
  const files = ggufFiles(tree);
  const [smallest] = quantFiles(files);
  if (smallest === undefined) {
    return undefined;
  }
  const projectors = files.filter(file => PROJECTOR_FILE.test(file.path));
  return smallest.sizeBytes + (projectorFor(quantLabel(smallest.path), projectors)?.sizeBytes ?? 0);
}

const CURATED = new Map(GGUF_CATALOG.map(model => [model.sha256, model]));

/** The repository name without the conventional GGUF suffix, read as words. */
export function hfModelName(id: string): string {
  const name = id.split('/').pop() ?? id;
  return name
    .replace(/[-_.]gguf$/i, '')
    .replaceAll(/-+/g, ' ')
    .trim();
}

/**
 * Every single-file quantization a repository offers, smallest first, each
 * pinned to the revision the tree was read at. The content hash names the
 * file on the device, so the same bytes are never downloaded twice, and a
 * file the pinned catalog already offers keeps the catalog's identity.
 */
export function readModelDetail(info: HfRepoInfo, tree: unknown): HfModelDetail {
  const files = ggufFiles(tree);
  const projectors = files.filter(file => PROJECTOR_FILE.test(file.path));
  const license = licenseOf(info.cardData);
  const name = hfModelName(info.id);
  const quants = quantFiles(files).map((file): HfQuant => {
    const label = quantLabel(file.path);
    const curated = CURATED.get(file.sha256);
    if (curated !== undefined) {
      return { label, path: file.path, model: curated };
    }
    const projector = projectorFor(label, projectors);
    return {
      label,
      path: file.path,
      model: {
        fileId: `hf-${file.sha256.slice(0, 16)}`,
        name: `${name} (${label})`,
        url: resolveUrl(info.id, info.sha, file.path),
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        license: license ?? '',
        ...(projector === undefined
          ? {}
          : {
              projector: {
                url: resolveUrl(info.id, info.sha, projector.path),
                sizeBytes: projector.sizeBytes,
                sha256: projector.sha256,
              },
            }),
      },
    };
  });
  return {
    id: info.id,
    revision: info.sha,
    gated: info.gated !== false,
    downloads: info.downloads,
    likes: info.likes,
    license,
    parameters: info.gguf?.total,
    architecture: info.gguf?.architecture,
    contextLength: info.gguf?.context_length,
    tools: info.gguf?.chat_template?.includes('tools') === true,
    vision: info.pipeline_tag === VISION_PIPELINE || projectors.length > 0,
    quants,
  };
}

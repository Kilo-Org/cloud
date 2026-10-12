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

function licenseOf(card: HfRepoInfo['cardData']): string | undefined {
  const license = Array.isArray(card?.license) ? card.license[0] : card?.license;
  return license === 'other' ? (card?.license_name ?? license) : license;
}

function quantLabel(path: string): string {
  const name = path.split('/').pop() ?? path;
  const stem = name.slice(0, -'.gguf'.length);
  return QUANT.exec(stem)?.[1]?.toUpperCase() ?? stem;
}

function ggufFiles(tree: unknown): readonly HfFile[] {
  const files: HfFile[] = [];
  for (const entry of entries.parse(tree)) {
    const file = treeEntry.safeParse(entry);
    if (
      file.success &&
      file.data.path.toLowerCase().endsWith('.gguf') &&
      !SPLIT_FILE.test(file.data.path)
    ) {
      files.push({ path: file.data.path, sizeBytes: file.data.size, sha256: file.data.lfs.oid });
    }
  }
  return files;
}

/** The projector with the model's own quantization, else the smallest one. */
function projectorFor(label: string, projectors: readonly HfFile[]): HfFile | undefined {
  return (
    projectors.find(projector => quantLabel(projector.path) === label) ??
    projectors.toSorted((a, b) => a.sizeBytes - b.sizeBytes)[0]
  );
}

const CURATED = new Map(GGUF_CATALOG.map(model => [model.sha256, model]));

/** The repository name without the conventional GGUF suffix. */
export function hfModelName(id: string): string {
  const name = id.split('/').pop() ?? id;
  return name.replace(/[-_.]gguf$/i, '');
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
  const quants = files
    .filter(file => !PROJECTOR_FILE.test(file.path))
    .toSorted((a, b) => a.sizeBytes - b.sizeBytes)
    .map((file): HfQuant => {
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

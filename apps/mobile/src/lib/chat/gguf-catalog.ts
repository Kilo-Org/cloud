/** One pinned file: the URL holds a Hugging Face revision, so the bytes behind it cannot change. */
export type CatalogFile = {
  readonly url: string;
  /** Checked exactly before the download is accepted. */
  readonly sizeBytes: number;
  /** The LFS hash Hugging Face publishes for that revision. */
  readonly sha256: string;
};

/**
 * A small instruct model the app offers to download. A vision model also
 * names its projector (mmproj), which downloads as part of the same model and
 * comes from the same repository and revision.
 */
export type CatalogModel = CatalogFile & {
  readonly fileId: string;
  readonly name: string;
  /** The license name as its publisher states it. A proper noun, not app copy. */
  readonly license: string;
  readonly projector?: CatalogFile;
};

export const GGUF_CATALOG: readonly CatalogModel[] = [
  {
    fileId: 'qwen2.5-0.5b-instruct-q4_k_m',
    name: 'Qwen2.5 0.5B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    sizeBytes: 491_400_032,
    sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
    license: 'Apache 2.0',
  },
  {
    fileId: 'llama-3.2-1b-instruct-q4_k_m',
    name: 'Llama 3.2 1B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/067b946cf014b7c697f3654f621d577a3e3afd1c/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 807_694_464,
    sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    license: 'Llama 3.2 Community License',
  },
  {
    fileId: 'qwen2.5-1.5b-instruct-q4_k_m',
    name: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 1_117_320_736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    license: 'Apache 2.0',
  },
  {
    fileId: 'smolvlm-500m-instruct-q8_0',
    name: 'SmolVLM 500M Instruct (Q8_0)',
    url: 'https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/72e986006ef53e37cdd3f6d4241c90b0f01df376/SmolVLM-500M-Instruct-Q8_0.gguf',
    sizeBytes: 436_806_912,
    sha256: '9d4612de6a42214499e301494a3ecc2be0abdd9de44e663bda63f1152fad1bf4',
    license: 'Apache 2.0',
    projector: {
      url: 'https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/72e986006ef53e37cdd3f6d4241c90b0f01df376/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf',
      sizeBytes: 108_783_360,
      sha256: 'd1eb8b6b23979205fdf63703ed10f788131a3f812c7b1f72e0119d5d81295150',
    },
  },
];

export type GgufUrlProblem = 'invalidUrl' | 'insecureUrl' | 'credentialsUrl' | 'notGguf';

export const GGUF_URL_ERROR_KEYS = {
  invalidUrl: 'modelChat.gguf.errors.invalidUrl',
  insecureUrl: 'modelChat.gguf.errors.insecureUrl',
  credentialsUrl: 'modelChat.gguf.errors.credentialsUrl',
  notGguf: 'modelChat.gguf.errors.notGguf',
} as const satisfies Record<GgufUrlProblem, string>;

class GgufUrlError extends Error {
  readonly problem: GgufUrlProblem;

  constructor(problem: GgufUrlProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** A direct download link that passed validation, and the model name its file gives. */
type GgufLink = { readonly url: string; readonly name: string };

export type GgufLinkResult =
  | { readonly ok: true; readonly value: GgufLink }
  | { readonly ok: false; readonly problem: GgufUrlProblem };

/** A direct download link: HTTPS only, no embedded credentials, and a `.gguf` file. */
export function readGgufLink(input: string): GgufLinkResult {
  try {
    return { ok: true, value: parseGgufUrl(input) };
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof GgufUrlError ? error.problem : 'invalidUrl',
    };
  }
}

/** A direct download link: HTTPS only, no embedded credentials, and a `.gguf` file. */
function parseGgufUrl(input: string): GgufLink {
  const url = asUrl(input);
  if (url === null) {
    throw new GgufUrlError('invalidUrl');
  }
  if (url.protocol !== 'https:') {
    throw new GgufUrlError(url.protocol === 'http:' ? 'insecureUrl' : 'invalidUrl');
  }
  if (url.hostname === '') {
    throw new GgufUrlError('invalidUrl');
  }
  if (url.username !== '' || url.password !== '') {
    throw new GgufUrlError('credentialsUrl');
  }
  const name = decoded(url.pathname.split('/').pop() ?? '');
  if (name === null) {
    throw new GgufUrlError('invalidUrl');
  }
  if (!name.toLowerCase().endsWith('.gguf') || name.length <= '.gguf'.length) {
    throw new GgufUrlError('notGguf');
  }
  return { url: url.href, name: name.slice(0, -'.gguf'.length) };
}

function asUrl(input: string): URL | null {
  try {
    return new URL(input.trim());
  } catch {
    return null;
  }
}

function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

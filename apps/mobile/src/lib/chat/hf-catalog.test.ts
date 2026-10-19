import { describe, expect, it } from 'vitest';

import { GGUF_CATALOG } from './gguf-catalog';
import {
  hfListUrl,
  hfRepoInfo,
  readModelDetail,
  readModelPage,
  smallestDownloadBytes,
} from './hf-catalog';

const REVISION = 'a'.repeat(40);
const sha = (digit: string) => digit.repeat(64);

const info = (overrides: Record<string, unknown> = {}) =>
  hfRepoInfo.parse({
    id: 'acme/Tiny-Chat-GGUF',
    sha: REVISION,
    gated: false,
    downloads: 1200,
    likes: 30,
    pipeline_tag: 'text-generation',
    cardData: { license: 'apache-2.0' },
    gguf: { total: 500_000_000, context_length: 32_768, chat_template: '{% if tools %}' },
    ...overrides,
  });

const file = (path: string, size: number, digit: string) => ({
  type: 'file',
  path,
  size,
  lfs: { oid: sha(digit), size },
});

describe('the Hugging Face model list', () => {
  it('asks for chat GGUF repositories, most downloaded first, within a parameter limit', () => {
    const url = new URL(hfListUrl({ search: ' qwen ', maxParameters: 4_500_000_000.7 }));
    expect(url.origin).toBe('https://huggingface.co');
    expect(url.searchParams.getAll('filter')).toEqual(['gguf', 'conversational']);
    expect(url.searchParams.get('sort')).toBe('downloads');
    expect(url.searchParams.get('search')).toBe('qwen');
    expect(url.searchParams.get('num_parameters')).toBe('min:0,max:4500000000');
    expect(
      new URL(hfListUrl({ search: '', maxParameters: undefined })).searchParams.has('search')
    ).toBe(false);
  });

  it('keeps the valid entries and follows only a next link back to the listing', () => {
    const next = 'https://huggingface.co/api/models?filter=gguf&cursor=abc';
    const page = readModelPage(
      [
        {
          id: 'acme/Tiny-Chat-GGUF',
          downloads: 10,
          likes: 2,
          pipeline_tag: 'image-text-to-text',
          gguf: { total: 1e9 },
        },
        { id: '../../etc', downloads: 1 },
        { id: 'acme/Odd-GGUF', downloads: 'many' },
        { id: 'acme/Bare-GGUF' },
      ],
      `<${next}>; rel="next"`
    );
    expect(page.models).toEqual([
      { id: 'acme/Tiny-Chat-GGUF', downloads: 10, likes: 2, parameters: 1e9, vision: true },
      { id: 'acme/Bare-GGUF', downloads: 0, likes: 0, parameters: undefined, vision: false },
    ]);
    expect(page.next).toBe(next);
    expect(readModelPage([], '<https://evil.example/api/models?x=1>; rel="next"').next).toBe(
      undefined
    );
  });

  it('rejects a body that is not a list', () => {
    expect(() => readModelPage({ error: 'rate limited' }, null)).toThrow();
  });
});

describe('a Hugging Face model detail', () => {
  it('offers each single-file quantization pinned to the revision, smallest first', () => {
    const detail = readModelDetail(info(), [
      { type: 'file', path: 'README.md', size: 10, oid: 'x' },
      file('Tiny-Chat-Q8_0.gguf', 560_000_000, '1'),
      file('Tiny-Chat-Q4_K_M.gguf', 320_000_000, '2'),
      file('big/Tiny-Chat-F16-00001-of-00002.gguf', 5000, '3'),
      { type: 'directory', path: 'big', size: 0 },
    ]);
    expect(detail.quants.map(quant => quant.label)).toEqual(['Q4_K_M', 'Q8_0']);
    expect(detail.quants[0]?.model).toEqual({
      fileId: `hf-${'2'.repeat(16)}`,
      name: 'Tiny Chat (Q4_K_M)',
      url: `https://huggingface.co/acme/Tiny-Chat-GGUF/resolve/${REVISION}/Tiny-Chat-Q4_K_M.gguf`,
      sizeBytes: 320_000_000,
      sha256: sha('2'),
      license: 'apache-2.0',
    });
    expect(detail).toMatchObject({
      revision: REVISION,
      gated: false,
      tools: true,
      vision: false,
      contextLength: 32_768,
    });
  });

  it('pairs each quantization of a vision model with a projector', () => {
    const detail = readModelDetail(info({ pipeline_tag: 'image-text-to-text' }), [
      file('Vis-Q4_K_M.gguf', 320_000_000, '1'),
      file('Vis-Q8_0.gguf', 560_000_000, '2'),
      file('mmproj-Vis-F16.gguf', 300_000_000, '3'),
      file('mmproj-Vis-Q8_0.gguf', 200_000_000, '4'),
    ]);
    expect(detail.vision).toBe(true);
    expect(detail.quants.map(quant => [quant.label, quant.model.projector?.sha256])).toEqual([
      ['Q4_K_M', sha('4')],
      ['Q8_0', sha('4')],
    ]);
  });

  it('offers no draft model beside the named quantizations', () => {
    const detail = readModelDetail(info(), [
      file('Big-27B-FastMTP-32K.gguf', 903_453_952, '1'),
      file('Big-27B-IQ2_M.gguf', 10_319_906_944, '2'),
    ]);
    expect(detail.quants.map(quant => quant.label)).toEqual(['IQ2_M']);
  });

  it('drops an auxiliary file whose quantization name would rescue it', () => {
    const detail = readModelDetail(info({ gguf: { total: 27_000_000_000 } }), [
      file('mtp-Aux-27B-Q4_0.gguf', 1_680_271_776, '1'),
      file('dflash-Aux-27B-Q4_0.gguf', 1_094_346_080, '2'),
      file('imatrix-27B.gguf', 13_642_656, '3'),
      file('imatrix_unsloth.gguf', 13_642_656, '4'),
      file('mtp_Aux-27B-Q4_0.gguf', 1_680_271_776, '5'),
      file('draft-27B-Q4_0.gguf', 2_500_000_000, '6'),
      file('Aux-27B-embedding-F16.gguf', 1_500_000_000, '7'),
      file('Aux-27B-embeddings.gguf', 1_500_000_000, '8'),
    ]);
    expect(detail.quants).toEqual([]);
    expect(detail.hasGgufFiles).toBe(true);
  });

  it('keeps a quantization of an embedding model named with a version or size', () => {
    const detail = readModelDetail(info({ gguf: { total: 8_000_000_000 } }), [
      file('Qwen3-Embedding-8B-Q8_0.gguf', 8_100_000_000, '1'),
      file('jina-embeddings-v3-Q8_0.gguf', 8_100_000_000, '2'),
    ]);
    expect(detail.quants.map(quant => quant.label)).toEqual(['Q8_0', 'Q8_0']);
  });

  it('drops an auxiliary embedding file that carries a quantization suffix', () => {
    const detail = readModelDetail(info(), [
      file('Aux-27B-embedding-F16.gguf', 1_500_000_000, '1'),
    ]);
    expect(detail.quants).toEqual([]);
    expect(detail.hasGgufFiles).toBe(true);
  });

  it('drops an auxiliary embedding file when the repository states no parameter count', () => {
    const detail = readModelDetail(info({ gguf: { context_length: 32_768 } }), [
      file('model-embeddings-Q8_0.gguf', 900, '1'),
      file('ggml-model.gguf', 500, '2'),
    ]);
    expect(detail.quants.map(quant => quant.label)).toEqual(['ggml-model']);
  });

  it('drops a file far smaller than its quantization needs for the stated parameters', () => {
    const detail = readModelDetail(info({ gguf: { total: 27_000_000_000 } }), [
      file('Model-27B-Q4_0.gguf', 1_610_000_000, '1'),
      file('Model-27B-Q4_K_M.gguf', 17_000_000_000, '2'),
    ]);
    expect(detail.quants.map(quant => quant.label)).toEqual(['Q4_K_M']);
  });

  it('keeps every quantization of a repository that states no parameter count', () => {
    const detail = readModelDetail(info({ gguf: { context_length: 32_768 } }), [
      file('Model-Q4_0.gguf', 1_610_000_000, '1'),
      file('Model-Q4_K_M.gguf', 17_000_000_000, '2'),
    ]);
    expect(detail.quants.map(quant => quant.label)).toEqual(['Q4_0', 'Q4_K_M']);
  });

  it('shows nothing runnable when only sharded files and a stray small file remain', () => {
    const detail = readModelDetail(info({ gguf: { total: 27_000_000_000 } }), [
      file('Model-27B-Q4_K_M-00001-of-00002.gguf', 9_000_000_000, '1'),
      file('Model-27B-Q4_K_M-00002-of-00002.gguf', 8_000_000_000, '2'),
      file('mtp-Model-27B-Q4_0.gguf', 1_680_271_776, '3'),
    ]);
    expect(detail.quants).toEqual([]);
    expect(detail.hasGgufFiles).toBe(true);
  });

  it('offers nothing runnable when sharded files leave only an unlabeled draft', () => {
    const detail = readModelDetail(info({ gguf: { total: 27_000_000_000 } }), [
      file('Model-27B-Q4_K_M-00001-of-00002.gguf', 9_000_000_000, '1'),
      file('Model-27B-Q4_K_M-00002-of-00002.gguf', 8_000_000_000, '2'),
      file('Big-27B-FastMTP-32K.gguf', 903_453_952, '3'),
    ]);
    expect(detail.quants).toEqual([]);
    expect(
      smallestDownloadBytes(
        [
          file('Model-27B-Q4_K_M-00001-of-00002.gguf', 9_000_000_000, '1'),
          file('Model-27B-Q4_K_M-00002-of-00002.gguf', 8_000_000_000, '2'),
          file('Big-27B-FastMTP-32K.gguf', 903_453_952, '3'),
        ],
        27_000_000_000
      )
    ).toBe(undefined);
  });

  it('says a repository without GGUF files has none', () => {
    const detail = readModelDetail(info(), [
      { type: 'file', path: 'README.md', size: 10, oid: 'x' },
    ]);
    expect(detail.quants).toEqual([]);
    expect(detail.hasGgufFiles).toBe(false);
  });

  it('still offers a file without a quantization name when no file has one', () => {
    const detail = readModelDetail(info(), [file('ggml-model.gguf', 500, '1')]);
    expect(detail.quants.map(quant => quant.label)).toEqual(['ggml-model']);
  });

  it('keeps the pinned catalog identity for a file the catalog already offers', () => {
    const [pinned] = GGUF_CATALOG;
    if (pinned === undefined) {
      throw new Error('the catalog is empty');
    }
    const detail = readModelDetail(info(), [
      {
        ...file('qwen2.5-0.5b-instruct-q4_k_m.gguf', pinned.sizeBytes, '0'),
        lfs: { oid: pinned.sha256 },
      },
    ]);
    expect(detail.quants[0]?.model).toBe(pinned);
  });

  it('marks a gated repository and names a custom license', () => {
    const detail = readModelDetail(
      info({ gated: 'manual', cardData: { license: 'other', license_name: 'acme-license' } }),
      []
    );
    expect(detail.gated).toBe(true);
    expect(detail.license).toBe('acme-license');
    expect(detail.quants).toEqual([]);
  });

  it('rejects a repository without a pinned revision', () => {
    expect(() => hfRepoInfo.parse({ id: 'acme/x', sha: 'main' })).toThrow();
  });
});

describe('the size a list entry is rated by', () => {
  it('is the smallest quantization, not a smaller draft model', () => {
    expect(
      smallestDownloadBytes(
        [
          file('Big-27B-FastMTP-32K.gguf', 903_453_952, '1'),
          file('Big-27B-Q4_K_P.gguf', 17_923_393_664, '2'),
          file('Big-27B-IQ2_M.gguf', 10_319_906_944, '3'),
        ],
        27_000_000_000
      )
    ).toBe(10_319_906_944);
  });

  it('is unknown when every single file is auxiliary or implausibly small', () => {
    expect(
      smallestDownloadBytes(
        [
          file('Model-27B-Q4_K_M-00001-of-00002.gguf', 9_000_000_000, '1'),
          file('Model-27B-Q4_K_M-00002-of-00002.gguf', 8_000_000_000, '2'),
          file('mtp-Model-27B-Q4_0.gguf', 1_680_271_776, '3'),
          file('Model-27B-Q8_0.gguf', 100_000_000, '4'),
        ],
        27_000_000_000
      )
    ).toBe(undefined);
  });

  it('adds the projector the smallest quantization downloads with', () => {
    expect(
      smallestDownloadBytes([
        file('Vis-Q4_K_M.gguf', 500, '1'),
        file('mmproj-Vis-F16.gguf', 300, '2'),
        file('mmproj-Vis-Q4_K_M.gguf', 100, '3'),
      ])
    ).toBe(600);
  });

  it('is unknown for a repository with only split files', () => {
    expect(smallestDownloadBytes([file('Big-Q4_K_M-00001-of-00002.gguf', 500, '1')])).toBe(
      undefined
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { resolveContinueRemoteModel } from './continuation-seed';

vi.mock('lucide-react-native', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

const CATALOG = [
  { id: 'model-a', variants: ['v1', 'v2'] },
  { id: 'model-b', variants: [] },
  { id: 'model-c', variants: ['latest'] },
];

describe('resolveContinueRemoteModel', () => {
  it('returns the model and variant when both are in the catalog', () => {
    expect(resolveContinueRemoteModel('model-a', 'v1', CATALOG)).toEqual({
      model: 'model-a',
      variant: 'v1',
    });
  });

  it('returns the model and empty variant when variant is empty and model is in catalog', () => {
    expect(resolveContinueRemoteModel('model-a', '', CATALOG)).toEqual({
      model: 'model-a',
      variant: '',
    });
  });

  it('returns empty when the model is not in the catalog', () => {
    expect(resolveContinueRemoteModel('model-unknown', 'v1', CATALOG)).toEqual({
      model: '',
      variant: '',
    });
  });

  it('returns empty when the variant is not in the model variant list', () => {
    expect(resolveContinueRemoteModel('model-a', 'v99', CATALOG)).toEqual({
      model: '',
      variant: '',
    });
  });

  it('returns empty when the catalog is empty', () => {
    expect(resolveContinueRemoteModel('model-a', 'v1', [])).toEqual({
      model: '',
      variant: '',
    });
  });

  it('returns the model when variant is empty and model has no variants', () => {
    expect(resolveContinueRemoteModel('model-b', '', CATALOG)).toEqual({
      model: 'model-b',
      variant: '',
    });
  });

  it('returns empty when variant is non-empty but model has no variants', () => {
    expect(resolveContinueRemoteModel('model-b', 'any', CATALOG)).toEqual({
      model: '',
      variant: '',
    });
  });

  it('returns empty model and variant when both are empty strings (empty-source behavior)', () => {
    expect(resolveContinueRemoteModel('', '', CATALOG)).toEqual({
      model: '',
      variant: '',
    });
  });
});

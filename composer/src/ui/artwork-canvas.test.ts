import { describe, expect, it } from 'vitest';
import { artworkRenderKey } from './artwork-canvas';

const visual = {
  points: Array.from({ length: 8 }, (_, index) => ({
    x: index,
    y: index * 2,
    z: index * 3,
  })),
  render: { radius: 1 },
  parameterSchema: {},
  params: {},
};

describe('artworkRenderKey', () => {
  it('keeps an immutable revision stable across streamed object updates', () => {
    expect(artworkRenderKey({ ...visual, revisionId: 'revision-1' })).toBe(
      artworkRenderKey({ ...visual, revisionId: 'revision-1' }),
    );
  });

  it('changes when the displayed revision changes', () => {
    expect(artworkRenderKey({ ...visual, revisionId: 'revision-1' })).not.toBe(
      artworkRenderKey({ ...visual, revisionId: 'revision-2' }),
    );
  });

  it('changes when runtime params change within the same revision', () => {
    expect(artworkRenderKey({
      ...visual,
      params: { radius: 4, turns: 7 },
      revisionId: 'revision-1',
    })).not.toBe(artworkRenderKey({
      ...visual,
      params: { turns: 7, radius: 5 },
      revisionId: 'revision-1',
    }));
    expect(artworkRenderKey({
      ...visual,
      params: { radius: 4, turns: 7 },
      revisionId: 'revision-1',
    })).toBe(artworkRenderKey({
      ...visual,
      params: { turns: 7, radius: 4 },
      revisionId: 'revision-1',
    }));
  });

  it('uses program and legacy identities when no revision id exists', () => {
    expect(artworkRenderKey({ ...visual, code: 'async () => {}' })).toBe(
      'code:async () => {}|params:[]',
    );
    expect(artworkRenderKey({ ...visual, revision: 3 })).toBe(
      'legacy:3|params:[]',
    );
    expect(artworkRenderKey(visual)).toBeUndefined();
  });
});

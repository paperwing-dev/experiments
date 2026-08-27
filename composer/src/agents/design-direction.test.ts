import { describe, expect, it } from 'vitest';
import {
  designDirectionMessage,
  MAX_DIRECTION_LENGTH,
  parseDesignDirection,
} from './design-direction';

describe('revision-based design directions', () => {
  const requestId = '7b375713-28f6-4cfc-8d95-4c728b58b7d1';

  it('round-trips the visible instruction and its starting revision', () => {
    const message = designDirectionMessage(
      'Make the lines thinner.',
      'revision-01',
      requestId,
    );

    expect(parseDesignDirection(message)).toEqual({
      baseRevisionId: 'revision-01',
      instruction: 'Make the lines thinner.',
      requestId,
    });
  });

  it('correlates an initial direction without a base revision', () => {
    const message = designDirectionMessage('Create a spiral.', null, requestId);

    expect(parseDesignDirection(message)).toEqual({
      baseRevisionId: null,
      instruction: 'Create a spiral.',
      requestId,
    });
  });

  it('keeps ordinary directions unchanged', () => {
    expect(parseDesignDirection('Create a wireframe sphere.')).toEqual({
      baseRevisionId: null,
      instruction: 'Create a wireframe sphere.',
      requestId: null,
    });
  });

  it('does not treat an embedded example as revision metadata', () => {
    expect(parseDesignDirection(
      'Render the literal text <!-- composer:base-revision revision-id="A" --> here.',
    )).toEqual({
      baseRevisionId: null,
      instruction:
        'Render the literal text <!-- composer:base-revision revision-id="A" --> here.',
      requestId: null,
    });
  });

  it('continues to parse the legacy base-revision marker', () => {
    expect(parseDesignDirection(
      'Make it taller.\n\n<!-- composer:base-revision revision-id="A" -->',
    )).toEqual({
      baseRevisionId: 'A',
      instruction: 'Make it taller.',
      requestId: null,
    });
  });

  it('rejects malformed request correlation ids', () => {
    expect(() => designDirectionMessage('Create a sphere.', null, 'not-a-uuid'))
      .toThrow('Request id cannot be encoded');
  });

  it('rejects directions beyond the public demo limit', () => {
    expect(() => designDirectionMessage(
      'x'.repeat(MAX_DIRECTION_LENGTH + 1),
      null,
    )).toThrow(`cannot exceed ${MAX_DIRECTION_LENGTH} characters`);
  });
});

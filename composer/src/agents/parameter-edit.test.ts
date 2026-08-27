import { describe, expect, it } from 'vitest';
import {
  appendRevision,
  createDesignHistory,
  currentRevision,
  undoRevision,
} from '../history/design-history';
import {
  PARAMETER_EDIT_SIGNAL,
  commitParameterEditRevision,
  isMatchingParameterEditRevision,
  parameterEditSignal,
  parseParameterEditSignal,
} from './parameter-edit';

const payload = {
  baseRevisionId: 'revision-1',
  parameterId: 'overall_radius',
  requestId: '7b375713-28f6-4cfc-8d95-4c728b58b7d1',
  value: 4.5,
};

describe('parameter edit signal', () => {
  it('round-trips the strict scalar edit payload', () => {
    expect(parseParameterEditSignal(parameterEditSignal(payload))).toEqual(payload);
  });

  it('ignores unrelated deliveries', () => {
    expect(parseParameterEditSignal({
      kind: 'signal',
      type: 'composer.other',
      body: '{}',
    })).toBeNull();
    expect(parseParameterEditSignal({ kind: 'user', body: 'hello' })).toBeNull();
  });

  it.each([
    ['bad json', '{'],
    ['extra properties', JSON.stringify({ ...payload, code: 'do not trust me' })],
    ['bad request id', JSON.stringify({ ...payload, requestId: 'request-1' })],
    ['bad revision id', JSON.stringify({ ...payload, baseRevisionId: '../A' })],
    ['bad parameter id', JSON.stringify({ ...payload, parameterId: 'Radius' })],
    ['non-finite value', JSON.stringify({ ...payload, value: 'Infinity' })],
  ])('rejects %s', (_label, body) => {
    expect(() => parseParameterEditSignal({
      kind: 'signal',
      type: PARAMETER_EDIT_SIGNAL,
      body,
    })).toThrow();
  });

  it('recognizes only an idempotent revision for the same base and values', () => {
    const parameterSchema = {
      overall_radius: {
        type: 'number' as const,
        label: 'Overall radius',
        default: 3,
        min: 1,
        max: 5,
        step: 0.5,
      },
    };
    const base = {
      id: 'revision-1',
      parentId: null,
      kind: 'initial' as const,
      code: 'async ({ params }) => ({ params })',
      params: { overall_radius: 3 },
      parameterSchema,
      instruction: 'Create a coil.',
      createdAt: 1,
    };
    const edit = {
      ...base,
      id: payload.requestId,
      parentId: base.id,
      kind: 'parameter-edit' as const,
      params: { overall_radius: 4.5 },
      instruction: 'Adjust Overall radius.',
      createdAt: 2,
    };

    expect(isMatchingParameterEditRevision(
      edit,
      base,
      edit.params,
    )).toBe(true);
    expect(isMatchingParameterEditRevision(
      { ...edit, code: 'async () => ({})' },
      base,
      edit.params,
    )).toBe(false);
    expect(isMatchingParameterEditRevision(
      edit,
      base,
      { overall_radius: 4 },
    )).toBe(false);
  });

  it('branches one idempotent parameter revision from the requested base', () => {
    const parameterSchema = {
      overall_radius: {
        type: 'number' as const,
        label: 'Overall radius',
        default: 3,
        min: 1,
        max: 5,
        step: 0.5,
      },
    };
    let history = appendRevision(createDesignHistory(), {
      id: payload.baseRevisionId,
      code: 'async ({ params }) => ({ params })',
      params: { overall_radius: 3 },
      parameterSchema,
      instruction: 'Create a coil.',
      createdAt: 1,
    });
    history = appendRevision(history, {
      id: 'unrelated-branch',
      code: 'async ({ params }) => ({ changed: true, params })',
      params: { overall_radius: 3 },
      parameterSchema,
      instruction: 'Change its structure.',
      createdAt: 2,
    });

    const committed = commitParameterEditRevision(
      history,
      payload,
      { overall_radius: 4.5 },
      3,
    );
    const repeated = commitParameterEditRevision(
      committed,
      payload,
      { overall_radius: 4.5 },
      4,
    );

    expect(committed.revisions[payload.requestId]).toMatchObject({
      parentId: payload.baseRevisionId,
      kind: 'parameter-edit',
      code: history.revisions[payload.baseRevisionId]!.code,
      params: { overall_radius: 4.5 },
      instruction: 'Adjust Overall radius.',
      turnId: payload.requestId,
    });
    expect(Object.keys(repeated.revisions)).toHaveLength(3);
    expect(repeated.currentRevisionId).toBe(payload.requestId);
    expect(currentRevision(undoRevision(repeated))?.params).toEqual({
      overall_radius: 3,
    });
  });
});

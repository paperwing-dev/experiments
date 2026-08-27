import { describe, expect, it } from 'vitest';
import {
  appendRevision,
  createDesignHistory,
  currentRevision,
  designHistorySnapshot,
  migrateLegacyArtwork,
  restoreRevision,
  undoRevision,
} from './design-history';

function add(
  history: ReturnType<typeof createDesignHistory>,
  id: string,
) {
  return appendRevision(history, {
    id,
    code: `async () => '${id}'`,
    instruction: `Create ${id}.`,
    createdAt: id.charCodeAt(0),
  });
}

describe('immutable design history', () => {
  it('creates an initial revision with parameter-ready defaults', () => {
    const history = add(createDesignHistory(), 'A');

    expect(history.currentRevisionId).toBe('A');
    expect(currentRevision(history)).toEqual({
      id: 'A',
      parentId: null,
      kind: 'initial',
      code: "async () => 'A'",
      params: {},
      parameterSchema: {},
      instruction: 'Create A.',
      createdAt: 65,
    });
    expect(history.variationSets).toEqual({});
  });

  it('adds a child without mutating its parent or prior graph', () => {
    const initial = add(createDesignHistory(), 'A');
    const edited = add(initial, 'B');

    expect(initial.currentRevisionId).toBe('A');
    expect(Object.keys(initial.revisions)).toEqual(['A']);
    expect(edited.revisions.A).toBe(initial.revisions.A);
    expect(edited.revisions.B).toMatchObject({
      id: 'B',
      parentId: 'A',
      kind: 'edit',
    });
  });

  it('stores a parameter edit as one immutable child with exact runtime state', () => {
    const schema = {
      thickness: {
        type: 'number' as const,
        label: 'Thickness',
        default: 0.2,
        min: 0.05,
        max: 1,
        step: 0.05,
      },
    };
    const initial = appendRevision(createDesignHistory(), {
      id: 'A',
      code: 'async ({ params }) => ({ params })',
      params: { thickness: 0.2 },
      parameterSchema: schema,
      instruction: 'Create a coil.',
      createdAt: 1,
    });
    const edited = appendRevision(initial, {
      id: 'B',
      code: initial.revisions.A!.code,
      kind: 'parameter-edit',
      params: { thickness: 0.1 },
      parameterSchema: schema,
      instruction: 'Make it thinner.',
      createdAt: 2,
    });

    schema.thickness.label = 'Mutated input';
    expect(edited.revisions.B).toMatchObject({
      parentId: 'A',
      kind: 'parameter-edit',
      code: initial.revisions.A!.code,
      params: { thickness: 0.1 },
      parameterSchema: { thickness: { label: 'Thickness' } },
    });
    expect(currentRevision(undoRevision(edited))?.params).toEqual({
      thickness: 0.2,
    });
    expect(currentRevision(restoreRevision(edited, 'A'))?.parameterSchema)
      .toEqual(initial.revisions.A!.parameterSchema);
  });

  it('rejects parameter edits that change code, schema, or no values', () => {
    const schema = {
      turns: {
        type: 'number' as const,
        label: 'Turns',
        default: 5,
        min: 1,
        max: 10,
        step: 1,
      },
    };
    const initial = appendRevision(createDesignHistory(), {
      id: 'A',
      code: 'async ({ params }) => ({ params })',
      params: { turns: 5 },
      parameterSchema: schema,
      instruction: 'Create a coil.',
      createdAt: 1,
    });
    const parameterEdit = {
      id: 'B',
      code: initial.revisions.A!.code,
      kind: 'parameter-edit' as const,
      params: { turns: 6 },
      parameterSchema: schema,
      instruction: 'More turns.',
      createdAt: 2,
    };

    expect(() => appendRevision(initial, {
      ...parameterEdit,
      code: 'async () => ({})',
    })).toThrow(/cannot change program source/);
    expect(() => appendRevision(initial, {
      ...parameterEdit,
      parameterSchema: {
        turns: { ...schema.turns, label: 'Coil turns' },
      },
    })).toThrow(/cannot change the parameter schema/);
    expect(() => appendRevision(initial, {
      ...parameterEdit,
      params: { turns: 5 },
    })).toThrow(/must change at least one value/);
  });

  it('never compacts parameter edits as legacy inspection drafts', () => {
    const schema = {
      rise: {
        type: 'number' as const,
        label: 'Vertical rise',
        default: 2,
        min: 0,
        max: 10,
        step: 0.5,
      },
    };
    let history = appendRevision(createDesignHistory(), {
      id: 'A',
      code: 'async ({ params }) => ({ params })',
      params: { rise: 2 },
      parameterSchema: schema,
      instruction: 'Increase the rise.',
      createdAt: 1,
    });
    history = appendRevision(history, {
      id: 'B',
      code: history.revisions.A!.code,
      kind: 'parameter-edit',
      params: { rise: 3 },
      parameterSchema: schema,
      instruction: 'Increase the rise.',
      createdAt: 2,
    });

    expect(designHistorySnapshot(history).revisions.map(({ id }) => id))
      .toEqual(['A', 'B']);
    expect(undoRevision(history).currentRevisionId).toBe('A');
  });

  it('branches naturally across the complete undo and restore sequence', () => {
    let history = add(createDesignHistory(), 'A');
    history = add(history, 'B');
    history = add(history, 'C');
    history = undoRevision(history);
    expect(history.currentRevisionId).toBe('B');

    history = add(history, 'D');
    expect(history.revisions.D?.parentId).toBe('B');
    expect(history.revisions.C).toBeDefined();

    const revisionCount = Object.keys(history.revisions).length;
    history = restoreRevision(history, 'C');
    expect(history.currentRevisionId).toBe('C');
    expect(Object.keys(history.revisions)).toHaveLength(revisionCount);

    history = add(history, 'E');
    expect(history.revisions.E?.parentId).toBe('C');
    history = undoRevision(history);
    expect(history.currentRevisionId).toBe('C');
    expect(Object.keys(history.revisions)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('does not create a revision when undo cannot move the pointer', () => {
    const history = add(createDesignHistory(), 'A');

    expect(undoRevision(history)).toBe(history);
    expect(restoreRevision(history, 'A')).toBe(history);
  });

  it('migrates legacy source once and is idempotent', () => {
    const empty = createDesignHistory();
    const migrated = migrateLegacyArtwork(
      empty,
      "async () => 'legacy'",
      'legacy-id',
      123,
    );
    const repeated = migrateLegacyArtwork(
      migrated,
      "async () => 'legacy'",
      'different-id',
      456,
    );

    expect(migrated.currentRevisionId).toBe('legacy-id');
    expect(migrated.revisions['legacy-id']).toMatchObject({
      parentId: null,
      kind: 'initial',
      code: "async () => 'legacy'",
      createdAt: 123,
    });
    expect(repeated).toBe(migrated);
  });

  it('rejects missing restore targets and duplicate ids', () => {
    const history = add(createDesignHistory(), 'A');

    expect(() => restoreRevision(history, 'missing')).toThrow(/does not exist/);
    expect(() => add(history, 'A')).toThrow(/already exists/);
  });

  it('projects compact metadata without duplicating program source', () => {
    const history = add(add(createDesignHistory(), 'A'), 'B');

    expect(designHistorySnapshot(history)).toEqual({
      currentRevisionId: 'B',
      revisions: [
        {
          id: 'A',
          parentId: null,
          kind: 'initial',
          instruction: 'Create A.',
          createdAt: 65,
        },
        {
          id: 'B',
          parentId: 'A',
          kind: 'edit',
          instruction: 'Create B.',
          createdAt: 66,
        },
      ],
    });
    expect(JSON.stringify(designHistorySnapshot(history))).not.toContain(
      'async ()',
    );
  });

  it('collapses a legacy inspection draft into its accepted revision', () => {
    let history = appendRevision(createDesignHistory(), {
      id: 'draft-A',
      code: "async () => 'draft'",
      instruction: 'Create a sphere.',
      createdAt: 1_000,
    });
    history = appendRevision(history, {
      id: 'accepted-A',
      code: "async () => 'accepted'",
      instruction: 'Create a sphere.',
      createdAt: 2_000,
    });
    history = appendRevision(history, {
      id: 'B',
      code: "async () => 'B'",
      instruction: 'Make it spiral.',
      createdAt: 3_000,
      turnId: 'turn-B',
    });

    expect(designHistorySnapshot(history)).toEqual({
      currentRevisionId: 'B',
      revisions: [
        {
          id: 'accepted-A',
          parentId: null,
          kind: 'initial',
          instruction: 'Create a sphere.',
          createdAt: 2_000,
        },
        {
          id: 'B',
          parentId: 'accepted-A',
          kind: 'edit',
          instruction: 'Make it spiral.',
          createdAt: 3_000,
          turnId: 'turn-B',
        },
      ],
    });

    const previousTurn = undoRevision(history);
    expect(previousTurn.currentRevisionId).toBe('accepted-A');
    expect(undoRevision(previousTurn)).toBe(previousTurn);
  });

  it('keeps repeated user prompts distinct when they have turn ids', () => {
    let history = appendRevision(createDesignHistory(), {
      id: 'A',
      code: "async () => 'A'",
      instruction: 'Create a sphere.',
      createdAt: 1_000,
      turnId: 'turn-A',
    });
    history = appendRevision(history, {
      id: 'B',
      code: "async () => 'B'",
      instruction: 'Create a sphere.',
      createdAt: 2_000,
      turnId: 'turn-B',
    });

    expect(designHistorySnapshot(history).revisions).toHaveLength(2);
    expect(undoRevision(history).currentRevisionId).toBe('A');
  });
});

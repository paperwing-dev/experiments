import { describe, expect, it } from 'vitest';
import {
  acceptPendingRevision,
  assertVisualRunCanStart,
  beginVisualInspection,
  completeVisualInspection,
  failVisualInspection,
  recordVisualRun,
  startDesignTurn,
} from './design-turn';

function candidate(id: string) {
  return {
    code: `async () => '${id}'`,
    createdAt: id.charCodeAt(0),
    id,
    instruction: `Create ${id}.`,
    kind: 'edit' as const,
    parameterSchema: {},
    params: {},
    turnId: `turn-${id}`,
  };
}

describe('design turn autonomy limit', () => {
  it('terminates a visual run that does not request inspection', () => {
    const result = recordVisualRun(
      startDesignTurn('revision-3', 'Make it blue.', 'turn-4'),
      false,
      candidate('revision-4'),
    );

    expect(result.kind).toBe('initial');
    expect(result.revisionToCommit?.id).toBe('revision-4');
    expect(result.state).toEqual({
      inspection: 'complete',
      instruction: 'Make it blue.',
      pendingRevision: null,
      startedAtRevisionId: 'revision-3',
      successfulRuns: 1,
      turnId: 'turn-4',
    });
    expect(() =>
      recordVisualRun(result.state, false, candidate('revision-5')),
    ).toThrow(/cannot run/);
  });

  it('commits only the correction after a revision-needed critique', () => {
    const draft = candidate('draft-8');
    const final = candidate('revision-8');
    const initial = recordVisualRun(
      startDesignTurn('revision-7', 'Make it balanced.', 'turn-8'),
      true,
      draft,
    );
    const inspecting = beginVisualInspection(initial.state);
    const critiqued = completeVisualInspection(inspecting, true);
    const correction = recordVisualRun(critiqued.state, false, final);

    expect(initial.revisionToCommit).toBeNull();
    expect(critiqued.revisionToCommit).toBeNull();
    expect(critiqued.state.pendingRevision).toBe(draft);
    expect(correction.kind).toBe('correction');
    expect(correction.revisionToCommit).toBe(final);
    expect(correction.state.pendingRevision).toBeNull();
    expect(correction.state.successfulRuns).toBe(2);
    expect(() =>
      recordVisualRun(correction.state, false, candidate('revision-9')),
    ).toThrow(/cannot run/);
    expect(() =>
      recordVisualRun(critiqued.state, true, candidate('draft-9')),
    ).toThrow(/cannot run/);
  });

  it('rejects a premature correction before visual program execution', () => {
    const pending = recordVisualRun(
      startDesignTurn('revision-7'),
      true,
      candidate('draft-8'),
    ).state;

    expect(() => assertVisualRunCanStart(pending, false)).toThrow(
      /Application-owned visual inspection is pending/,
    );
    expect(() => assertVisualRunCanStart(pending, true)).toThrow(
      /Application-owned visual inspection is pending/,
    );
  });

  it('accepts one draft when inspection says the visual is already good', () => {
    const draft = candidate('revision-2');
    const initial = recordVisualRun(startDesignTurn('revision-1'), true, draft);
    const completed = completeVisualInspection(
      beginVisualInspection(initial.state),
      false,
    );

    expect(completed.revisionToCommit).toBe(draft);
    expect(completed.state.inspection).toBe('complete');
    expect(completed.state.pendingRevision).toBeNull();
    expect(() =>
      recordVisualRun(completed.state, false, candidate('revision-3')),
    ).toThrow(/cannot run/);
  });

  it('accepts the valid draft when inspection is unavailable', () => {
    const draft = candidate('revision-3');
    const initial = recordVisualRun(startDesignTurn('revision-2'), true, draft);
    const failed = failVisualInspection(beginVisualInspection(initial.state));

    expect(failed.revisionToCommit).toBe(draft);
    expect(failed.state.inspection).toBe('unavailable');
    expect(failed.state.pendingRevision).toBeNull();
    expect(() => beginVisualInspection(failed.state)).toThrow(/only once/);
    expect(() =>
      recordVisualRun(failed.state, false, candidate('revision-4')),
    ).toThrow(/cannot run/);
  });

  it('accepts the inspected draft when no correction succeeds', () => {
    const draft = candidate('draft-5');
    const initial = recordVisualRun(
      startDesignTurn('revision-4'),
      true,
      draft,
    );
    const critiqued = completeVisualInspection(
      beginVisualInspection(initial.state),
      true,
    );
    const fallback = acceptPendingRevision(critiqued.state);

    expect(fallback.revisionToCommit).toBe(draft);
    expect(fallback.state.inspection).toBe('complete');
    expect(fallback.state.pendingRevision).toBeNull();
    expect(fallback.state.successfulRuns).toBe(1);
    expect(() =>
      recordVisualRun(fallback.state, false, candidate('revision-6')),
    ).toThrow(/cannot run/);
    expect(() => acceptPendingRevision(initial.state)).toThrow(
      /only after inspection requested a correction/,
    );
  });
});

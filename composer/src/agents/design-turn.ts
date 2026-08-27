import type { RevisionKind } from '../history/design-history';
import type { ParameterSchema } from '../visual/types';

export type InspectionPhase =
  | 'complete'
  | 'in-progress'
  | 'pending'
  | 'revision-needed'
  | 'unavailable';

export interface VisualCandidateRevision {
  code: string;
  createdAt: number;
  id: string;
  instruction: string;
  kind: RevisionKind;
  parameterSchema: ParameterSchema;
  params: Record<string, number>;
  turnId: string;
}

export interface DesignTurnState {
  inspection: InspectionPhase;
  instruction: string;
  pendingRevision: VisualCandidateRevision | null;
  startedAtRevisionId: string | null;
  successfulRuns: number;
  turnId: string;
}

export type VisualRunKind = 'correction' | 'initial';

export interface DesignTurnTransition {
  revisionToCommit: VisualCandidateRevision | null;
  state: DesignTurnState;
}

export class DesignTurnLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignTurnLimitError';
  }
}

export function startDesignTurn(
  revisionId: string | null,
  instruction = '',
  turnId = '',
): DesignTurnState {
  return {
    inspection: 'complete',
    instruction,
    pendingRevision: null,
    startedAtRevisionId: revisionId,
    successfulRuns: 0,
    turnId,
  };
}

export function recordVisualRun(
  state: DesignTurnState,
  inspect: boolean,
  candidate: VisualCandidateRevision,
): DesignTurnTransition & { kind: VisualRunKind } {
  assertVisualRunCanStart(state, inspect);

  if (state.successfulRuns === 0) {
    return {
      kind: 'initial',
      revisionToCommit: inspect ? null : candidate,
      state: {
        ...state,
        inspection: inspect ? 'pending' : 'complete',
        pendingRevision: inspect ? candidate : null,
        successfulRuns: 1,
      },
    };
  }

  if (
    state.successfulRuns === 1 &&
    state.inspection === 'revision-needed' &&
    !inspect
  ) {
    return {
      kind: 'correction',
      revisionToCommit: candidate,
      state: {
        ...state,
        inspection: 'complete',
        pendingRevision: null,
        successfulRuns: 2,
      },
    };
  }

  throw new DesignTurnLimitError('The visual run state is invalid.');
}

export function assertVisualRunCanStart(
  state: DesignTurnState,
  inspect: boolean,
): void {
  if (state.successfulRuns === 0) return;

  if (
    state.successfulRuns === 1 &&
    state.inspection === 'revision-needed' &&
    !inspect
  ) {
    return;
  }

  if (state.inspection === 'pending' || state.inspection === 'in-progress') {
    throw new DesignTurnLimitError(
      'Application-owned visual inspection is pending for the current user request. Do not explain this internal guard to the user or run another program unless the inspection requests one correction.',
    );
  }

  throw new DesignTurnLimitError(
    'This user turn cannot run another visual program. A second successful run is allowed only once, after inspection requests a correction.',
  );
}

export function beginVisualInspection(
  state: DesignTurnState,
): DesignTurnState {
  if (
    state.successfulRuns !== 1 ||
    state.inspection !== 'pending' ||
    !state.pendingRevision
  ) {
    throw new DesignTurnLimitError(
      'Visual inspection is available only once, immediately after an eligible initial visual run.',
    );
  }

  return { ...state, inspection: 'in-progress' };
}

export function completeVisualInspection(
  state: DesignTurnState,
  needsRevision: boolean,
): DesignTurnTransition {
  if (state.inspection !== 'in-progress') {
    throw new DesignTurnLimitError('No visual inspection is currently in progress.');
  }
  if (!state.pendingRevision) {
    throw new DesignTurnLimitError('The inspected visual candidate is unavailable.');
  }

  return {
    revisionToCommit: needsRevision ? null : state.pendingRevision,
    state: {
      ...state,
      inspection: needsRevision ? 'revision-needed' : 'complete',
      pendingRevision: needsRevision ? state.pendingRevision : null,
    },
  };
}

export function failVisualInspection(
  state: DesignTurnState,
): DesignTurnTransition {
  if (state.inspection !== 'in-progress') {
    throw new DesignTurnLimitError('No visual inspection is currently in progress.');
  }
  if (!state.pendingRevision) {
    throw new DesignTurnLimitError('The inspected visual candidate is unavailable.');
  }

  return {
    revisionToCommit: state.pendingRevision,
    state: {
      ...state,
      inspection: 'unavailable',
      pendingRevision: null,
    },
  };
}

export function acceptPendingRevision(
  state: DesignTurnState,
): DesignTurnTransition {
  if (state.inspection !== 'revision-needed') {
    throw new DesignTurnLimitError(
      'A pending visual revision can be accepted only after inspection requested a correction.',
    );
  }
  if (!state.pendingRevision) {
    throw new DesignTurnLimitError('The pending visual revision is unavailable.');
  }

  return {
    revisionToCommit: state.pendingRevision,
    state: {
      ...state,
      inspection: 'complete',
      pendingRevision: null,
    },
  };
}

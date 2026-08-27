import type { NumberParameter, ParameterSchema } from '../visual/types';
import {
  normalizeParameterValues,
  parameterSchemasEqual,
  validateParameterSchema,
} from '../visual/validation';

export type RevisionKind =
  | 'initial'
  | 'edit'
  | 'parameter-edit'
  | 'variation';

export type ParameterDefinition = NumberParameter;

export interface Revision {
  id: string;
  parentId: string | null;
  kind: RevisionKind;
  code: string;
  params: Record<string, number>;
  parameterSchema: ParameterSchema;
  instruction: string;
  createdAt: number;
  turnId?: string;
  variationSetId?: string;
}

export interface VariationSet {
  id: string;
  baseRevisionId: string;
  request: string;
  revisionIds: string[];
  createdAt: number;
}

export interface DesignHistory {
  currentRevisionId: string | null;
  revisions: Record<string, Revision>;
  variationSets: Record<string, VariationSet>;
}

export type RevisionSummary = Pick<
  Revision,
  'createdAt' | 'id' | 'instruction' | 'kind' | 'parentId' | 'turnId'
>;

export interface DesignHistorySnapshot {
  currentRevisionId: string | null;
  revisions: RevisionSummary[];
}

export interface AppendRevisionInput {
  id: string;
  code: string;
  instruction: string;
  createdAt: number;
  kind?: RevisionKind;
  params?: Record<string, number>;
  parameterSchema?: ParameterSchema;
  turnId?: string;
  variationSetId?: string;
}

export function createDesignHistory(): DesignHistory {
  return {
    currentRevisionId: null,
    revisions: {},
    variationSets: {},
  };
}

export function currentRevision(history: DesignHistory): Revision | null {
  if (history.currentRevisionId === null) return null;
  const revision = history.revisions[history.currentRevisionId];
  if (!revision) {
    throw new Error(
      `Current revision "${history.currentRevisionId}" does not exist.`,
    );
  }
  return revision;
}

export function appendRevision(
  history: DesignHistory,
  input: AppendRevisionInput,
): DesignHistory {
  const id = input.id.trim();
  const code = input.code.trim();
  if (!id) throw new Error('Revision id cannot be empty.');
  if (!code) throw new Error('Revision code cannot be empty.');
  if (history.revisions[id]) {
    throw new Error(`Revision "${id}" already exists.`);
  }

  const parent = currentRevision(history);
  const parentId = parent?.id ?? null;
  const kind = input.kind ?? (parentId === null ? 'initial' : 'edit');
  if (kind === 'initial' && parentId !== null) {
    throw new Error('An initial revision cannot have a parent.');
  }
  if (kind !== 'initial' && parentId === null) {
    throw new Error('A non-initial revision must have a parent.');
  }

  const parameterSchema = validateParameterSchema(
    input.parameterSchema === undefined ? {} : input.parameterSchema,
  );
  const params = normalizeParameterValues(
    parameterSchema,
    input.params === undefined ? {} : input.params,
  );
  if (kind === 'parameter-edit' && parent) {
    if (code !== parent.code) {
      throw new Error('A parameter edit cannot change program source.');
    }
    if (!parameterSchemasEqual(parameterSchema, parent.parameterSchema)) {
      throw new Error('A parameter edit cannot change the parameter schema.');
    }
    const changed = Object.entries(params).some(
      ([id, value]) => parent.params[id] !== value,
    );
    if (!changed) {
      throw new Error('A parameter edit must change at least one value.');
    }
  }

  const revision: Revision = {
    id,
    parentId,
    kind,
    code,
    params,
    parameterSchema,
    instruction: input.instruction,
    createdAt: input.createdAt,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.variationSetId === undefined
      ? {}
      : { variationSetId: input.variationSetId }),
  };

  return {
    ...history,
    currentRevisionId: revision.id,
    revisions: {
      ...history.revisions,
      [revision.id]: revision,
    },
  };
}

export function undoRevision(history: DesignHistory): DesignHistory {
  const current = currentRevision(history);
  if (!current || current.parentId === null) return history;
  const parent = history.revisions[current.parentId];
  if (!parent) {
    throw new Error(`Parent revision "${current.parentId}" does not exist.`);
  }
  if (isLegacyInspectionDraft(parent, current)) {
    return parent.parentId === null
      ? history
      : { ...history, currentRevisionId: parent.parentId };
  }
  return { ...history, currentRevisionId: parent.id };
}

export function restoreRevision(
  history: DesignHistory,
  revisionId: string,
): DesignHistory {
  if (!history.revisions[revisionId]) {
    throw new Error(`Revision "${revisionId}" does not exist.`);
  }
  if (history.currentRevisionId === revisionId) return history;
  return { ...history, currentRevisionId: revisionId };
}

export function migrateLegacyArtwork(
  history: DesignHistory,
  legacyCode: string | null,
  id: string,
  createdAt: number,
): DesignHistory {
  if (
    history.currentRevisionId !== null ||
    Object.keys(history.revisions).length > 0 ||
    !legacyCode?.trim()
  ) {
    return history;
  }

  return appendRevision(history, {
    id,
    code: legacyCode,
    instruction: 'Migrated existing artwork.',
    createdAt,
    kind: 'initial',
  });
}

export function designHistorySnapshot(
  history: DesignHistory,
): DesignHistorySnapshot {
  return compactLegacyInspectionDrafts({
    currentRevisionId: history.currentRevisionId,
    revisions: Object.values(history.revisions).map((revision) => ({
      id: revision.id,
      parentId: revision.parentId,
      kind: revision.kind,
      instruction: revision.instruction,
      createdAt: revision.createdAt,
      ...(revision.turnId === undefined ? {} : { turnId: revision.turnId }),
    })),
  });
}

const LEGACY_INSPECTION_WINDOW_MS = 10 * 60 * 1000;

function isLegacyInspectionDraft(
  draft: RevisionSummary,
  accepted: RevisionSummary,
): boolean {
  return (
    (draft.kind === 'initial' || draft.kind === 'edit') &&
    accepted.kind === 'edit' &&
    draft.turnId === undefined &&
    accepted.turnId === undefined &&
    accepted.parentId === draft.id &&
    accepted.instruction.trim() !== '' &&
    accepted.instruction === draft.instruction &&
    accepted.createdAt >= draft.createdAt &&
    accepted.createdAt - draft.createdAt <= LEGACY_INSPECTION_WINDOW_MS
  );
}

export function compactLegacyInspectionDrafts(
  history: DesignHistorySnapshot,
): DesignHistorySnapshot {
  const byId = new Map(history.revisions.map((revision) => [revision.id, revision]));
  const childCounts = new Map<string, number>();
  for (const revision of history.revisions) {
    if (revision.parentId) {
      childCounts.set(revision.parentId, (childCounts.get(revision.parentId) ?? 0) + 1);
    }
  }

  const hidden = new Set<string>();
  for (const accepted of history.revisions) {
    const draft = accepted.parentId ? byId.get(accepted.parentId) : undefined;
    if (
      draft &&
      draft.id !== history.currentRevisionId &&
      childCounts.get(draft.id) === 1 &&
      isLegacyInspectionDraft(draft, accepted)
    ) {
      hidden.add(draft.id);
    }
  }
  if (hidden.size === 0) return history;

  return {
    currentRevisionId: history.currentRevisionId,
    revisions: history.revisions
      .filter((revision) => !hidden.has(revision.id))
      .map((revision) => {
        let parentId = revision.parentId;
        while (parentId && hidden.has(parentId)) {
          parentId = byId.get(parentId)?.parentId ?? null;
        }
        const kind = parentId === null && revision.kind === 'edit'
          ? 'initial'
          : revision.kind;
        return parentId === revision.parentId && kind === revision.kind
          ? revision
          : { ...revision, kind, parentId };
      }),
  };
}

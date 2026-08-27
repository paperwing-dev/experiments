import {
  appendRevision,
  restoreRevision,
} from '../history/design-history';
import type {
  DesignHistory,
  Revision,
} from '../history/design-history';
import {
  parameterSchemasEqual,
  parameterValuesEqual,
  validateVisualExecutionInput,
} from '../visual/validation';

export const PARAMETER_EDIT_SIGNAL = 'composer.parameter-edit';
export const MAX_PARAMETER_EDIT_SIGNAL_BYTES = 1_024;

const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ParameterEditPayload {
  baseRevisionId: string;
  parameterId: string;
  requestId: string;
  value: number;
}

interface SignalLike {
  kind: string;
  type?: unknown;
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every(
    (key, index) => key === expected[index],
  );
}

export function parseParameterEditSignal(
  signal: SignalLike,
): ParameterEditPayload | null {
  if (signal.kind !== 'signal' || signal.type !== PARAMETER_EDIT_SIGNAL) {
    return null;
  }
  if (typeof signal.body !== 'string') {
    throw new Error('Parameter edit signal body must be a JSON string.');
  }
  if (
    new TextEncoder().encode(signal.body).byteLength >
      MAX_PARAMETER_EDIT_SIGNAL_BYTES
  ) {
    throw new Error('Parameter edit signal is too large.');
  }

  let value: unknown;
  try {
    value = JSON.parse(signal.body);
  } catch {
    throw new Error('Parameter edit signal body must contain valid JSON.');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'baseRevisionId',
      'parameterId',
      'requestId',
      'value',
    ])
  ) {
    throw new Error('Parameter edit signal has an invalid shape.');
  }
  if (
    typeof value.baseRevisionId !== 'string' ||
    !REVISION_ID.test(value.baseRevisionId)
  ) {
    throw new Error('Parameter edit signal has an invalid base revision id.');
  }
  if (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) {
    throw new Error('Parameter edit signal has an invalid request id.');
  }
  if (typeof value.parameterId !== 'string') {
    throw new Error('Parameter edit signal has an invalid parameter id.');
  }

  const params = validateVisualExecutionInput({
    params: { [value.parameterId]: value.value },
  }).params;
  return {
    baseRevisionId: value.baseRevisionId,
    parameterId: value.parameterId,
    requestId: value.requestId,
    value: params[value.parameterId]!,
  };
}

export function parameterEditSignal(
  payload: ParameterEditPayload,
): {
  kind: 'signal';
  type: typeof PARAMETER_EDIT_SIGNAL;
  body: string;
} {
  const signal = {
    kind: 'signal',
    type: PARAMETER_EDIT_SIGNAL,
    body: JSON.stringify(payload),
  } as const;
  parseParameterEditSignal(signal);
  return signal;
}

export function isMatchingParameterEditRevision(
  revision: Revision,
  baseRevision: Revision,
  params: Record<string, number>,
): boolean {
  return (
    revision.kind === 'parameter-edit' &&
    revision.parentId === baseRevision.id &&
    revision.code === baseRevision.code &&
    parameterSchemasEqual(
      revision.parameterSchema,
      baseRevision.parameterSchema,
    ) &&
    parameterValuesEqual(revision.params, params)
  );
}

export function commitParameterEditRevision(
  history: DesignHistory,
  payload: ParameterEditPayload,
  params: Record<string, number>,
  createdAt: number,
): DesignHistory {
  const baseRevision = history.revisions[payload.baseRevisionId];
  if (!baseRevision) {
    throw new Error('The parameter edit base revision does not exist.');
  }
  const definition = baseRevision.parameterSchema[payload.parameterId];
  if (!definition) {
    throw new Error('The requested visual parameter does not exist.');
  }
  for (const [id, value] of Object.entries(params)) {
    if (id !== payload.parameterId && baseRevision.params[id] !== value) {
      throw new Error('A direct parameter edit can change only one value.');
    }
  }

  const existing = history.revisions[payload.requestId];
  if (existing) {
    if (!isMatchingParameterEditRevision(existing, baseRevision, params)) {
      throw new Error('The parameter edit request id is already in use.');
    }
    return restoreRevision(history, existing.id);
  }

  return appendRevision(restoreRevision(history, baseRevision.id), {
    id: payload.requestId,
    code: baseRevision.code,
    kind: 'parameter-edit',
    params,
    parameterSchema: baseRevision.parameterSchema,
    instruction: `Adjust ${definition.label}.`,
    createdAt,
    turnId: payload.requestId,
  });
}

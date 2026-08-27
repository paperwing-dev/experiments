import type {
  NumberParameter,
  ParameterSchema,
  VisualExecutionInput,
  VisualPoint,
  VisualResult,
} from './types';

export const VISUAL_LIMITS = {
  minPoints: 8,
  maxPoints: 500,
  maxCoordinate: 1_000,
  minRadius: 0.005,
  maxRadius: 100,
  maxSerializedBytes: 80_000,
} as const;

export const PARAMETER_LIMITS = {
  maxCount: 8,
  maxIdLength: 32,
  maxLabelLength: 60,
  maxAbsoluteBound: 1_000_000,
} as const;

const PARAMETER_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESERVED_PARAMETER_IDS = new Set(['constructor', 'prototype']);

export class VisualValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VisualValidationError(`${label} must be a finite number.`);
  }

  return value;
}

function validateParameterId(id: string): void {
  if (
    id.length > PARAMETER_LIMITS.maxIdLength ||
    !PARAMETER_ID_PATTERN.test(id) ||
    RESERVED_PARAMETER_IDS.has(id)
  ) {
    throw new VisualValidationError(
      `Parameter id "${id}" must start with a lowercase letter and contain only lowercase letters, numbers, and underscores (maximum ${PARAMETER_LIMITS.maxIdLength} characters).`,
    );
  }
}

function validateNumberParameter(
  value: unknown,
  id: string,
): NumberParameter {
  if (!isRecord(value) || value.type !== 'number') {
    throw new VisualValidationError(
      `parameterSchema.${id} must be a number parameter.`,
    );
  }

  if (typeof value.label !== 'string' || !value.label.trim()) {
    throw new VisualValidationError(
      `parameterSchema.${id}.label must be a non-empty string.`,
    );
  }
  const label = value.label.trim();
  if (label.length > PARAMETER_LIMITS.maxLabelLength) {
    throw new VisualValidationError(
      `parameterSchema.${id}.label cannot exceed ${PARAMETER_LIMITS.maxLabelLength} characters.`,
    );
  }

  const minimum = finiteNumber(value.min, `parameterSchema.${id}.min`);
  const maximum = finiteNumber(value.max, `parameterSchema.${id}.max`);
  const defaultValue = finiteNumber(
    value.default,
    `parameterSchema.${id}.default`,
  );
  const step = finiteNumber(value.step, `parameterSchema.${id}.step`);

  if (minimum >= maximum) {
    throw new VisualValidationError(
      `parameterSchema.${id}.min must be less than max.`,
    );
  }
  if (
    Math.abs(minimum) > PARAMETER_LIMITS.maxAbsoluteBound ||
    Math.abs(maximum) > PARAMETER_LIMITS.maxAbsoluteBound
  ) {
    throw new VisualValidationError(
      `parameterSchema.${id} bounds must stay within ±${PARAMETER_LIMITS.maxAbsoluteBound}.`,
    );
  }
  if (defaultValue < minimum || defaultValue > maximum) {
    throw new VisualValidationError(
      `parameterSchema.${id}.default must be within its bounds.`,
    );
  }
  if (step <= 0 || step > maximum - minimum) {
    throw new VisualValidationError(
      `parameterSchema.${id}.step must be positive and no larger than its range.`,
    );
  }

  return {
    type: 'number',
    label,
    default: defaultValue,
    min: minimum,
    max: maximum,
    step,
  };
}

export function validateParameterSchema(value: unknown): ParameterSchema {
  if (!isRecord(value)) {
    throw new VisualValidationError('parameterSchema must be an object.');
  }

  const entries = Object.entries(value);
  if (entries.length > PARAMETER_LIMITS.maxCount) {
    throw new VisualValidationError(
      `parameterSchema cannot contain more than ${PARAMETER_LIMITS.maxCount} controls.`,
    );
  }

  return Object.fromEntries(
    entries.map(([id, definition]) => {
      validateParameterId(id);
      return [id, validateNumberParameter(definition, id)];
    }),
  );
}

export function validateVisualExecutionInput(
  value: unknown,
): VisualExecutionInput {
  if (!isRecord(value) || !isRecord(value.params)) {
    throw new VisualValidationError('Execution input must include a params object.');
  }

  const entries = Object.entries(value.params);
  if (entries.length > PARAMETER_LIMITS.maxCount) {
    throw new VisualValidationError(
      `params cannot contain more than ${PARAMETER_LIMITS.maxCount} values.`,
    );
  }

  return {
    params: Object.fromEntries(
      entries.map(([id, parameterValue]) => {
        validateParameterId(id);
        return [id, finiteNumber(parameterValue, `params.${id}`)];
      }),
    ),
  };
}

export function normalizeParameterValues(
  schema: ParameterSchema,
  values: unknown,
): Record<string, number> {
  const validatedSchema = validateParameterSchema(schema);
  if (!isRecord(values)) {
    throw new VisualValidationError('params must be an object.');
  }

  for (const id of Object.keys(values)) {
    validateParameterId(id);
    if (!Object.prototype.hasOwnProperty.call(validatedSchema, id)) {
      throw new VisualValidationError(`Unknown parameter "${id}".`);
    }
  }

  return Object.fromEntries(
    Object.entries(validatedSchema).map(([id, definition]) => {
      const supplied = values[id];
      const numericValue = supplied === undefined
        ? definition.default
        : finiteNumber(supplied, `params.${id}`);
      return [
        id,
        Math.min(definition.max, Math.max(definition.min, numericValue)),
      ];
    }),
  );
}

export function normalizeCompatibleParameterValues(
  schema: ParameterSchema,
  values: unknown,
): Record<string, number> {
  const validatedSchema = validateParameterSchema(schema);
  if (!isRecord(values)) {
    throw new VisualValidationError('params must be an object.');
  }

  return normalizeParameterValues(
    validatedSchema,
    Object.fromEntries(
      Object.keys(validatedSchema)
        .filter((id) => Object.prototype.hasOwnProperty.call(values, id))
        .map((id) => [id, values[id]]),
    ),
  );
}

export function parameterSchemasEqual(
  left: ParameterSchema,
  right: ParameterSchema,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;

  return leftEntries.every(([id, definition], index) => {
    const rightEntry = rightEntries[index];
    if (!rightEntry || rightEntry[0] !== id) return false;
    const other = rightEntry[1];
    return (
      definition.type === other.type &&
      definition.label === other.label &&
      definition.default === other.default &&
      definition.min === other.min &&
      definition.max === other.max &&
      definition.step === other.step
    );
  });
}

export function parameterValuesEqual(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(
    ([id, value]) =>
      Object.prototype.hasOwnProperty.call(right, id) && right[id] === value,
  );
}

function validatePoint(value: unknown, index: number): VisualPoint {
  if (!isRecord(value)) {
    throw new VisualValidationError(`points[${index}] must be an object.`);
  }

  const point = {
    x: finiteNumber(value.x, `points[${index}].x`),
    y: finiteNumber(value.y, `points[${index}].y`),
    z: finiteNumber(value.z, `points[${index}].z`),
  };

  for (const [axis, coordinate] of Object.entries(point)) {
    if (Math.abs(coordinate) > VISUAL_LIMITS.maxCoordinate) {
      throw new VisualValidationError(
        `points[${index}].${axis} exceeds ${VISUAL_LIMITS.maxCoordinate}.`,
      );
    }
  }

  return point;
}

export function validateVisualResult(value: unknown): VisualResult {
  if (!isRecord(value)) {
    throw new VisualValidationError('Program result must be an object.');
  }

  if (!Array.isArray(value.points)) {
    throw new VisualValidationError('Program result must include a points array.');
  }

  if (
    value.points.length < VISUAL_LIMITS.minPoints ||
    value.points.length > VISUAL_LIMITS.maxPoints
  ) {
    throw new VisualValidationError(
      `points must contain ${VISUAL_LIMITS.minPoints}–${VISUAL_LIMITS.maxPoints} entries.`,
    );
  }

  if (!isRecord(value.render)) {
    throw new VisualValidationError('Program result must include render settings.');
  }

  const radius = finiteNumber(value.render.radius, 'render.radius');
  if (radius < VISUAL_LIMITS.minRadius || radius > VISUAL_LIMITS.maxRadius) {
    throw new VisualValidationError(
      `render.radius must be between ${VISUAL_LIMITS.minRadius} and ${VISUAL_LIMITS.maxRadius}.`,
    );
  }

  if (
    value.render.closed !== undefined &&
    typeof value.render.closed !== 'boolean'
  ) {
    throw new VisualValidationError('render.closed must be a boolean when provided.');
  }

  const result: VisualResult = {
    points: value.points.map(validatePoint),
    render: {
      radius,
      ...(value.render.closed === undefined
        ? {}
        : { closed: value.render.closed }),
    },
    // Existing zero-argument programs predate parameters and remain valid.
    parameterSchema: validateParameterSchema(
      value.parameterSchema === undefined ? {} : value.parameterSchema,
    ),
  };

  const serialized = JSON.stringify(result);
  if (new TextEncoder().encode(serialized).byteLength > VISUAL_LIMITS.maxSerializedBytes) {
    throw new VisualValidationError('Program result is too large to return safely.');
  }

  return result;
}

import { describe, expect, it } from 'vitest';
import {
  normalizeParameterValues,
  normalizeCompatibleParameterValues,
  PARAMETER_LIMITS,
  validateParameterSchema,
  validateVisualExecutionInput,
  validateVisualResult,
  VISUAL_LIMITS,
} from './validation';

function validResult() {
  return {
    points: Array.from({ length: 8 }, (_, index) => ({
      x: index,
      y: index / 2,
      z: -index,
    })),
    render: { radius: 0.2 },
    parameterSchema: {},
  };
}

describe('validateVisualResult', () => {
  it('normalizes a valid visual result', () => {
    expect(validateVisualResult(validResult())).toEqual(validResult());
  });

  it('rejects point counts outside the bounded range', () => {
    expect(() =>
      validateVisualResult({ ...validResult(), points: [{ x: 0, y: 0, z: 0 }] }),
    ).toThrow(/8–500/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '3']) (
    'rejects a non-finite coordinate: %s',
    (x) => {
      const result = validResult();
      result.points[0].x = x as number;
      expect(() => validateVisualResult(result)).toThrow(/finite number/);
    },
  );

  it('rejects coordinates outside the sane range', () => {
    const result = validResult();
    result.points[0].z = VISUAL_LIMITS.maxCoordinate + 1;
    expect(() => validateVisualResult(result)).toThrow(/exceeds/);
  });

  it.each([0, VISUAL_LIMITS.maxRadius + 1, Number.NaN])(
    'rejects an invalid radius: %s',
    (radius) => {
      const result = validResult();
      result.render.radius = radius;
      expect(() => validateVisualResult(result)).toThrow(/render.radius/);
    },
  );

  it('rejects a non-boolean closed setting', () => {
    expect(() =>
      validateVisualResult({
        ...validResult(),
        render: { radius: 0.2, closed: 'yes' },
      }),
    ).toThrow(/render.closed/);
  });

  it('keeps legacy results compatible by supplying an empty schema', () => {
    const { parameterSchema: _schema, ...legacyResult } = validResult();
    expect(validateVisualResult(legacyResult).parameterSchema).toEqual({});
  });

  it('rejects an explicitly malformed schema instead of treating it as legacy', () => {
    expect(() =>
      validateVisualResult({ ...validResult(), parameterSchema: null }),
    ).toThrow(/parameterSchema/);
  });
});

describe('numeric parameter validation', () => {
  const schema = {
    radius: {
      type: 'number' as const,
      label: 'Overall radius',
      default: 4,
      min: 1,
      max: 10,
      step: 0.5,
    },
  };

  it('normalizes a valid numeric schema and runtime input', () => {
    expect(validateParameterSchema(schema)).toEqual(schema);
    expect(validateVisualExecutionInput({ params: { radius: 7 } })).toEqual({
      params: { radius: 7 },
    });
  });

  it('fills defaults and clamps finite runtime values to declared bounds', () => {
    expect(normalizeParameterValues(schema, {})).toEqual({ radius: 4 });
    expect(normalizeParameterValues(schema, { radius: 100 })).toEqual({
      radius: 10,
    });
  });

  it('reconciles a structural edit by dropping obsolete values', () => {
    expect(normalizeCompatibleParameterValues(schema, {
      radius: 7,
      obsolete_control: 9,
    })).toEqual({ radius: 7 });
  });

  it.each([
    [{ Radius: schema.radius }, /Parameter id/],
    [{ constructor: schema.radius }, /Parameter id/],
    [{ radius: { ...schema.radius, default: 11 } }, /default/],
    [{ radius: { ...schema.radius, min: 10 } }, /less than/],
    [{ radius: { ...schema.radius, step: 0 } }, /step/],
  ])('rejects an invalid schema: %o', (candidate, message) => {
    expect(() => validateParameterSchema(candidate)).toThrow(message);
  });

  it('rejects giant schemas, unknown values, and non-finite values', () => {
    const giantSchema = Object.fromEntries(
      Array.from({ length: PARAMETER_LIMITS.maxCount + 1 }, (_, index) => [
        `control_${index}`,
        schema.radius,
      ]),
    );
    expect(() => validateParameterSchema(giantSchema)).toThrow(/more than/);
    expect(() => normalizeParameterValues(schema, { turns: 4 })).toThrow(
      /Unknown parameter/,
    );
    expect(() =>
      validateVisualExecutionInput({ params: { radius: Number.NaN } }),
    ).toThrow(/finite number/);
  });
});

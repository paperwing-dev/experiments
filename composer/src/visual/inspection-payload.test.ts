import { describe, expect, it } from 'vitest';
import { decodeInspectionVisual, encodeInspectionVisual } from './inspection-payload';

const visual = {
  points: Array.from({ length: 8 }, (_, index) => ({
    x: index - 4,
    y: index / 3,
    z: Math.sin(index),
  })),
  render: { radius: 0.2, closed: true },
  parameterSchema: {},
};

describe('inspection visual payload', () => {
  it('round-trips a validated visual through a URL-safe fragment', () => {
    const payload = encodeInspectionVisual(visual);

    expect(payload).not.toMatch(/[+/=]/);
    expect(decodeInspectionVisual(payload)).toEqual(visual);
  });

  it('rejects malformed or invalid visual payloads', () => {
    expect(() => decodeInspectionVisual('not-json')).toThrow();
    expect(() =>
      decodeInspectionVisual(
        encodeInspectionVisual({ ...visual, points: visual.points.slice(0, 1) }),
      ),
    ).toThrow(/8–500/);
  });
});

import type { VisualResult } from './types';

export const DEMO_VISUAL: VisualResult = {
  points: Array.from({ length: 100 }, (_, index) => {
    const t = index / 99;
    const angle = t * Math.PI * 8;
    const distance = 0.8 + t * 5.5;
    return {
      x: Math.cos(angle) * distance,
      y: t * 2.4 - 1.2,
      z: Math.sin(angle) * distance,
    };
  }),
  render: { radius: 0.11 },
  parameterSchema: {},
};

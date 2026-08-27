import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import type {
  ParameterSchema,
  ResolvedVisualProgram,
  VisualExecutionInput,
  VisualProgramExecutor,
  VisualResult,
} from './types';
import {
  executeVisualProgram,
  executeVisualProgramWithParameters,
} from './run';

export const PROBE_PROGRAM = `async () => {
  const points = [];
  for (let index = 0; index < 80; index += 1) {
    const t = index / 79;
    const angle = t * Math.PI * 10;
    const distance = 0.5 + t * 5;
    points.push({
      x: Math.cos(angle) * distance,
      y: t * 2,
      z: Math.sin(angle) * distance,
    });
  }
  return { points, render: { radius: 0.12 } };
}`;

export function createVisualExecutor(
  loader: WorkerLoader,
  timeout = 5_000,
): VisualProgramExecutor {
  return new DynamicWorkerExecutor({
    loader,
    timeout,
    globalOutbound: null,
  });
}

export function runVisualProgram(
  loader: WorkerLoader,
  code: string,
  input: VisualExecutionInput = { params: {} },
): Promise<VisualResult> {
  return executeVisualProgram(createVisualExecutor(loader), code, input);
}

export function runVisualProgramWithParameters(
  loader: WorkerLoader,
  code: string,
  params: Record<string, number> = {},
  expectedSchema?: ParameterSchema,
  timeout = 5_000,
): Promise<ResolvedVisualProgram> {
  return executeVisualProgramWithParameters(
    createVisualExecutor(loader, timeout),
    code,
    params,
    expectedSchema,
  );
}

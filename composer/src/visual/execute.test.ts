import { describe, expect, it, vi } from 'vitest';
import {
  executeVisualProgram,
  executeVisualProgramWithParameters,
  MAX_PROGRAM_LENGTH,
} from './run';
import type { VisualProgramExecutor } from './types';

const result = {
  points: Array.from({ length: 8 }, (_, index) => ({ x: index, y: 0, z: 0 })),
  render: { radius: 0.1 },
  parameterSchema: {},
};

describe('executeVisualProgram', () => {
  it('runs source without exposing host functions and validates the result', async () => {
    const execute = vi.fn(async () => ({ result }));
    const executor: VisualProgramExecutor = { execute };

    await expect(executeVisualProgram(executor, ' async () => ({}) ')).resolves.toEqual(
      result,
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('return await program({"params":{}});'),
      [],
    );
  });

  it('passes finite runtime parameters into the same persisted source', async () => {
    const execute = vi.fn(async (_code: string, _providers: []) => ({ result }));
    const executor: VisualProgramExecutor = { execute };

    await executeVisualProgram(executor, 'async ({ params }) => ({ params })', {
      params: { radius: 4.5 },
    });

    const executedSource = execute.mock.calls[0]?.[0];
    expect(executedSource).toContain('async ({ params }) => ({ params })');
    expect(executedSource).toContain('{"params":{"radius":4.5}}');
  });

  it('retains Code Mode normalization for fenced generated source', async () => {
    const execute = vi.fn(async (_code: string, _providers: []) => ({ result }));
    const executor: VisualProgramExecutor = { execute };

    await executeVisualProgram(
      executor,
      '```js\nasync ({ params }) => ({ params })\n```',
      { params: { radius: 2 } },
    );

    const executedSource = execute.mock.calls[0]?.[0];
    expect(executedSource).toContain('async ({ params }) => ({ params })');
    expect(executedSource).not.toContain('```');
  });

  it('rejects invalid runtime parameters before execution', async () => {
    const execute = vi.fn(async () => ({ result }));
    const executor: VisualProgramExecutor = { execute };

    await expect(
      executeVisualProgram(executor, 'async () => ({})', {
        params: { radius: Number.POSITIVE_INFINITY },
      }),
    ).rejects.toThrow(/finite number/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('surfaces sandbox errors', async () => {
    const executor: VisualProgramExecutor = {
      execute: vi.fn(async () => ({ result: undefined, error: 'loop timed out' })),
    };

    await expect(executeVisualProgram(executor, 'async () => ({})')).rejects.toThrow(
      'Program failed: loop timed out',
    );
  });

  it('rejects empty and oversized programs before execution', async () => {
    const execute = vi.fn(async () => ({ result }));
    const executor: VisualProgramExecutor = { execute };

    await expect(executeVisualProgram(executor, '   ')).rejects.toThrow(/empty/);
    await expect(
      executeVisualProgram(executor, 'x'.repeat(MAX_PROGRAM_LENGTH + 1)),
    ).rejects.toThrow(/exceed/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('executeVisualProgramWithParameters', () => {
  const parameterSchema = {
    radius: {
      type: 'number' as const,
      label: 'Overall radius',
      default: 3,
      min: 1,
      max: 5,
      step: 0.5,
    },
  };
  const parameterizedResult = { ...result, parameterSchema };

  it('discovers defaults and reruns new source with durable values', async () => {
    const execute = vi.fn(async (_code: string, _providers: []) => ({
      result: parameterizedResult,
    }));
    const executor: VisualProgramExecutor = { execute };

    await expect(
      executeVisualProgramWithParameters(executor, 'async () => ({})'),
    ).resolves.toEqual({
      params: { radius: 3 },
      visual: parameterizedResult,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toContain('{"params":{}}');
    expect(execute.mock.calls[1]?.[0]).toContain(
      '{"params":{"radius":3}}',
    );
  });

  it('does not expose stale values to new source before discovering its bounds', async () => {
    const execute = vi.fn(async (code: string, _providers: []) => {
      if (code.includes('{"params":{"radius":50}}')) {
        return {
          result: {
            ...parameterizedResult,
            points: parameterizedResult.points.map((point) => ({
              ...point,
              x: 2_000,
            })),
          },
        };
      }
      return { result: parameterizedResult };
    });
    const executor: VisualProgramExecutor = { execute };

    await expect(executeVisualProgramWithParameters(
      executor,
      'async () => ({})',
      { radius: 50 },
    )).resolves.toMatchObject({ params: { radius: 5 } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toContain('{"params":{}}');
    expect(execute.mock.calls[1]?.[0]).toContain(
      '{"params":{"radius":5}}',
    );
  });

  it('normalizes known params before one reexecution and requires stable schema', async () => {
    const execute = vi.fn(async (_code: string, _providers: []) => ({
      result: parameterizedResult,
    }));
    const executor: VisualProgramExecutor = { execute };

    await expect(executeVisualProgramWithParameters(
      executor,
      'async () => ({})',
      { radius: 99 },
      parameterSchema,
    )).resolves.toMatchObject({ params: { radius: 5 } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toContain('{"params":{"radius":5}}');
  });

  it('rejects a schema that changes while the same revision is reexecuted', async () => {
    const execute = vi.fn(async (_code: string, _providers: []) => ({
      result: { ...result, parameterSchema: {} },
    }));
    const executor: VisualProgramExecutor = { execute };

    await expect(executeVisualProgramWithParameters(
      executor,
      'async () => ({})',
      { radius: 3 },
      parameterSchema,
    )).rejects.toThrow(/different parameterSchema/);
  });
});

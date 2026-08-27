import type {
  ResolvedVisualProgram,
  VisualExecutionInput,
  VisualProgramExecution,
  VisualProgramExecutor,
  VisualResult,
} from './types';
import {
  normalizeCompatibleParameterValues,
  normalizeParameterValues,
  parameterSchemasEqual,
  parameterValuesEqual,
  validateParameterSchema,
  validateVisualExecutionInput,
  validateVisualResult,
} from './validation';

export const MAX_PROGRAM_LENGTH = 20_000;

export class VisualProgramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualProgramError';
  }
}

function invocationSource(
  source: string,
  input: VisualExecutionInput,
): string {
  const fenced = source.match(
    /^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/,
  );
  const expression = (fenced?.[1] ?? source).trim().replace(/;\s*$/, '');
  return `async () => {
  const program = (${expression});
  return await program(${JSON.stringify(input)});
}`;
}

export async function executeVisualProgram(
  executor: VisualProgramExecutor,
  code: string,
  input: VisualExecutionInput = { params: {} },
): Promise<VisualResult> {
  const source = code.trim();
  if (!source) {
    throw new VisualProgramError('Program code cannot be empty.');
  }

  if (source.length > MAX_PROGRAM_LENGTH) {
    throw new VisualProgramError(
      `Program code cannot exceed ${MAX_PROGRAM_LENGTH} characters.`,
    );
  }

  const executionInput = validateVisualExecutionInput(input);

  let execution: VisualProgramExecution;
  try {
    execution = await executor.execute(
      invocationSource(source, executionInput),
      [],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown sandbox failure.';
    throw new VisualProgramError(`Sandbox failed: ${message}`);
  }

  if (execution.error) {
    throw new VisualProgramError(`Program failed: ${execution.error}`);
  }

  return validateVisualResult(execution.result);
}

export async function executeVisualProgramWithParameters(
  executor: VisualProgramExecutor,
  code: string,
  params: Record<string, number> = {},
  expectedSchema?: unknown,
): Promise<ResolvedVisualProgram> {
  if (expectedSchema !== undefined) {
    const schema = validateParameterSchema(expectedSchema);
    const normalizedParams = normalizeParameterValues(schema, params);
    const visual = await executeVisualProgram(executor, code, {
      params: normalizedParams,
    });
    if (!parameterSchemasEqual(schema, visual.parameterSchema)) {
      throw new VisualProgramError(
        'Program returned a different parameterSchema for the same revision.',
      );
    }
    return { params: normalizedParams, visual };
  }

  const suppliedParams = validateVisualExecutionInput({ params }).params;
  const discoveryParams: Record<string, number> = {};
  const discoveryVisual = await executeVisualProgram(executor, code, {
    params: discoveryParams,
  });
  const normalizedParams = normalizeCompatibleParameterValues(
    discoveryVisual.parameterSchema,
    suppliedParams,
  );
  if (parameterValuesEqual(discoveryParams, normalizedParams)) {
    return { params: normalizedParams, visual: discoveryVisual };
  }

  const visual = await executeVisualProgram(executor, code, {
    params: normalizedParams,
  });
  if (!parameterSchemasEqual(
    discoveryVisual.parameterSchema,
    visual.parameterSchema,
  )) {
    throw new VisualProgramError(
      'Program parameterSchema must be deterministic across executions.',
    );
  }
  return { params: normalizedParams, visual };
}

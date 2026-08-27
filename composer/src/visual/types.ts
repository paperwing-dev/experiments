export interface VisualPoint {
  x: number;
  y: number;
  z: number;
}

export interface NumberParameter {
  type: 'number';
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export type ParameterSchema = Record<string, NumberParameter>;

export interface VisualExecutionInput {
  params: Record<string, number>;
}

export interface VisualResult {
  points: VisualPoint[];
  render: {
    radius: number;
    closed?: boolean;
  };
  parameterSchema: ParameterSchema;
}

export interface ResolvedVisualProgram {
  params: Record<string, number>;
  visual: VisualResult;
}

export interface VisualProgramExecution {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface VisualProgramExecutor {
  execute(
    code: string,
    providers: [],
  ): Promise<VisualProgramExecution>;
}

'use agent';

import { env } from 'cloudflare:workers';
import {
  setProvider,
  useAgentFinish,
  useAgentStart,
  useDataWriter,
  useDelivery,
  useModel,
  usePersistentState,
  useTool,
} from '@flue/runtime';
import * as v from 'valibot';
import {
  acceptPendingRevision,
  assertVisualRunCanStart,
  beginVisualInspection,
  completeVisualInspection,
  failVisualInspection,
  recordVisualRun,
  startDesignTurn,
} from './design-turn';
import type {
  DesignTurnState,
  DesignTurnTransition,
  VisualCandidateRevision,
} from './design-turn';
import { resolveComposerModels } from './design-model';
import {
  DESIGN_AGENT_DURABILITY,
  inspectionSignal,
} from './design-limits';
import { parseDesignDirection } from './design-direction';
import { parseHistoryControl } from './history-control';
import type { HistoryControl } from './history-control';
import {
  PARAMETER_EDIT_MODEL,
  parameterEditProvider,
} from './parameter-edit-model';
import {
  commitParameterEditRevision,
  parseParameterEditSignal,
} from './parameter-edit';
import {
  appendRevision,
  createDesignHistory,
  currentRevision,
  designHistorySnapshot,
  migrateLegacyArtwork,
  restoreRevision,
  undoRevision,
} from '../history/design-history';
import type { DesignHistory } from '../history/design-history';
import { runVisualProgramWithParameters } from '../visual/execute';
import { captureInspectionScreenshot } from '../visual/inspection';
import { MAX_PROGRAM_LENGTH } from '../visual/run';
import type { ParameterSchema } from '../visual/types';
import {
  normalizeParameterValues,
} from '../visual/validation';

setProvider(parameterEditProvider());

const pointSchema = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
});

const numberParameterSchema = v.object({
  type: v.literal('number'),
  label: v.string(),
  default: v.number(),
  min: v.number(),
  max: v.number(),
  step: v.number(),
});

const parameterSchemaSchema = v.record(v.string(), numberParameterSchema);
const parameterValuesSchema = v.record(v.string(), v.number());

const revisionVisualSchema = v.object({
  points: v.array(pointSchema),
  render: v.object({
    radius: v.number(),
    closed: v.optional(v.boolean()),
  }),
  parameterSchema: parameterSchemaSchema,
  params: parameterValuesSchema,
  revisionId: v.string(),
  code: v.string(),
});

type VisualToolResult = {
  output: v.InferOutput<typeof revisionVisualSchema>;
  terminate: true;
};

const revisionKindSchema = v.picklist([
  'initial',
  'edit',
  'parameter-edit',
  'variation',
]);

const designHistorySnapshotSchema = v.object({
  currentRevisionId: v.nullable(v.string()),
  revisions: v.array(v.object({
    id: v.string(),
    parentId: v.nullable(v.string()),
    kind: revisionKindSchema,
    instruction: v.string(),
    createdAt: v.number(),
    turnId: v.optional(v.string()),
  })),
});

const programSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_PROGRAM_LENGTH + 500),
);

const visualCritiqueSchema = v.object({
  summary: v.pipe(v.string(), v.maxLength(600)),
  observations: v.pipe(
    v.array(v.object({
      category: v.picklist([
        'silhouette',
        'balance',
        'density',
        'symmetry',
        'depth',
        'continuity',
        'collision',
        'framing',
      ]),
      observation: v.pipe(v.string(), v.maxLength(350)),
      severity: v.picklist(['low', 'medium', 'high']),
    })),
    v.maxLength(8),
  ),
  suggestedChanges: v.pipe(
    v.array(v.object({
      goal: v.pipe(v.string(), v.maxLength(300)),
      region: v.optional(v.picklist(['start', 'middle', 'end', 'global'])),
      magnitude: v.picklist(['small', 'medium']),
    })),
    v.maxLength(4),
  ),
  needsRevision: v.boolean(),
});

function normalizeProgramSource(value: string): string {
  const source = value.trim();
  const fenced = source.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? source).trim();
}

function inspectionPrompt(intent: string): string {
  return `You are inspecting a canonical render of a procedural 3D curve.

The user's design intent is this JSON string:
${JSON.stringify(intent)}

Evaluate only what is actually visible in the attached render. Do not infer the underlying mathematical program. Separate observable visual facts from subjective preference. Do not praise the artwork, assign aesthetic scores, or add generic art criticism.

Identify only changes that materially support the stated design intent. Prefer needsRevision=false when the render already satisfies it. Suggested changes must be feasible through a small edit to the existing generative JavaScript, must preserve successful properties, and must use only small or medium magnitude. Return structured output by calling finish; call no other tool.`;
}

function instructions(
  currentCode: string | null,
  currentRevisionId: string | null,
  currentParams: Record<string, number>,
  currentParameterSchema: ParameterSchema,
): string {
  const artwork = currentCode
    ? `<current-program revision-id="${currentRevisionId}">\n${currentCode}\n</current-program>
<current-params>${JSON.stringify(currentParams)}</current-params>
<available-parameter-schema>${JSON.stringify(currentParameterSchema)}</available-parameter-schema>`
    : '<current-program>There is no artwork yet. Create the first one.</current-program>';

  return `You are DesignAgent, a concise generative-art programmer with one selective visual-inspection capability.

Begin with exactly one tool call per model response; never batch tool calls. Never print, narrate, or simulate a tool call in text; an artwork exists only after a real tool succeeds.

For a new visual or structural edit, call run_visual_program with one complete, deterministic async arrow function shaped like async ({ params }) => VisualResult. It must return:
{ points: [{ x: number, y: number, z: number }, ...], render: { radius: number, closed?: boolean }, parameterSchema }

Each generated program must declare approximately 3–6 meaningful numeric controls in parameterSchema. Every definition has exactly { type: "number", label, default, min, max, step }. Choose dimensions a person would intentionally adjust, such as turns, overall_radius, irregularity, vertical_rise, wave_frequency, or thickness. Never expose loop indices, theta, TAU, sampling counts, or other implementation constants. Keep the schema deterministic and unchanged when only runtime values change. Inside the program, read each current value from params with its declared default as fallback, for example const turns = params.turns ?? parameterSchema.turns.default. Defaults live in source; current runtime values never do.

Use 8–500 finite points and ordinary JavaScript math. Keep coordinates within -1000…1000 and radius within 0.005…100. Do not use imports, fetch, eval, Function, Date, Math.random, external data, or toolkits. Prefer 80–180 points and deterministic formulas so edits can preserve geometry exactly.

If a later request maps cleanly to one or more controls in AVAILABLE PARAMETER SCHEMA, call set_visual_parameters with only those changed values and do not rewrite the program. Examples: "make it thinner" changes thickness; "give it more turns" changes turns; "increase the rise" changes vertical_rise. A request such as "split the outer third into two intertwined tendrils" is structural, so edit the current program and call run_visual_program. Structural edits may change the schema. Preserve the existing schema and all unaffected runtime values whenever they remain meaningful.

For the first request, author one new program. For every later structural request, edit the current program rather than replacing it with an unrelated design. Preserve anything the user did not ask to change. If execution fails, inspect the error and make at most two focused repairs. Never paste program source into normal chat text; the visual-program viewer shows it. Do not answer the user without a successful tool result unless every permitted repair failed.

run_visual_program has an inspect boolean. Set inspect=true only for ambiguous aesthetic goals such as strange, elegant, balanced, interesting, less boring, or visually stronger, or when the user explicitly asks for visual evaluation. Do not request inspection merely because this is the first artwork. The application automatically inspects a successful eligible render; do not call an inspection tool or run another program unless an internal visual-correction signal arrives. Set inspect=false for concrete structural requests. set_visual_parameters does not request inspection.

The inspection and correction limits reset for each new user message; runs and inspections from earlier user messages do not count against the current request. If the application sends a visual-correction signal, make at most ONE corrective run_visual_program call with inspect=false. That correction must be small, directly connected to the structured critique in the signal, and preserve successful properties and everything the user did not ask to change. Never inspect the correction and never perform a third successful program run. If no correction signal arrives, the successful run is final. If an internal turn guard rejects a premature run, do not mention it to the user; wait for the application-owned inspection outcome. Do not mention screenshot or critique mechanics to the user unless asked.

${artwork}`;
}

function applyHistoryControl(
  history: DesignHistory,
  control: HistoryControl,
): DesignHistory {
  return control.action === 'undo'
    ? undoRevision(history)
    : restoreRevision(history, control.revisionId);
}

export function DesignAgent() {
  const delivery = useDelivery();
  const parameterEdit = parseParameterEditSignal(delivery);
  const models = resolveComposerModels(env);
  useModel(
    parameterEdit ? PARAMETER_EDIT_MODEL : models.design,
    parameterEdit
      ? { thinkingLevel: 'off', compaction: false }
      : { thinkingLevel: 'low' },
  );

  const [legacyCurrentCode] = usePersistentState<string | null>(
    'currentCode',
    null,
  );
  const [legacyRevision] = usePersistentState('revision', 0);
  const [history, setHistory] = usePersistentState<DesignHistory>(
    'designHistory',
    createDesignHistory(),
  );
  const historyControl = delivery.kind === 'user'
    ? parseHistoryControl(delivery.body)
    : null;
  const direction = delivery.kind === 'user' && !historyControl
    ? parseDesignDirection(delivery.body)
    : null;
  const requestedHistory = direction?.baseRevisionId
    ? restoreRevision(history, direction.baseRevisionId)
    : history;
  const activeRevision = currentRevision(requestedHistory);
  const historyIsEmpty = Object.keys(history.revisions).length === 0;
  const currentCode = activeRevision?.code ?? (
    historyIsEmpty ? legacyCurrentCode : null
  );
  const currentRevisionId = activeRevision?.id ?? null;
  const [turnState, setTurnState] = usePersistentState<DesignTurnState>(
    'designTurn',
    startDesignTurn(currentRevisionId),
  );
  const writeDesignHistory = useDataWriter('designHistory', {
    schema: designHistorySnapshotSchema,
  });
  const writeSelectedVisual = useDataWriter('selectedVisual', {
    schema: revisionVisualSchema,
  });

  function commitCandidate(
    candidate: VisualCandidateRevision,
    expectedParentRevisionId: string | null,
  ): DesignHistory {
    const fallbackLegacyId = crypto.randomUUID();
    let nextHistory: DesignHistory | undefined;
    setHistory((previous) => {
      const migrated = migrateLegacyArtwork(
        previous,
        legacyCurrentCode,
        fallbackLegacyId,
        candidate.createdAt,
      );
      if (migrated.currentRevisionId !== expectedParentRevisionId) {
        throw new Error('The selected revision changed during this design turn.');
      }
      nextHistory = appendRevision(migrated, {
        id: candidate.id,
        code: candidate.code,
        kind: candidate.kind,
        params: candidate.params,
        parameterSchema: candidate.parameterSchema,
        instruction: candidate.instruction,
        createdAt: candidate.createdAt,
        turnId: candidate.turnId,
      });
      return nextHistory;
    });
    if (!nextHistory) {
      throw new Error('The successful visual revision could not be committed.');
    }
    writeDesignHistory(designHistorySnapshot(nextHistory));
    return nextHistory;
  }

  useAgentStart(async ({ log }) => {
    const migrationId = crypto.randomUUID();
    const migrationCreatedAt = Date.now();
    const migrate = (previous: DesignHistory) => migrateLegacyArtwork(
      previous,
      legacyCurrentCode,
      migrationId,
      migrationCreatedAt,
    );
    const baseline = migrate(history);

    if (parameterEdit) {
      const baseRevision = baseline.revisions[parameterEdit.baseRevisionId];
      if (!baseRevision) {
        throw new Error('The parameter edit base revision does not exist.');
      }
      const params = normalizeParameterValues(
        baseRevision.parameterSchema,
        {
          ...baseRevision.params,
          [parameterEdit.parameterId]: parameterEdit.value,
        },
      );
      if (params[parameterEdit.parameterId] === baseRevision.params[parameterEdit.parameterId]) {
        throw new Error('The parameter edit does not change the visual.');
      }
      const execution = await runVisualProgramWithParameters(
        env.LOADER,
        baseRevision.code,
        params,
        baseRevision.parameterSchema,
      );
      const createdAt = Date.now();
      let nextHistory: DesignHistory | undefined;
      setHistory((previous) => {
        const migrated = migrate(previous);
        nextHistory = commitParameterEditRevision(
          migrated,
          parameterEdit,
          execution.params,
          createdAt,
        );
        return nextHistory;
      });
      if (!nextHistory) {
        throw new Error('The parameter edit could not be committed.');
      }

      setTurnState(startDesignTurn(parameterEdit.requestId));
      writeDesignHistory(designHistorySnapshot(nextHistory));
      writeSelectedVisual({
        ...execution.visual,
        params: execution.params,
        revisionId: parameterEdit.requestId,
        code: baseRevision.code,
      });
      log.info('Runtime visual parameter committed without an external model.', {
        parameterId: parameterEdit.parameterId,
        revisionId: parameterEdit.requestId,
      });
      return;
    }

    if (!historyControl) {
      let nextHistory: DesignHistory | undefined;
      setHistory((previous) => {
        const migrated = migrate(previous);
        nextHistory = direction?.baseRevisionId
          ? restoreRevision(migrated, direction.baseRevisionId)
          : migrated;
        return nextHistory;
      });
      if (!nextHistory) {
        throw new Error('The design history could not be initialized.');
      }
      if (baseline !== history) {
        log.info('Legacy artwork migrated into immutable history.', {
          legacyRevision,
          revisionId: baseline.currentRevisionId ?? '',
        });
      }
      writeDesignHistory(designHistorySnapshot(nextHistory));
      if (delivery.kind === 'user') {
        setTurnState(startDesignTurn(
          nextHistory.currentRevisionId,
          direction?.instruction ?? delivery.body,
          direction?.requestId ?? crypto.randomUUID(),
        ));
      }
      return;
    }

    const selected = applyHistoryControl(baseline, historyControl);
    const selectedRevision = currentRevision(selected);
    const execution = selectedRevision
      ? await runVisualProgramWithParameters(
        env.LOADER,
        selectedRevision.code,
        selectedRevision.params,
        selectedRevision.parameterSchema,
      )
      : null;

    let nextHistory: DesignHistory | undefined;
    setHistory((previous) => {
      nextHistory = applyHistoryControl(migrate(previous), historyControl);
      return nextHistory;
    });
    if (!nextHistory) {
      throw new Error('The revision history control could not be applied.');
    }

    writeDesignHistory(designHistorySnapshot(nextHistory));
    if (selectedRevision && execution) {
      writeSelectedVisual({
        ...execution.visual,
        params: execution.params,
        revisionId: selectedRevision.id,
        code: selectedRevision.code,
      });
    }
  });

  useAgentFinish(async ({ append, harness, log, signal }) => {
    if (historyControl || parameterEdit) return;

    let candidateToInspect: VisualCandidateRevision | undefined;
    let fallback: DesignTurnTransition | undefined;
    setTurnState((previous) => {
      if (previous.inspection === 'pending') {
        const inspecting = beginVisualInspection(previous);
        candidateToInspect = inspecting.pendingRevision ?? undefined;
        return inspecting;
      }
      if (previous.inspection === 'revision-needed') {
        fallback = acceptPendingRevision(previous);
        return fallback.state;
      }
      return previous;
    });

    if (fallback?.revisionToCommit) {
      log.warn('Corrective visual run unavailable; accepting inspected candidate.', {
        revisionId: fallback.revisionToCommit.id,
      });
      commitCandidate(
        fallback.revisionToCommit,
        fallback.state.startedAtRevisionId,
      );
      return;
    }
    if (!candidateToInspect) return;

    const candidate = candidateToInspect;
    let stage: 'browser' | 'render' | 'vision' = 'render';
    let critique: v.InferOutput<typeof visualCritiqueSchema>;
    try {
      const execution = await runVisualProgramWithParameters(
        env.LOADER,
        candidate.code,
        candidate.params,
        candidate.parameterSchema,
      );
      stage = 'browser';
      const screenshot = await captureInspectionScreenshot(
        env.BROWSER,
        env.INSPECTION_ORIGIN,
        execution.visual,
      );
      log.info('Canonical visual screenshot captured.', {
        browserMs: screenshot.browserMs ?? -1,
        revisionId: candidate.id,
      });

      stage = 'vision';
      const result = await harness.prompt(
        inspectionPrompt(candidate.instruction),
        {
          images: [{
            type: 'image',
            data: screenshot.data,
            mimeType: screenshot.mimeType,
          }],
          model: models.inspection,
          result: visualCritiqueSchema,
          signal: inspectionSignal(signal),
          thinkingLevel: 'low',
        },
      );
      critique = result.data;
      log.info('Canonical visual critique completed.', {
        model: `${result.model.provider}/${result.model.id}`,
        revisionId: candidate.id,
        totalTokens: result.usage.totalTokens,
      });
    } catch (error) {
      if (signal.aborted) {
        log.warn('Visual inspection cancelled with its parent submission.', {
          revisionId: candidate.id,
          stage,
        });
        throw signal.reason ?? error;
      }
      log.warn('Visual inspection unavailable; accepting validated candidate.', {
        error: error instanceof Error ? error.name : 'UnknownError',
        revisionId: candidate.id,
        stage,
      });
      let failed: DesignTurnTransition | undefined;
      setTurnState((previous) => {
        failed = failVisualInspection(previous);
        return failed.state;
      });
      if (!failed?.revisionToCommit) {
        throw new Error('The validated visual candidate could not be accepted.');
      }
      commitCandidate(failed.revisionToCommit, failed.state.startedAtRevisionId);
      return;
    }

    let completed: DesignTurnTransition | undefined;
    setTurnState((previous) => {
      completed = completeVisualInspection(previous, critique.needsRevision);
      return completed.state;
    });
    if (!completed) {
      throw new Error('The visual inspection result could not be recorded.');
    }
    if (completed.revisionToCommit) {
      commitCandidate(
        completed.revisionToCommit,
        completed.state.startedAtRevisionId,
      );
      return;
    }

    append({
      kind: 'signal',
      type: 'composer.visual-correction-required',
      body: `The application-owned visual inspection requested exactly one small correction. Call run_visual_program once with inspect=false, using this structured critique:\n${JSON.stringify(critique)}\nDo not answer in text.`,
      attributes: { revisionId: candidate.id },
      tagName: 'visual-correction-required',
    });
  });

  let visualRunInFlight: Promise<VisualToolResult> | null = null;

  useTool({
    name: 'run_visual_program',
    description:
      'Execute one complete JavaScript visual program in an isolated Dynamic Worker. Use inspect=true only when the application should inspect this first successful run before accepting it.',
    input: v.object({
      code: programSchema,
      inspect: v.boolean(),
    }),
    output: revisionVisualSchema,
    async run({ data }) {
      if (visualRunInFlight) return visualRunInFlight;

      visualRunInFlight = (async (): Promise<VisualToolResult> => {
        if (historyControl || parameterEdit) {
          throw new Error('Revision controls cannot execute a new visual program.');
        }
        const code = normalizeProgramSource(data.code);
        if (!code || code.length > MAX_PROGRAM_LENGTH) {
          throw new Error('The visual program has an invalid length.');
        }

        let visualRunAccepted = false;
        setTurnState((previous) => {
          assertVisualRunCanStart(previous, data.inspect);
          visualRunAccepted = true;
          return previous;
        });
        if (!visualRunAccepted) {
          throw new Error('The visual run state could not be checked.');
        }
        const sourceParams = turnState.pendingRevision?.params ??
          activeRevision?.params ?? {};
        const execution = await runVisualProgramWithParameters(
          env.LOADER,
          code,
          sourceParams,
        );
        const candidateId = crypto.randomUUID();
        const createdAt = Date.now();
        const fallbackTurnId = crypto.randomUUID();
        let candidate: VisualCandidateRevision | undefined;
        let transition: ReturnType<typeof recordVisualRun> | undefined;
        let expectedParentRevisionId: string | null | undefined;
        setTurnState((previous) => {
          candidate = {
            id: candidateId,
            code,
            kind: previous.startedAtRevisionId === null ? 'initial' : 'edit',
            params: execution.params,
            parameterSchema: execution.visual.parameterSchema,
            instruction: previous.instruction || (
              delivery.kind === 'user' ? delivery.body : 'Visual correction.'
            ),
            createdAt,
            turnId: previous.turnId || fallbackTurnId,
          };
          transition = recordVisualRun(previous, data.inspect, candidate);
          expectedParentRevisionId = previous.startedAtRevisionId;
          return transition.state;
        });
        if (!candidate || !transition || expectedParentRevisionId === undefined) {
          throw new Error('The design turn state could not record this visual run.');
        }
        if (transition.revisionToCommit) {
          commitCandidate(transition.revisionToCommit, expectedParentRevisionId);
        }

        return {
          output: {
            ...execution.visual,
            params: execution.params,
            revisionId: candidate.id,
            code,
          },
          terminate: true,
        };
      })();

      return visualRunInFlight;
    },
  });

  let parameterRunInFlight: Promise<VisualToolResult> | null = null;

  useTool({
    name: 'set_visual_parameters',
    description:
      'Change runtime values for controls already declared by the current visual. Use this instead of rewriting code when the request maps cleanly to available parameters. Send only the values that should change.',
    input: v.object({
      params: parameterValuesSchema,
    }),
    output: revisionVisualSchema,
    async run({ data }) {
      if (parameterRunInFlight) return parameterRunInFlight;

      parameterRunInFlight = (async (): Promise<VisualToolResult> => {
        if (historyControl || parameterEdit) {
          throw new Error('Revision controls cannot edit visual parameters.');
        }
        if (delivery.kind !== 'user') {
          throw new Error(
            'Internal visual-correction turns must use a structural program edit.',
          );
        }
        if (!activeRevision) {
          throw new Error('There is no current visual with editable parameters.');
        }
        if (Object.keys(activeRevision.parameterSchema).length === 0) {
          throw new Error(
            'The current visual has no exposed parameters; make a structural program edit instead.',
          );
        }
        if (Object.keys(data.params).length === 0) {
          throw new Error('At least one parameter value must be changed.');
        }

        const execution = await runVisualProgramWithParameters(
          env.LOADER,
          activeRevision.code,
          { ...activeRevision.params, ...data.params },
          activeRevision.parameterSchema,
        );
        const changed = Object.entries(execution.params).some(
          ([id, value]) => activeRevision.params[id] !== value,
        );
        if (!changed) {
          throw new Error('The requested parameter values do not change the visual.');
        }

        const candidateId = crypto.randomUUID();
        const createdAt = Date.now();
        const fallbackTurnId = crypto.randomUUID();
        let candidate: VisualCandidateRevision | undefined;
        let expectedParentRevisionId: string | null | undefined;
        setTurnState((previous) => {
          assertVisualRunCanStart(previous, false);
          expectedParentRevisionId = previous.startedAtRevisionId;
          candidate = {
            id: candidateId,
            code: activeRevision.code,
            kind: 'parameter-edit',
            params: execution.params,
            parameterSchema: execution.visual.parameterSchema,
            instruction: previous.instruction || (
              delivery.kind === 'user' ? delivery.body : 'Adjust parameters.'
            ),
            createdAt,
            turnId: previous.turnId || fallbackTurnId,
          };
          return {
            ...previous,
            inspection: 'complete',
            pendingRevision: null,
            successfulRuns: 1,
          };
        });
        if (!candidate || expectedParentRevisionId === undefined) {
          throw new Error('The design turn could not record this parameter edit.');
        }
        commitCandidate(candidate, expectedParentRevisionId);

        return {
          output: {
            ...execution.visual,
            params: execution.params,
            revisionId: candidate.id,
            code: activeRevision.code,
          },
          terminate: true,
        };
      })();

      return parameterRunInFlight;
    },
  });

  if (historyControl) {
    return `This is an internal revision-history control delivery. Application code has already applied it. Do not call any tool and do not emit text.`;
  }

  if (parameterEdit) {
    return `This is an internal runtime-parameter commit. Application code has already applied it. Do not call any tool and do not emit text.`;
  }

  return instructions(
    turnState.pendingRevision?.code ?? currentCode,
    turnState.pendingRevision?.id ?? currentRevisionId,
    turnState.pendingRevision?.params ?? activeRevision?.params ?? {},
    turnState.pendingRevision?.parameterSchema ??
      activeRevision?.parameterSchema ?? {},
  );
}

DesignAgent.agentName = 'Design';
DesignAgent.durability = DESIGN_AGENT_DURABILITY;

import { useFlueAgent } from '@flue/react';
import type {
  AgentStatus,
  FlueConversationMessage,
  FlueConversationPart,
  FlueConversationSettlement,
} from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { VisualResult } from '../visual/types';
import {
  designDirectionMessage,
  MAX_DIRECTION_LENGTH,
  parseDesignDirection,
} from '../agents/design-direction';
import { parseHistoryControl } from '../agents/history-control';
import type {
  DesignHistorySnapshot,
  RevisionSummary,
} from '../history/design-history';
import { compactLegacyInspectionDrafts } from '../history/design-history';
import { ArtworkCanvas } from './artwork-canvas';
import { formatProgramForDisplay, tokenizeProgramLine } from './format-program';

interface RevisionVisual extends VisualResult {
  code?: string | null;
  revision?: number;
  revisionId?: string;
}

type DynamicToolPart = Extract<
  FlueConversationPart,
  { type: 'dynamic-tool' }
>;

type StageState = 'active' | 'complete' | 'error' | 'pending';

interface ActivitySnapshot {
  label: string;
  repairing: boolean;
  stages: StageState[];
}

interface ProgramSnapshot {
  code: string | null;
  durationMs?: number;
  revision?: number;
  revisionId?: string;
  state: DynamicToolPart['state'] | 'empty';
}

interface SavedSession {
  createdAt: number;
  id: string;
}

interface ProgramDragState {
  pointerId: number;
  startHeight: number;
  startY: number;
}

interface PanelDragState {
  pointerId: number;
  startWidth: number;
  startX: number;
}

interface PendingDirection {
  baseRevisionId: string | null;
  message: string;
  requestId: string;
  started: boolean;
}

interface RecoveryNotice {
  direction: string;
  kind: 'canceled' | 'error';
  message: string;
  requestId: string;
}

type CancelState = 'accepted' | 'idle' | 'requesting';

const ACTIVITY_STAGES = [
  'Reading direction',
  'Writing visual program',
  'Running visual program',
  'Rendering artwork',
] as const;

const SESSION_KEY = 'composer-conversation';
const SESSIONS_KEY = 'composer-sessions';
const PROGRAM_HEIGHT_KEY = 'composer-program-height';
const CONTROL_PANEL_WIDTH_KEY = 'composer-control-panel-width';
const SELECTED_REVISION_KEY_PREFIX = 'composer-selected-revision:';
const DEFAULT_PROGRAM_HEIGHT = 300;
const MIN_PROGRAM_HEIGHT = 180;
const MIN_STAGE_HEIGHT = 240;
const PROGRAM_KEYBOARD_STEP = 16;
const DEFAULT_CONTROL_PANEL_WIDTH = 400;
const MIN_CONTROL_PANEL_WIDTH = 320;
const MAX_CONTROL_PANEL_WIDTH = 720;
const MIN_WORKSPACE_WIDTH = 480;
const CONTROL_PANEL_KEYBOARD_STEP = 16;
const MAX_RECONCILIATION_FAILURES = 3;
const RECONCILIATION_TIMEOUT_MS = 5_000;
const COMPOSER_MARKER = /\s*<!--\s*composer:[\s\S]*?-->\s*/gi;
const COMMITTED_TOOL_NAMES = new Set([
  'run_visual_program',
  'set_visual_parameters',
  'select_visual_variant',
]);

function readStoredProgramHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(PROGRAM_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= MIN_PROGRAM_HEIGHT
      ? stored
      : DEFAULT_PROGRAM_HEIGHT;
  } catch {
    return DEFAULT_PROGRAM_HEIGHT;
  }
}

function storeProgramHeight(height: number): void {
  try {
    window.localStorage.setItem(PROGRAM_HEIGHT_KEY, String(height));
  } catch {
    // Resizing still works when browser storage is unavailable.
  }
}

function readStoredSelectedRevision(sessionId: string): string | null {
  try {
    return window.localStorage.getItem(`${SELECTED_REVISION_KEY_PREFIX}${sessionId}`);
  } catch {
    return null;
  }
}

function storeSelectedRevision(
  sessionId: string,
  revisionId: string | null,
): void {
  try {
    const key = `${SELECTED_REVISION_KEY_PREFIX}${sessionId}`;
    if (revisionId) window.localStorage.setItem(key, revisionId);
    else window.localStorage.removeItem(key);
  } catch {
    // Revision selection still works when browser storage is unavailable.
  }
}

export function clampControlPanelWidth(width: number, maximum: number): number {
  const safeMaximum = Math.max(MIN_CONTROL_PANEL_WIDTH, maximum);
  return Math.min(safeMaximum, Math.max(MIN_CONTROL_PANEL_WIDTH, width));
}

function maximumControlPanelWidth(): number {
  return Math.min(
    MAX_CONTROL_PANEL_WIDTH,
    Math.max(MIN_CONTROL_PANEL_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH),
  );
}

function readStoredControlPanelWidth(): number {
  try {
    const storedValue = window.localStorage.getItem(CONTROL_PANEL_WIDTH_KEY);
    if (storedValue === null) return DEFAULT_CONTROL_PANEL_WIDTH;
    const stored = Number(storedValue);
    return Number.isFinite(stored)
      ? clampControlPanelWidth(stored, maximumControlPanelWidth())
      : DEFAULT_CONTROL_PANEL_WIDTH;
  } catch {
    return DEFAULT_CONTROL_PANEL_WIDTH;
  }
}

function storeControlPanelWidth(width: number): void {
  try {
    window.localStorage.setItem(CONTROL_PANEL_WIDTH_KEY, String(width));
  } catch {
    // Resizing still works when browser storage is unavailable.
  }
}

function readSavedSessions(): { current: string; sessions: SavedSession[] } {
  const current = window.localStorage.getItem(SESSION_KEY);
  let sessions: SavedSession[] = [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? '[]');
    if (Array.isArray(stored)) {
      sessions = stored.filter(
        (item): item is SavedSession =>
          typeof item?.id === 'string' && typeof item?.createdAt === 'number',
      );
    }
  } catch {
    sessions = [];
  }

  const id = current ?? crypto.randomUUID();
  if (!sessions.some((session) => session.id === id)) {
    sessions = [...sessions, { id, createdAt: Date.now() }];
  }
  window.localStorage.setItem(SESSION_KEY, id);
  window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  return { current: id, sessions };
}

function isVisualResult(value: unknown): value is VisualResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VisualResult>;
  return (
    Array.isArray(candidate.points) &&
    candidate.points.length >= 8 &&
    typeof candidate.render?.radius === 'number'
  );
}

function isRevisionVisual(value: unknown): value is RevisionVisual {
  return (
    isVisualResult(value) &&
    (
      typeof (value as Partial<RevisionVisual>).revisionId === 'string' ||
      typeof (value as Partial<RevisionVisual>).revision === 'number'
    )
  );
}

function isRevisionSummary(value: unknown): value is RevisionSummary {
  if (typeof value !== 'object' || value === null) return false;
  const revision = value as Partial<RevisionSummary>;
  return (
    typeof revision.id === 'string' &&
    (revision.parentId === null || typeof revision.parentId === 'string') &&
    (
      revision.kind === 'initial' ||
      revision.kind === 'edit' ||
      revision.kind === 'parameter-edit' ||
      revision.kind === 'variation'
    ) &&
    typeof revision.instruction === 'string' &&
    typeof revision.createdAt === 'number' &&
    (revision.turnId === undefined || typeof revision.turnId === 'string')
  );
}

function isDesignHistorySnapshot(value: unknown): value is DesignHistorySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const history = value as Partial<DesignHistorySnapshot>;
  return (
    (history.currentRevisionId === null ||
      typeof history.currentRevisionId === 'string') &&
    Array.isArray(history.revisions) &&
    history.revisions.every(isRevisionSummary)
  );
}

function toolsInMessage(message: FlueConversationMessage): DynamicToolPart[] {
  return message.parts.filter(
    (part): part is DynamicToolPart => part.type === 'dynamic-tool',
  );
}

function isCommittedTool(part: DynamicToolPart): boolean {
  return COMMITTED_TOOL_NAMES.has(part.toolName);
}

function selectedVisualInMessage(
  message: FlueConversationMessage,
): RevisionVisual | null {
  for (const part of message.parts) {
    if (part.type === 'data-selectedVisual' && isRevisionVisual(part.data)) {
      return part.data;
    }
  }
  return null;
}

export function latestDesignHistory(
  messages: FlueConversationMessage[],
): DesignHistorySnapshot | null {
  let latest: DesignHistorySnapshot | null = null;
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === 'data-designHistory' &&
        isDesignHistorySnapshot(part.data)
      ) {
        latest = compactLegacyInspectionDrafts(part.data);
      }
    }
  }
  return latest;
}

function programCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : null;
}

export function stripComposerMarkers(value: string): string {
  return value.replace(COMPOSER_MARKER, '').trim();
}

export function containsVisualProgramSource(value: string): boolean {
  return /```(?:javascript|js)?|async\s*\(\s*(?:\{\s*params\s*\})?\s*\)\s*=>/.test(
    value,
  );
}

function rawMessageText(message: FlueConversationMessage): string {
  return message.parts
    .filter((part) => part.type === 'text' && part.text.trim())
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n\n');
}

function messageText(message: FlueConversationMessage): string {
  return stripComposerMarkers(rawMessageText(message));
}

function isHistoryControlDelivery(message: FlueConversationMessage): boolean {
  return message.role === 'user' && parseHistoryControl(rawMessageText(message)) !== null;
}

export function latestRetryableDirection(
  messages: FlueConversationMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !message ||
      message.role !== 'user' ||
      message.display !== 'visible' ||
      isHistoryControlDelivery(message)
    ) {
      continue;
    }
    const instruction = parseDesignDirection(rawMessageText(message)).instruction;
    if (instruction) return instruction;
  }
  return null;
}

export function latestRequestId(
  messages: FlueConversationMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !message ||
      message.role !== 'user' ||
      message.display !== 'visible' ||
      isHistoryControlDelivery(message)
    ) {
      continue;
    }
    const requestId = parseDesignDirection(rawMessageText(message)).requestId;
    if (requestId) return requestId;
  }
  return null;
}

export function canSubmitDirection(
  historyReady: boolean,
  status: AgentStatus,
  interactionBlocked: boolean,
  retryableFailure = false,
): boolean {
  return (
    historyReady &&
    !interactionBlocked &&
    (status === 'idle' || (status === 'error' && retryableFailure))
  );
}

export function revisionForRequest(
  history: DesignHistorySnapshot | null | undefined,
  requestId: string,
): string | null {
  if (!history) return null;
  const current = history.revisions.find(
    (revision) => revision.id === history.currentRevisionId,
  );
  if (current?.turnId === requestId) {
    return history.currentRevisionId;
  }
  for (let index = history.revisions.length - 1; index >= 0; index -= 1) {
    const revision = history.revisions[index];
    if (revision?.turnId === requestId) return revision.id;
  }
  return null;
}

export function inputAfterLateRevision(
  currentInput: string,
  restoredDirection: string,
): string {
  return currentInput === restoredDirection ? '' : currentInput;
}

export function reconciliationExhausted(failures: number): boolean {
  return failures >= MAX_RECONCILIATION_FAILURES;
}

export function submissionIdForRequest(
  messages: FlueConversationMessage[],
  requestId: string,
): string | null {
  for (const message of messages) {
    if (
      message.role === 'user' &&
      message.submissionId &&
      parseDesignDirection(rawMessageText(message)).requestId === requestId
    ) {
      return message.submissionId;
    }
  }
  return null;
}

export function settlementForRequest(
  messages: FlueConversationMessage[],
  settlements: readonly FlueConversationSettlement[],
  requestId: string,
): FlueConversationSettlement | null {
  const submissionId = submissionIdForRequest(messages, requestId);
  return submissionId
    ? settlements.find((settlement) => settlement.submissionId === submissionId) ?? null
    : null;
}

export function latestVisual(
  messages: FlueConversationMessage[],
  currentRevisionId?: string | null,
): RevisionVisual | null {
  let latest: RevisionVisual | null = null;
  let fallback: RevisionVisual | null = null;
  let legacyFallback: RevisionVisual | null = null;
  for (const message of messages) {
    const selected = selectedVisualInMessage(message);
    if (selected) {
      fallback = selected;
      if (!selected.revisionId) legacyFallback = selected;
    }
    if (
      selected &&
      (currentRevisionId === undefined ||
        currentRevisionId === null ||
        selected.revisionId === currentRevisionId)
    ) {
      latest = selected;
    }
    for (const part of toolsInMessage(message)) {
      if (
        isCommittedTool(part) &&
        part.state === 'output-available' &&
        isRevisionVisual(part.output)
      ) {
        const code = programCode(part.output) ?? programCode(part.input);
        const visual = { ...part.output, code };
        fallback = visual;
        if (!visual.revisionId) legacyFallback = visual;
        if (
          currentRevisionId === undefined ||
          currentRevisionId === null ||
          visual.revisionId === currentRevisionId
        ) {
          latest = visual;
        }
      }
    }
  }
  return latest ?? (
    currentRevisionId === undefined || currentRevisionId === null
      ? fallback
      : legacyFallback
  );
}

export function latestProgram(
  messages: FlueConversationMessage[],
  history?: DesignHistorySnapshot | null,
): ProgramSnapshot {
  let latest: ProgramSnapshot = { code: null, state: 'empty' };

  for (const message of messages) {
    for (const part of toolsInMessage(message)) {
      if (!isCommittedTool(part)) continue;
      const code = programCode(part.output) ?? programCode(part.input);
      if (!code) continue;

      const visual = part.state === 'output-available' && isRevisionVisual(part.output)
        ? part.output
        : null;
      latest = {
        code,
        durationMs: part.durationMs,
        revision: visual?.revision ?? (
          visual?.revisionId
            ? revisionNumber(history, visual.revisionId)
            : undefined
        ),
        revisionId: visual?.revisionId,
        state: part.state,
      };
    }
    const selected = selectedVisualInMessage(message);
    if (selected?.code) {
      latest = {
        code: selected.code,
        revision: selected.revision ?? (
          selected.revisionId
            ? revisionNumber(history, selected.revisionId)
            : undefined
        ),
        revisionId: selected.revisionId,
        state: 'output-available',
      };
    }
  }

  if (history?.currentRevisionId) {
    const current = latestVisual(messages, history.currentRevisionId);
    if (current?.code) {
      return {
        code: current.code,
        revision: current.revision ?? revisionNumber(
          history,
          history.currentRevisionId,
        ),
        revisionId: current.revisionId,
        state: 'output-available',
      };
    }
  }
  return latest;
}

function revisionNumber(
  history: DesignHistorySnapshot | null | undefined,
  revisionId: string,
): number | undefined {
  const index = history?.revisions.findIndex((revision) => revision.id === revisionId);
  return index === undefined || index < 0 ? undefined : index + 1;
}

function revisionLabel(
  visual: RevisionVisual | null,
  history?: DesignHistorySnapshot | null,
): string | null {
  if (!visual) return null;
  const ordinal = visual.revision ?? (
    visual.revisionId ? revisionNumber(history, visual.revisionId) : undefined
  );
  return ordinal === undefined
    ? 'Revision'
    : `Revision ${String(ordinal).padStart(2, '0')}`;
}

function messageVisual(message: FlueConversationMessage): RevisionVisual | null {
  const selected = selectedVisualInMessage(message);
  if (selected) return selected;
  for (const part of [...toolsInMessage(message)].reverse()) {
    if (
      isCommittedTool(part) &&
      part.state === 'output-available' &&
      isRevisionVisual(part.output)
    ) {
      return part.output;
    }
  }
  return null;
}

interface ChatTextOptions {
  allowVisualStatus?: boolean;
  history?: DesignHistorySnapshot | null;
}

export function chatText(
  message: FlueConversationMessage,
  options: ChatTextOptions = {},
): string | null {
  if (message.display !== 'visible') return null;

  const text = messageText(message);
  if (text && (message.role !== 'assistant' || !containsVisualProgramSource(text))) {
    return text;
  }
  if (message.role !== 'assistant') return null;

  const visual = messageVisual(message);
  const committed = !visual?.revisionId || !options.history || options.history.revisions.some(
    (revision) => revision.id === visual.revisionId,
  );
  if (visual && committed && options.allowVisualStatus !== false) {
    const label = revisionLabel(visual, options.history);
    return `${label ?? 'Revision'} ready.`;
  }
  return null;
}

export function visibleChatMessages(
  messages: FlueConversationMessage[],
  busy: boolean,
  history?: DesignHistorySnapshot | null,
): { message: FlueConversationMessage; text: string }[] {
  const currentTurnStart = messages.reduce(
    (latest, message, index) => (message.role === 'user' ? index : latest),
    -1,
  );
  let suppressAssistantTurn = false;
  const visible: { message: FlueConversationMessage; text: string }[] = [];

  messages.forEach((message, index) => {
    if (message.role === 'user') {
      suppressAssistantTurn = isHistoryControlDelivery(message);
      if (suppressAssistantTurn) return;
    } else if (suppressAssistantTurn) {
      return;
    }
    if (busy && message.role === 'assistant' && index > currentTurnStart) {
      return;
    }

    const text = chatText(message, {
      allowVisualStatus: !busy || index < currentTurnStart,
      history,
    });
    if (text) visible.push({ message, text });
  });

  return visible;
}

export function latestTurnMessages(
  messages: FlueConversationMessage[],
): FlueConversationMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return messages.slice(lastUserIndex + 1);
}

function latestTurnTools(
  messages: FlueConversationMessage[],
): { inspection: DynamicToolPart | null; program: DynamicToolPart | null } {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && message.display === 'visible') {
      lastUserIndex = index;
      break;
    }
  }

  let inspection: DynamicToolPart | null = null;
  let program: DynamicToolPart | null = null;
  for (const message of messages.slice(lastUserIndex + 1)) {
    for (const part of toolsInMessage(message)) {
      if (
        part.toolName === 'run_visual_program' ||
        part.toolName === 'set_visual_parameters'
      ) {
        program = part;
      }
      if (part.toolName === 'inspect_visual') inspection = part;
    }
  }
  return { inspection, program };
}

function requestsInspection(tool: DynamicToolPart | null): boolean {
  if (!tool || typeof tool.input !== 'object' || tool.input === null) return false;
  return (tool.input as { inspect?: unknown }).inspect === true;
}

export function activitySnapshot(
  messages: FlueConversationMessage[],
  status: AgentStatus,
  hasError: boolean,
  history?: DesignHistorySnapshot | null,
): ActivitySnapshot {
  const { inspection, program: tool } = latestTurnTools(messages);
  const pending: StageState[] = ['pending', 'pending', 'pending', 'pending'];

  if (status === 'idle' || status === 'error') {
    const requestId = latestRequestId(messages);
    const committedRevisionId = requestId
      ? revisionForRequest(history, requestId)
      : null;
    if (committedRevisionId) {
      const ordinal = revisionNumber(history, committedRevisionId);
      const label = ordinal === undefined
        ? 'Revision'
        : `Revision ${String(ordinal).padStart(2, '0')}`;
      return {
        label: `${label} ready`,
        repairing: false,
        stages: ['complete', 'complete', 'complete', 'complete'],
      };
    }
    if (requestId) {
      if (hasError || status === 'error' || tool?.state === 'output-error') {
        const stages = [...pending];
        stages[tool?.state === 'output-error' ? 2 : 0] = 'error';
        return { label: 'Needs attention', repairing: false, stages };
      }
      return { label: 'Ready', repairing: false, stages: pending };
    }
  }

  if (status === 'connecting') {
    return { label: 'Connecting', repairing: false, stages: pending };
  }
  if (hasError || status === 'error') {
    const stages = [...pending];
    stages[tool?.state === 'output-error' ? 2 : 0] = 'error';
    return { label: 'Needs attention', repairing: false, stages };
  }
  if (status === 'submitted') {
    return {
      label: ACTIVITY_STAGES[0],
      repairing: false,
      stages: ['active', 'pending', 'pending', 'pending'],
    };
  }
  if (status === 'streaming') {
    if (!tool) {
      return {
        label: ACTIVITY_STAGES[1],
        repairing: false,
        stages: ['complete', 'active', 'pending', 'pending'],
      };
    }
    if (tool.state === 'input-available') {
      return {
        label: ACTIVITY_STAGES[2],
        repairing: false,
        stages: ['complete', 'complete', 'active', 'pending'],
      };
    }
    if (tool.state === 'output-error') {
      return {
        label: 'Repairing visual program',
        repairing: true,
        stages: ['complete', 'active', 'error', 'pending'],
      };
    }
    if (
      (inspection && inspection.state !== 'output-error') ||
      (tool.state === 'output-available' && requestsInspection(tool))
    ) {
      return {
        label: 'Inspecting artwork',
        repairing: false,
        stages: ['complete', 'complete', 'complete', 'active'],
      };
    }
    return {
      label: ACTIVITY_STAGES[3],
      repairing: false,
      stages: ['complete', 'complete', 'complete', 'active'],
    };
  }

  if (tool?.state === 'output-error') {
    return {
      label: 'Needs attention',
      repairing: false,
      stages: ['complete', 'complete', 'error', 'pending'],
    };
  }

  const visual = tool?.state === 'output-available' && isRevisionVisual(tool.output)
    ? tool.output
    : latestVisual(messages, history?.currentRevisionId);
  if (visual) {
    const label = revisionLabel(visual, history);
    return {
      label: `${label ?? 'Revision'} ready`,
      repairing: false,
      stages: ['complete', 'complete', 'complete', 'complete'],
    };
  }
  return { label: 'Ready', repairing: false, stages: pending };
}

function AgentActivity({ activity }: { activity: ActivitySnapshot }) {
  return (
    <section aria-label="Agent activity" className="agent-activity">
      <header className="activity-header">
        <span>Agent</span>
        <strong aria-live="polite">{activity.label}</strong>
      </header>
      <ol className="stage-list">
        {ACTIVITY_STAGES.map((label, index) => {
          const state = activity.stages[index] ?? 'pending';
          let displayLabel: string = label;
          if (activity.repairing && index === 1) {
            displayLabel = 'Repairing visual program';
          } else if (state === 'active' && index === 3) {
            displayLabel = activity.label;
          }
          return (
            <li
              aria-current={state === 'active' ? 'step' : undefined}
              data-state={state}
              key={label}
            >
              <span aria-hidden="true" className="stage-mark">
                {state === 'complete' ? (
                  <svg viewBox="0 0 12 12">
                    <path d="m2.5 6 2.2 2.2L9.5 3.5" />
                  </svg>
                ) : state === 'active' ? (
                  <i />
                ) : state === 'error' ? (
                  '!'
                ) : null}
              </span>
              <span>{displayLabel}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function VisualProgramPanel({
  activity,
  busy,
  height,
  maximumHeight,
  onResizeKeyDown,
  onResizePointerCancel,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onToggle,
  open,
  program,
}: {
  activity: ActivitySnapshot;
  busy: boolean;
  height: number;
  maximumHeight: number;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onResizePointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggle: () => void;
  open: boolean;
  program: ProgramSnapshot;
}) {
  const status = busy
    ? activity.label
    : program.revision
      ? `Revision ${String(program.revision).padStart(2, '0')}${
          program.durationMs === undefined ? '' : ` · ${program.durationMs}ms`
        }`
      : program.state === 'output-error'
        ? 'Execution failed'
        : program.code
          ? 'Program ready'
          : 'Waiting for first program';
  const lines = formatProgramForDisplay(
    program.code ?? '// Your visual program will appear here.',
  ).split('\n');

  return (
    <section aria-label="Visual program" className="program-panel">
      {open ? (
        <div
          aria-label="Resize visual program terminal"
          aria-orientation="horizontal"
          aria-valuemax={maximumHeight}
          aria-valuemin={MIN_PROGRAM_HEIGHT}
          aria-valuenow={Math.round(height)}
          className="program-resize-handle"
          onKeyDown={onResizeKeyDown}
          onPointerCancel={onResizePointerCancel}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          role="separator"
          tabIndex={0}
          title="Drag to resize terminal"
        >
          <span aria-hidden="true" />
        </div>
      ) : null}
      <header className="program-header">
        <div className="program-title">
          <i aria-hidden="true" />
          <strong>visual-program.js</strong>
        </div>
        <div className="program-actions">
          <span aria-live="polite">{status}</span>
          <button
            aria-expanded={open}
            aria-label={open ? 'Hide visual program' : 'Show visual program'}
            className="square-button program-toggle"
            onClick={onToggle}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="m5 12.5 5-5 5 5" />
            </svg>
          </button>
        </div>
      </header>
      {open ? (
        <div className="program-screen" tabIndex={0}>
          <ol className="program-code">
            {lines.map((line, index) => (
              <li key={`${index}-${line}`}>
                <code>
                  {line
                    ? tokenizeProgramLine(line).map((token, tokenIndex) => (
                        <span
                          className="syntax-token"
                          data-kind={token.kind}
                          key={`${tokenIndex}-${token.kind}`}
                        >
                          {token.text}
                        </span>
                      ))
                    : '\u00a0'}
                </code>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function RevisionHistoryControls({
  busy,
  history,
  onSelect,
  onUndo,
}: {
  busy: boolean;
  history: DesignHistorySnapshot | null;
  onSelect: (revisionId: string) => void;
  onUndo: () => void;
}) {
  if (!history?.currentRevisionId || history.revisions.length === 0) return null;

  const current = history.revisions.find(
    (revision) => revision.id === history.currentRevisionId,
  );
  const recent = history.revisions.slice(-8).reverse();

  return (
    <div className="revision-controls">
      <button
        className="square-button revision-undo"
        disabled={busy || !current?.parentId}
        onClick={onUndo}
        type="button"
      >
        Undo
      </button>
      <details className="revision-history">
        <summary aria-label="Show recent revisions">History</summary>
        <ol>
          {recent.map((revision) => {
            const ordinal = revisionNumber(history, revision.id);
            const selected = revision.id === history.currentRevisionId;
            return (
              <li key={revision.id}>
                <button
                  aria-current={selected ? 'true' : undefined}
                  disabled={busy || selected}
                  onClick={(event) => {
                    event.currentTarget.closest('details')?.removeAttribute('open');
                    onSelect(revision.id);
                  }}
                  title={revision.instruction}
                  type="button"
                >
                  <span>
                    Revision {String(ordinal ?? 0).padStart(2, '0')}
                  </span>
                  <small>{revision.instruction || revision.kind}</small>
                </button>
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}

function WorkspaceToolbar({
  busy,
  history,
  onSelect,
  onUndo,
  viewingHistory,
  visual,
}: {
  busy: boolean;
  history: DesignHistorySnapshot | null;
  onSelect: (revisionId: string) => void;
  onUndo: () => void;
  viewingHistory: boolean;
  visual: RevisionVisual | null;
}) {
  const current = history?.revisions.find(
    (revision) => revision.id === history.currentRevisionId,
  );
  const currentOrdinal = current
    ? revisionNumber(history, current.id)
    : undefined;
  const showingDraft = Boolean(
    busy && visual?.revisionId && visual.revisionId !== history?.currentRevisionId,
  );
  const label = showingDraft
    ? 'Working draft'
    : currentOrdinal === undefined
      ? revisionLabel(visual, history)
      : `${viewingHistory ? 'Viewing ' : ''}Revision ${String(
          currentOrdinal,
        ).padStart(2, '0')}`;

  return (
    <header className="workspace-toolbar">
      <div className="revision-summary">
        <strong>{label ?? 'Workspace'}</strong>
        <span>
          {visual
            ? showingDraft
              ? 'Preparing the next revision'
              : viewingHistory
                ? 'Future directions will start from this revision'
                : current?.instruction || 'Drag to orbit · scroll to zoom'
            : 'Waiting for your first composition'}
        </span>
      </div>
      <RevisionHistoryControls
        busy={busy}
        history={history}
        onSelect={onSelect}
        onUndo={onUndo}
      />
    </header>
  );
}

function ComposerSession({
  onCreateSession,
  onSelectSession,
  sessionId,
  sessions,
}: {
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  sessionId: string;
  sessions: SavedSession[];
}) {
  const [input, setInput] = useState('');
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(
    () => readStoredSelectedRevision(sessionId),
  );
  const [pendingDirection, setPendingDirection] = useState<PendingDirection | null>(
    null,
  );
  const [cancelState, setCancelState] = useState<CancelState>('idle');
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(
    null,
  );
  const [reconciliationFailures, setReconciliationFailures] = useState(0);
  const [programOpen, setProgramOpen] = useState(true);
  const [programHeight, setProgramHeight] = useState(readStoredProgramHeight);
  const [maximumProgramHeight, setMaximumProgramHeight] = useState(
    DEFAULT_PROGRAM_HEIGHT,
  );
  const [controlPanelWidth, setControlPanelWidth] = useState(
    readStoredControlPanelWidth,
  );
  const [maximumPanelWidth, setMaximumPanelWidth] = useState(
    maximumControlPanelWidth,
  );
  const conversationRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const programHeightRef = useRef(programHeight);
  const programDragRef = useRef<ProgramDragState | null>(null);
  const controlPanelWidthRef = useRef(controlPanelWidth);
  const preferredPanelWidthRef = useRef(controlPanelWidth);
  const panelDragRef = useRef<PanelDragState | null>(null);
  const cancelRequestIdRef = useRef(0);
  const reconciliationRequestRef = useRef<string | null>(null);
  const reconciliationTimerRef = useRef<number | null>(null);
  const client = useMemo(
    () => createFlueClient({ url: `/api/agents/design/${sessionId}` }),
    [sessionId],
  );
  const agent = useFlueAgent({ client });
  const busy = agent.status === 'submitted' || agent.status === 'streaming';
  const interactionBusy = (
    busy || pendingDirection !== null || cancelState !== 'idle'
  );
  const submissionReady = canSubmitDirection(
    agent.historyReady,
    agent.status,
    interactionBusy,
    Boolean(recoveryNotice) || agent.failedSends.length > 0,
  );
  const history = useMemo(
    () => latestDesignHistory(agent.messages),
    [agent.messages],
  );
  const displayedRevisionId = selectedRevisionId && history?.revisions.some(
    (revision) => revision.id === selectedRevisionId,
  )
    ? selectedRevisionId
    : history?.currentRevisionId ?? null;
  const displayedHistory = useMemo(
    () => displayedRevisionId && history
      ? { ...history, currentRevisionId: displayedRevisionId }
      : history,
    [displayedRevisionId, history],
  );
  const turnMessages = useMemo(
    () => latestTurnMessages(agent.messages),
    [agent.messages],
  );
  const showingTurnVisual = busy || Boolean(
    pendingDirection?.started &&
    history?.currentRevisionId !== pendingDirection.baseRevisionId,
  );
  const visual = useMemo(
    () => (
      showingTurnVisual ? latestVisual(turnMessages) : null
    ) ?? latestVisual(agent.messages, displayedRevisionId),
    [agent.messages, displayedRevisionId, showingTurnVisual, turnMessages],
  );
  const program = useMemo(
    () => {
      const turnProgram = showingTurnVisual
        ? latestProgram(turnMessages)
        : null;
      return turnProgram?.code
        ? turnProgram
        : latestProgram(agent.messages, displayedHistory);
    },
    [agent.messages, displayedHistory, showingTurnVisual, turnMessages],
  );
  const activity = useMemo(
    () => activitySnapshot(
      agent.messages,
      pendingDirection && !pendingDirection.started
        ? 'submitted'
        : pendingDirection && agent.status === 'error'
          ? 'connecting'
        : agent.status,
      (Boolean(agent.error) && !pendingDirection) || recoveryNotice?.kind === 'error',
      history,
    ),
    [
      agent.error,
      agent.messages,
      agent.status,
      history,
      pendingDirection,
      recoveryNotice?.kind,
    ],
  );
  const chatMessages = useMemo(
    () => visibleChatMessages(agent.messages, busy, history),
    [agent.messages, busy, history],
  );
  const retryableDirection = pendingDirection?.message ?? (
    agent.failedSends.at(-1)?.message
      ? parseDesignDirection(agent.failedSends.at(-1)?.message ?? '').instruction
      : latestRetryableDirection(agent.messages)
  );
  const correlatedSettlement = pendingDirection
    ? settlementForRequest(
      agent.messages,
      agent.settlements,
      pendingDirection.requestId,
    )
    : null;
  const reconciliationBlocked = Boolean(
    pendingDirection &&
    correlatedSettlement &&
    reconciliationExhausted(reconciliationFailures),
  );
  const reconciling = Boolean(
    pendingDirection &&
    !busy &&
    correlatedSettlement &&
    !reconciliationBlocked,
  );

  function clearReconciliationTimer() {
    if (reconciliationTimerRef.current === null) return;
    window.clearTimeout(reconciliationTimerRef.current);
    reconciliationTimerRef.current = null;
  }

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [agent.messages, agent.status]);

  useEffect(() => {
    if (!selectedRevisionId || !history) return;
    if (!history.revisions.some((revision) => revision.id === selectedRevisionId)) {
      setSelectedRevisionId(null);
      storeSelectedRevision(sessionId, null);
    }
  }, [history, selectedRevisionId, sessionId]);

  useEffect(() => () => {
    clearReconciliationTimer();
    reconciliationRequestRef.current = null;
  }, []);

  useEffect(() => {
    if (!pendingDirection) return;
    if (busy && !pendingDirection.started) {
      setPendingDirection({ ...pendingDirection, started: true });
      return;
    }
    const nextRevisionId = revisionForRequest(history, pendingDirection.requestId);
    if (nextRevisionId) {
      cancelRequestIdRef.current += 1;
      reconciliationRequestRef.current = null;
      clearReconciliationTimer();
      setReconciliationFailures(0);
      setSelectedRevisionId(nextRevisionId);
      storeSelectedRevision(sessionId, nextRevisionId);
      setRecoveryNotice(null);
      setCancelState('idle');
      setPendingDirection(null);
      return;
    }

    const settlement = settlementForRequest(
      agent.messages,
      agent.settlements,
      pendingDirection.requestId,
    );
    if (!settlement || busy) return;
    if (reconciliationExhausted(reconciliationFailures)) return;
    if (reconciliationRequestRef.current !== null) return;

    reconciliationRequestRef.current = settlement.submissionId;
    const capturedDirection = pendingDirection;
    void client.history({
      signal: AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS),
    }).then((snapshot) => {
      if (reconciliationRequestRef.current !== settlement.submissionId) return;
      const canonicalHistory = latestDesignHistory(snapshot.messages);
      const canonicalRevisionId = revisionForRequest(
        canonicalHistory,
        capturedDirection.requestId,
      );
      cancelRequestIdRef.current += 1;
      if (canonicalRevisionId) {
        const awaitingMarker = `awaiting:${canonicalRevisionId}`;
        reconciliationRequestRef.current = awaitingMarker;
        setRecoveryNotice(null);
        setCancelState('idle');
        agent.refresh();
        clearReconciliationTimer();
        reconciliationTimerRef.current = window.setTimeout(() => {
          if (reconciliationRequestRef.current !== awaitingMarker) return;
          reconciliationRequestRef.current = null;
          reconciliationTimerRef.current = null;
          setReconciliationFailures((failures) => failures + 1);
        }, RECONCILIATION_TIMEOUT_MS);
        return;
      } else {
        reconciliationRequestRef.current = null;
        clearReconciliationTimer();
        setReconciliationFailures(0);
        const canceled = settlement.outcome === 'aborted';
        setInput(capturedDirection.message);
        setRecoveryNotice({
          direction: capturedDirection.message,
          kind: canceled ? 'canceled' : 'error',
          message: canceled
            ? 'Revision canceled. Your direction is ready to edit or retry.'
            : 'Composer couldn\'t finish this revision. Your direction is ready to edit or retry.',
          requestId: capturedDirection.requestId,
        });
      }
      setCancelState('idle');
      setPendingDirection(null);
    }).catch(() => {
      if (reconciliationRequestRef.current !== settlement.submissionId) return;
      reconciliationRequestRef.current = null;
      agent.refresh();
      reconciliationTimerRef.current = window.setTimeout(() => {
        reconciliationTimerRef.current = null;
        setReconciliationFailures((failures) => failures + 1);
      }, 500);
    });
  }, [
    agent.settlements,
    agent.messages,
    busy,
    client,
    history,
    pendingDirection,
    reconciliationFailures,
    sessionId,
  ]);

  useEffect(() => {
    if (!recoveryNotice) return;
    const revisionId = revisionForRequest(history, recoveryNotice.requestId);
    if (!revisionId) return;
    setSelectedRevisionId(revisionId);
    storeSelectedRevision(sessionId, revisionId);
    reconciliationRequestRef.current = null;
    clearReconciliationTimer();
    setReconciliationFailures(0);
    setRecoveryNotice(null);
    setInput((current) => inputAfterLateRevision(current, recoveryNotice.direction));
  }, [history, recoveryNotice, sessionId]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const reclamp = () => {
      const workspaceHeight = workspace.getBoundingClientRect().height;
      const nextMaximum = Math.max(
        MIN_PROGRAM_HEIGHT,
        workspaceHeight - MIN_STAGE_HEIGHT,
      );
      setMaximumProgramHeight(nextMaximum);
      setProgramHeight((current) => {
        const next = Math.min(nextMaximum, Math.max(MIN_PROGRAM_HEIGHT, current));
        programHeightRef.current = next;
        return next;
      });
    };
    const observer = new ResizeObserver(reclamp);
    observer.observe(workspace);
    window.addEventListener('resize', reclamp);
    reclamp();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reclamp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
  }, []);

  useEffect(() => {
    const reclamp = () => {
      const nextMaximum = maximumControlPanelWidth();
      setMaximumPanelWidth(nextMaximum);
      setControlPanelWidth(() => {
        const next = clampControlPanelWidth(
          preferredPanelWidthRef.current,
          nextMaximum,
        );
        controlPanelWidthRef.current = next;
        return next;
      });
    };
    window.addEventListener('resize', reclamp);
    reclamp();

    return () => window.removeEventListener('resize', reclamp);
  }, []);

  async function submitDirection() {
    const message = input.trim();
    if (!message || !submissionReady) return;
    const baseRevisionId = displayedRevisionId;
    const requestId = crypto.randomUUID();
    reconciliationRequestRef.current = null;
    clearReconciliationTimer();
    setReconciliationFailures(0);
    setRecoveryNotice(null);
    setPendingDirection({
      baseRevisionId,
      message,
      requestId,
      started: false,
    });
    setInput('');
    try {
      await agent.sendMessage(
        designDirectionMessage(message, baseRevisionId, requestId),
      );
    } catch {
      setInput(message);
      setRecoveryNotice({
        direction: message,
        kind: 'error',
        message: 'Composer couldn\'t start this revision. Your direction is ready to edit or retry.',
        requestId,
      });
      setPendingDirection(null);
    }
  }

  async function cancelDirection() {
    if ((!busy && !pendingDirection) || cancelState !== 'idle') return;
    const correlatedRequestId = pendingDirection?.requestId ?? latestRequestId(
      agent.messages,
    );
    if (!correlatedRequestId) {
      agent.refresh();
      return;
    }
    if (!pendingDirection) {
      setPendingDirection({
        baseRevisionId: displayedRevisionId,
        message: retryableDirection ?? '',
        requestId: correlatedRequestId,
        started: true,
      });
    }
    const cancelToken = cancelRequestIdRef.current + 1;
    cancelRequestIdRef.current = cancelToken;
    setCancelState('requesting');
    try {
      const result = await client.abort({ signal: AbortSignal.timeout(5_000) });
      if (cancelRequestIdRef.current !== cancelToken) return;
      if (result.aborted) {
        setCancelState('accepted');
        return;
      }
      setCancelState('idle');
    } catch {
      if (cancelRequestIdRef.current !== cancelToken) return;
      setCancelState('idle');
      setRecoveryNotice({
        direction: retryableDirection ?? '',
        kind: 'error',
        message: 'Composer couldn\'t cancel this revision. It may still be running.',
        requestId: correlatedRequestId,
      });
    }
  }

  function reconnectAgent() {
    reconciliationRequestRef.current = null;
    clearReconciliationTimer();
    setReconciliationFailures(0);
    agent.refresh();
  }

  function selectRevision(revisionId: string) {
    setSelectedRevisionId(revisionId);
    storeSelectedRevision(sessionId, revisionId);
  }

  function updateProgramHeight(nextHeight: number) {
    const next = Math.min(
      maximumProgramHeight,
      Math.max(MIN_PROGRAM_HEIGHT, nextHeight),
    );
    programHeightRef.current = next;
    setProgramHeight(next);
  }

  function startProgramResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    programDragRef.current = {
      pointerId: event.pointerId,
      startHeight: programHeightRef.current,
      startY: event.clientY,
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }

  function continueProgramResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = programDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateProgramHeight(drag.startHeight + drag.startY - event.clientY);
  }

  function finishProgramResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = programDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeProgramHeight(programHeightRef.current);
    programDragRef.current = null;
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }

  function resizeProgramWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const direction = event.key === 'ArrowUp' ? 1 : -1;
    updateProgramHeight(
      programHeightRef.current + direction * PROGRAM_KEYBOARD_STEP,
    );
    storeProgramHeight(programHeightRef.current);
  }

  function updateControlPanelWidth(nextWidth: number) {
    const next = clampControlPanelWidth(nextWidth, maximumPanelWidth);
    preferredPanelWidthRef.current = next;
    controlPanelWidthRef.current = next;
    setControlPanelWidth(next);
  }

  function startPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelDragRef.current = {
      pointerId: event.pointerId,
      startWidth: controlPanelWidthRef.current,
      startX: event.clientX,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function continuePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateControlPanelWidth(drag.startWidth + event.clientX - drag.startX);
  }

  function finishPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeControlPanelWidth(controlPanelWidthRef.current);
    panelDragRef.current = null;
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }

  function resizePanelWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    updateControlPanelWidth(
      controlPanelWidthRef.current + direction * CONTROL_PANEL_KEYBOARD_STEP,
    );
    storeControlPanelWidth(controlPanelWidthRef.current);
  }

  const connectionInterrupted = Boolean(
    agent.error &&
    !pendingDirection &&
    !recoveryNotice &&
    agent.failedSends.length === 0,
  );
  const reconnectAvailable = reconciliationBlocked || connectionInterrupted;
  const promptNotice = recoveryNotice ?? (
    reconciliationBlocked
      ? {
          direction: '',
          kind: 'connection' as const,
          message: 'Composer finished, but the latest revision could not be confirmed. Reconnect to safely restore it.',
          requestId: pendingDirection?.requestId ?? '',
        }
      : connectionInterrupted
        ? {
            direction: '',
            kind: 'connection' as const,
            message: 'Connection interrupted. Reconnect before composing another revision.',
            requestId: '',
          }
        : agent.failedSends.length > 0
          ? {
              direction: retryableDirection ?? '',
              kind: 'error' as const,
              message: 'Composer couldn\'t finish this revision. Your direction is ready to edit or retry.',
              requestId: latestRequestId(agent.messages) ?? '',
            }
          : null
  );
  const retrying = Boolean(
    promptNotice?.direction && input.trim() === promptNotice.direction,
  );
  const promptActionLabel = !agent.historyReady
    ? 'Loading session…'
    : agent.status === 'connecting'
      ? 'Reconnecting…'
      : retrying
        ? 'Retry'
        : visual
          ? 'Compose'
          : 'Start';

  return (
    <main
      className="composer-shell"
      style={{
        '--control-panel-width': `${controlPanelWidth}px`,
      } as CSSProperties}
    >
      <aside className="control-panel">
        <header className="brand-row">
          <a aria-label="Composer home" className="wordmark" href="/">Composer</a>
          <div className="session-actions">
            <select
              aria-label="Switch session"
              onChange={(event) => onSelectSession(event.target.value)}
              value={sessionId}
            >
              {sessions.map((session, index) => (
                <option key={session.id} value={session.id}>Session {index + 1}</option>
              ))}
            </select>
            <button onClick={onCreateSession} type="button">New session</button>
          </div>
        </header>

        <div aria-live="polite" className="conversation" ref={conversationRef}>
          {chatMessages.map(({ message, text }) => (
            <article className="chat-message" data-role={message.role} key={message.id}>
              <span>{message.role === 'user' ? 'You' : 'Composer'}</span>
              <p>{text}</p>
            </article>
          ))}
        </div>

        <AgentActivity activity={activity} />

        <form
          className="prompt-form"
          data-busy={interactionBusy || undefined}
          data-error={promptNotice?.kind === 'error' ? true : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void submitDirection();
          }}
        >
          <textarea
            aria-describedby={promptNotice ? 'prompt-feedback' : undefined}
            aria-label="Describe the artwork or give the agent a new direction"
            disabled={interactionBusy}
            id="prompt"
            maxLength={MAX_DIRECTION_LENGTH}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submitDirection();
              }
            }}
            placeholder={
              agent.historyReady
                ? 'Describe a form or give it a new direction…'
                : 'Loading this session…'
            }
            rows={3}
            value={input}
          />
          {promptNotice ? (
            <p
              aria-live={promptNotice.kind === 'error' ? 'assertive' : 'polite'}
              className="prompt-feedback"
              data-kind={promptNotice.kind}
              id="prompt-feedback"
              role={promptNotice.kind === 'error' ? 'alert' : 'status'}
            >
              {promptNotice.message}
            </p>
          ) : null}
          <div className="prompt-actions">
            {reconnectAvailable ? (
              <button
                aria-label="Reconnect Composer"
                className="square-button"
                onClick={reconnectAgent}
                type="button"
              >
                Reconnect
              </button>
            ) : busy || pendingDirection || cancelState !== 'idle' ? (
              <button
                aria-label={
                  reconciling
                    ? 'Finalizing revision'
                    : cancelState === 'idle'
                      ? 'Cancel revision'
                      : 'Canceling revision'
                }
                className="square-button"
                disabled={reconciling || cancelState !== 'idle'}
                onClick={() => void cancelDirection()}
                type="button"
              >
                {reconciling
                  ? 'Finalizing…'
                  : cancelState === 'idle'
                    ? 'Cancel'
                    : 'Canceling…'}
              </button>
            ) : (
              <button
                aria-label={promptActionLabel}
                className="square-button"
                disabled={!input.trim() || !submissionReady}
                type="submit"
              >
                {promptActionLabel}
              </button>
            )}
          </div>
        </form>

        <div
          aria-label="Resize chat panel"
          aria-orientation="vertical"
          aria-valuemax={maximumPanelWidth}
          aria-valuemin={MIN_CONTROL_PANEL_WIDTH}
          aria-valuenow={Math.round(controlPanelWidth)}
          className="panel-resize-handle"
          onKeyDown={resizePanelWithKeyboard}
          onPointerCancel={finishPanelResize}
          onPointerDown={startPanelResize}
          onPointerMove={continuePanelResize}
          onPointerUp={finishPanelResize}
          role="separator"
          tabIndex={0}
          title="Drag to resize chat panel"
        >
          <span aria-hidden="true" />
        </div>
      </aside>

      <section
        className="visual-workspace"
        data-program-open={programOpen || undefined}
        ref={workspaceRef}
        style={{ '--program-panel-height': `${programHeight}px` } as CSSProperties}
      >
        <section className="stage">
          <WorkspaceToolbar
            busy={interactionBusy}
            history={displayedHistory}
            onSelect={selectRevision}
            onUndo={() => {
              const current = displayedHistory?.revisions.find(
                (revision) => revision.id === displayedHistory.currentRevisionId,
              );
              if (current?.parentId) selectRevision(current.parentId);
            }}
            viewingHistory={Boolean(
              displayedRevisionId &&
              history?.currentRevisionId &&
              displayedRevisionId !== history.currentRevisionId
            )}
            visual={visual}
          />
          <div className="stage-content">
            {visual ? <ArtworkCanvas visual={visual} /> : null}
          </div>
        </section>
        <VisualProgramPanel
          activity={activity}
          busy={interactionBusy}
          height={programHeight}
          maximumHeight={maximumProgramHeight}
          onResizeKeyDown={resizeProgramWithKeyboard}
          onResizePointerCancel={finishProgramResize}
          onResizePointerDown={startProgramResize}
          onResizePointerMove={continueProgramResize}
          onResizePointerUp={finishProgramResize}
          onToggle={() => setProgramOpen((current) => !current)}
          open={programOpen}
          program={program}
        />
      </section>
    </main>
  );
}

export function ComposerApp() {
  const [sessionState, setSessionState] = useState(readSavedSessions);

  function persistSessionState(current: string, sessions: SavedSession[]) {
    window.localStorage.setItem(SESSION_KEY, current);
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    setSessionState({ current, sessions });
  }

  function createSession() {
    const session = { id: crypto.randomUUID(), createdAt: Date.now() };
    persistSessionState(session.id, [...sessionState.sessions, session]);
  }

  return (
    <ComposerSession
      key={sessionState.current}
      onCreateSession={createSession}
      onSelectSession={(sessionId) =>
        persistSessionState(sessionId, sessionState.sessions)}
      sessionId={sessionState.current}
      sessions={sessionState.sessions}
    />
  );
}

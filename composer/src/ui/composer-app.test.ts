import type { FlueConversationMessage } from '@flue/react';
import { describe, expect, it } from 'vitest';
import { designDirectionMessage } from '../agents/design-direction';
import {
  activitySnapshot,
  canSubmitDirection,
  chatText,
  clampControlPanelWidth,
  containsVisualProgramSource,
  inputAfterLateRevision,
  latestDesignHistory,
  latestProgram,
  latestRequestId,
  latestRetryableDirection,
  latestTurnMessages,
  latestVisual,
  reconciliationExhausted,
  revisionForRequest,
  settlementForRequest,
  stripComposerMarkers,
  submissionIdForRequest,
  visibleChatMessages,
} from './composer-app';

describe('chat panel sizing', () => {
  it('keeps the divider within the usable layout bounds', () => {
    expect(clampControlPanelWidth(200, 640)).toBe(320);
    expect(clampControlPanelWidth(480, 640)).toBe(480);
    expect(clampControlPanelWidth(800, 640)).toBe(640);
    expect(clampControlPanelWidth(400, 200)).toBe(320);
  });
});

const userMessage: FlueConversationMessage = {
  id: 'user-1',
  role: 'user',
  purpose: 'user',
  display: 'visible',
  parts: [{ type: 'text', text: 'Make a spiral.', state: 'done' }],
};

function assistantWithTool(
  state: 'input-available' | 'output-available' | 'output-error',
  inspect = false,
): FlueConversationMessage {
  const shared = {
    type: 'dynamic-tool' as const,
    toolName: 'run_visual_program',
    toolCallId: 'tool-1',
    input: { code: 'async () => ({ points: [], render: {} })', inspect },
  };
  const tool = state === 'output-available'
    ? {
        ...shared,
        state,
        output: {
          code: 'async () => ({ points: [], render: {} })',
          points: Array.from({ length: 8 }, (_, index) => ({
            x: index,
            y: 0,
            z: 0,
          })),
          render: { radius: 0.1 },
          revision: 3,
        },
      }
    : state === 'output-error'
      ? { ...shared, state, errorText: 'Failed' }
      : { ...shared, state };

  return {
    id: 'assistant-1',
    role: 'assistant',
    purpose: 'assistant',
    display: 'visible',
    parts: [tool],
  };
}

describe('activitySnapshot', () => {
  it('starts by reading an admitted direction', () => {
    expect(activitySnapshot([userMessage], 'submitted', false)).toMatchObject({
      label: 'Reading direction',
      repairing: false,
      stages: ['active', 'pending', 'pending', 'pending'],
    });
  });

  it('moves to program authoring when the model starts streaming', () => {
    expect(activitySnapshot([userMessage], 'streaming', false).stages).toEqual([
      'complete',
      'active',
      'pending',
      'pending',
    ]);
  });

  it('uses the pending tool call as the execution stage', () => {
    const activity = activitySnapshot(
      [userMessage, assistantWithTool('input-available')],
      'streaming',
      false,
    );
    expect(activity.label).toBe('Running visual program');
    expect(activity.stages).toEqual([
      'complete',
      'complete',
      'active',
      'pending',
    ]);
  });

  it('surfaces a repair after a failed program run', () => {
    const activity = activitySnapshot(
      [userMessage, assistantWithTool('output-error')],
      'streaming',
      false,
    );
    expect(activity.label).toBe('Repairing visual program');
    expect(activity.stages).toEqual([
      'complete',
      'active',
      'error',
      'pending',
    ]);
  });

  it('keeps a terminal program failure visible after the turn settles', () => {
    const activity = activitySnapshot(
      [userMessage, assistantWithTool('output-error')],
      'idle',
      false,
    );
    expect(activity.label).toBe('Needs attention');
    expect(activity.stages).toEqual([
      'complete',
      'complete',
      'error',
      'pending',
    ]);
  });

  it('lets a committed correlated revision supersede a terminal tool error', () => {
    const requestId = '7b375713-28f6-4cfc-8d95-4c728b58b7d1';
    const correlatedUser: FlueConversationMessage = {
      ...userMessage,
      parts: [{
        type: 'text',
        text: designDirectionMessage('Make a spiral.', null, requestId),
        state: 'done',
      }],
    };
    const history = latestDesignHistory([historyMessage('B', requestId)]);

    expect(activitySnapshot(
      [correlatedUser, assistantWithTool('output-error')],
      'idle',
      false,
      history,
    )).toEqual({
      label: 'Revision 02 ready',
      repairing: false,
      stages: ['complete', 'complete', 'complete', 'complete'],
    });
  });

  it('does not announce an uncommitted inspection draft as ready', () => {
    const requestId = '7b375713-28f6-4cfc-8d95-4c728b58b7d1';
    const correlatedUser: FlueConversationMessage = {
      ...userMessage,
      parts: [{
        type: 'text',
        text: designDirectionMessage('Make it balanced.', null, requestId),
        state: 'done',
      }],
    };
    const history = latestDesignHistory([historyMessage('A')]);

    expect(activitySnapshot(
      [correlatedUser, assistantWithTool('output-available', true)],
      'idle',
      false,
      history,
    )).toEqual({
      label: 'Ready',
      repairing: false,
      stages: ['pending', 'pending', 'pending', 'pending'],
    });
  });

  it('names the visual inspection phase after an eligible render', () => {
    const activity = activitySnapshot(
      [userMessage, assistantWithTool('output-available', true)],
      'streaming',
      false,
    );
    expect(activity.label).toBe('Inspecting artwork');
    expect(activity.stages).toEqual([
      'complete',
      'complete',
      'complete',
      'active',
    ]);
  });

  it('retains all completed stages for the latest revision', () => {
    expect(
      activitySnapshot(
        [userMessage, assistantWithTool('output-available')],
        'idle',
        false,
      ),
    ).toMatchObject({
      label: 'Revision 03 ready',
      repairing: false,
      stages: ['complete', 'complete', 'complete', 'complete'],
    });
  });
});

describe('visual and program history', () => {
  it('exposes a program while its tool call is running', () => {
    expect(latestProgram([userMessage, assistantWithTool('input-available')])).toEqual({
      code: 'async () => ({ points: [], render: {} })',
      durationMs: undefined,
      revision: undefined,
      state: 'input-available',
    });
  });

  it('associates a completed program with its revision', () => {
    expect(latestProgram([userMessage, assistantWithTool('output-available')])).toEqual({
      code: 'async () => ({ points: [], render: {} })',
      durationMs: undefined,
      revision: 3,
      state: 'output-available',
    });
  });

  it('treats a semantic parameter tool result as a committed visual', () => {
    const edited = assistantWithRevision(
      'B',
      2,
      'set_visual_parameters',
    );

    expect(latestVisual([edited], 'B')).toMatchObject({
      revisionId: 'B',
      params: {},
      parameterSchema: {},
    });
    expect(latestProgram([edited])).toMatchObject({
      revisionId: 'B',
      code: 'async () => revisionB',
    });
  });

  it('returns to the committed program after a later attempt fails', () => {
    const committed = assistantWithRevision('A', 1);
    const failed = {
      ...assistantWithTool('output-error'),
      id: 'assistant-failed-after-commit',
    };
    const history = latestDesignHistory([historyMessage('A')]);

    expect(latestProgram([committed, failed], history)).toMatchObject({
      code: 'async () => revisionA',
      revision: 1,
      revisionId: 'A',
      state: 'output-available',
    });
  });

  it('restores artwork selected by the removed branching UI', () => {
    const selected: FlueConversationMessage = {
      id: 'assistant-selection',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      parts: [{
        type: 'dynamic-tool',
        toolName: 'select_visual_variant',
        toolCallId: 'select-tool',
        state: 'output-available',
        input: { candidateId: 'batch-1:B' },
        output: {
          code: 'async () => selectedVisual',
          points: Array.from({ length: 8 }, (_, index) => ({ x: index, y: 1, z: 0 })),
          render: { radius: 0.2 },
          revision: 5,
        },
      }],
    };

    expect(latestVisual([selected])).toMatchObject({
      code: 'async () => selectedVisual',
      revision: 5,
    });
    expect(latestProgram([selected])).toMatchObject({
      code: 'async () => selectedVisual',
      revision: 5,
    });
  });

  it('uses the persisted pointer instead of the latest branch output', () => {
    const revisionA = assistantWithRevision('A', 1);
    const revisionB = assistantWithRevision('B', 2);
    const snapshot = historyMessage('A');
    const messages = [revisionA, revisionB, snapshot];
    const history = latestDesignHistory(messages);

    expect(history?.currentRevisionId).toBe('A');
    expect(latestVisual(messages, history?.currentRevisionId)).toMatchObject({
      revisionId: 'A',
      code: 'async () => revisionA',
    });
    expect(latestProgram(messages, history)).toMatchObject({
      revision: 1,
      revisionId: 'A',
      code: 'async () => revisionA',
    });
  });

  it('reads a restored visual and compact history from Flue data parts', () => {
    const snapshot = historyMessage('A');
    const selection: FlueConversationMessage = {
      id: 'assistant-selection-data',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      parts: [{
        type: 'data-selectedVisual',
        data: revisionVisual('A', 4),
      }],
    };

    const history = latestDesignHistory([snapshot]);
    expect(history?.currentRevisionId).toBe('A');
    expect(history?.revisions[0]).toMatchObject({ id: 'A', parentId: null });
    expect(latestVisual([selection], 'A')).toMatchObject({
      revisionId: 'A',
      render: { radius: 0.4 },
    });
  });

  it('hides a legacy inspection draft from durable client history', () => {
    const snapshot: FlueConversationMessage = {
      id: 'assistant-legacy-history',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      parts: [{
        type: 'data-designHistory',
        data: {
          currentRevisionId: 'B',
          revisions: [
            {
              id: 'draft-A',
              parentId: null,
              kind: 'initial',
              instruction: 'Create a sphere.',
              createdAt: 1_000,
            },
            {
              id: 'A',
              parentId: 'draft-A',
              kind: 'edit',
              instruction: 'Create a sphere.',
              createdAt: 2_000,
            },
            {
              id: 'B',
              parentId: 'A',
              kind: 'edit',
              instruction: 'Make it spiral.',
              createdAt: 3_000,
            },
          ],
        },
      }],
    };

    expect(latestDesignHistory([snapshot])?.revisions).toEqual([
      expect.objectContaining({ id: 'A', kind: 'initial', parentId: null }),
      expect.objectContaining({ id: 'B', parentId: 'A' }),
    ]);
  });

  it('keeps the legacy visual visible while its source is migrated', () => {
    const legacy = assistantWithTool('output-available');

    expect(latestVisual([legacy], 'migrated-revision-id')).toMatchObject({
      revision: 3,
      code: 'async () => ({ points: [], render: {} })',
    });
  });
});

describe('conversation display', () => {
  it('keeps old branch metadata out of visible chat', () => {
    expect(
      stripComposerMarkers(
        'Explore this shape.\n\n<!-- composer:explore base-revision="2" -->',
      ),
    ).toBe('Explore this shape.');
  });

  it('recognizes program source that belongs in the terminal', () => {
    expect(containsVisualProgramSource('```javascript\nasync () => ({})\n```')).toBe(true);
    expect(
      containsVisualProgramSource('async ({ params }) => ({ turns: params.turns })'),
    ).toBe(true);
    expect(containsVisualProgramSource('Revision ready.')).toBe(false);
  });

  it('waits for the turn to settle before announcing a completed revision', () => {
    const message = assistantWithTool('output-available');

    expect(chatText(message, { allowVisualStatus: false })).toBeNull();
    expect(chatText(message)).toBe('Revision 03 ready.');
  });

  it('keeps recoverable visual-program errors out of chat', () => {
    expect(chatText(assistantWithTool('output-error'))).toBeNull();
  });

  it('defers current assistant text until the turn settles', () => {
    const narration: FlueConversationMessage = {
      id: 'assistant-narration',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      parts: [{ type: 'text', text: 'The artwork is ready.', state: 'done' }],
    };

    expect(visibleChatMessages([userMessage, narration], true)).toEqual([
      { message: userMessage, text: 'Make a spiral.' },
    ]);
    expect(visibleChatMessages([userMessage, narration], false)).toEqual([
      { message: userMessage, text: 'Make a spiral.' },
      { message: narration, text: 'The artwork is ready.' },
    ]);
  });

  it('uses persisted history to identify a settled revision', () => {
    const message = assistantWithRevision('B', 2);
    const history = latestDesignHistory([historyMessage('B')]);

    expect(chatText(message, { history })).toBe('Revision 02 ready.');
  });

  it('does not announce an inspected draft that was not committed', () => {
    const message = assistantWithRevision('draft-B', 2);
    const history = latestDesignHistory([historyMessage('A')]);

    expect(chatText(message, { history })).toBeNull();
  });

  it('shows only the visible instruction from a revision-based direction', () => {
    const direction: FlueConversationMessage = {
      ...userMessage,
      parts: [{
        type: 'text',
        text: designDirectionMessage('Make it thinner.', 'revision-A'),
        state: 'done',
      }],
    };

    expect(chatText(direction)).toBe('Make it thinner.');
    expect(latestRetryableDirection([direction])).toBe('Make it thinner.');
  });

  it('does not treat a history selection as a retryable direction', () => {
    const control: FlueConversationMessage = {
      ...userMessage,
      parts: [{
        type: 'text',
        text: '<!-- composer:history action="restore" revision-id="A" -->',
        state: 'done',
      }],
    };

    expect(latestRetryableDirection([userMessage, control])).toBe('Make a spiral.');
    expect(latestRetryableDirection([control])).toBeNull();
  });

  it('isolates live visual output to the latest genuine direction', () => {
    const nextUser = { ...userMessage, id: 'user-next' };
    const latest = assistantWithRevision('B', 2);

    expect(latestTurnMessages([
      userMessage,
      assistantWithRevision('A', 1),
      nextUser,
      latest,
    ])).toEqual([latest]);
  });

  it('hides internal revision controls and every assistant message in that turn', () => {
    const control: FlueConversationMessage = {
      id: 'user-history-control',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      parts: [{
        type: 'text',
        text: '<!-- composer:history action="restore" revision-id="A" -->',
        state: 'done',
      }],
    };
    const narration: FlueConversationMessage = {
      id: 'assistant-history-narration',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      parts: [{
        type: 'text',
        text: 'The original sphere has been restored.',
        state: 'done',
      }],
    };

    expect(visibleChatMessages([
      userMessage,
      assistantWithTool('output-available'),
      control,
      historyMessage('A'),
      narration,
    ], false, latestDesignHistory([historyMessage('A')])).map(({ text }) => text)).toEqual([
      'Make a spiral.',
      'Revision 03 ready.',
    ]);
  });

  it('resumes chat after the next ordinary user direction', () => {
    const control: FlueConversationMessage = {
      id: 'user-history-control',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      parts: [{
        type: 'text',
        text: '<!-- composer:history action="undo" -->',
        state: 'done',
      }],
    };
    const nextUser = { ...userMessage, id: 'user-next' };

    expect(visibleChatMessages([
      control,
      assistantWithRevision('A', 1),
      nextUser,
      assistantWithRevision('B', 2),
    ], false).map(({ text }) => text)).toEqual([
      'Make a spiral.',
      'Revision ready.',
    ]);
  });
});

describe('direction submission readiness', () => {
  it('waits for a coherent history snapshot before accepting input', () => {
    expect(canSubmitDirection(false, 'idle', false)).toBe(false);
    expect(canSubmitDirection(true, 'connecting', false)).toBe(false);
    expect(canSubmitDirection(true, 'submitted', false)).toBe(false);
    expect(canSubmitDirection(true, 'idle', true)).toBe(false);
    expect(canSubmitDirection(true, 'idle', false)).toBe(true);
  });

  it('stops automatic reconciliation after three failed confirmations', () => {
    expect(reconciliationExhausted(2)).toBe(false);
    expect(reconciliationExhausted(3)).toBe(true);
  });

  it('allows an explicit retry after a terminal error', () => {
    expect(canSubmitDirection(true, 'error', false)).toBe(false);
    expect(canSubmitDirection(true, 'error', false, true)).toBe(true);
  });

  it('recognizes only the revision committed for the current request', () => {
    const requestId = '7b375713-28f6-4cfc-8d95-4c728b58b7d1';
    const otherRequestId = '491bf6b5-ef0f-45d0-a694-7a4f12a3087a';
    const currentHistory = latestDesignHistory([historyMessage('B', requestId)]);
    const branchHistory = latestDesignHistory([historyMessage('A', requestId)]);
    const otherTabHistory = latestDesignHistory([
      historyMessage('B', otherRequestId),
    ]);

    expect(revisionForRequest(currentHistory, requestId)).toBe('B');
    expect(revisionForRequest(branchHistory, requestId)).toBe('B');
    expect(revisionForRequest(otherTabHistory, requestId)).toBeNull();
  });

  it('clears only the unchanged restored direction after a late revision', () => {
    expect(inputAfterLateRevision('Make a spiral.', 'Make a spiral.')).toBe('');
    expect(inputAfterLateRevision('Make a tighter spiral.', 'Make a spiral.')).toBe(
      'Make a tighter spiral.',
    );
  });

  it('correlates terminal settlement through the canonical user message', () => {
    const requestId = '7b375713-28f6-4cfc-8d95-4c728b58b7d1';
    const otherRequestId = '491bf6b5-ef0f-45d0-a694-7a4f12a3087a';
    const messages: FlueConversationMessage[] = [
      {
        ...userMessage,
        id: 'user-other',
        submissionId: 'other',
        parts: [{
          type: 'text',
          text: designDirectionMessage('Other tab.', null, otherRequestId),
          state: 'done',
        }],
      },
      {
        ...userMessage,
        id: 'user-current',
        submissionId: 'current',
        parts: [{
          type: 'text',
          text: designDirectionMessage('Current tab.', null, requestId),
          state: 'done',
        }],
      },
    ];
    const settlements = [
      { submissionId: 'current', outcome: 'aborted' as const },
      { submissionId: 'other', outcome: 'completed' as const },
    ];

    expect(latestRequestId(messages)).toBe(requestId);
    expect(submissionIdForRequest(messages, requestId)).toBe('current');
    expect(settlementForRequest(messages, settlements, requestId)).toEqual(
      settlements[0],
    );
    expect(settlementForRequest(messages, settlements, otherRequestId)).toEqual(
      settlements[1],
    );
  });
});

function revisionVisual(revisionId: string, radius: number) {
  return {
    code: `async () => revision${revisionId}`,
    points: Array.from({ length: 8 }, (_, index) => ({
      x: index,
      y: radius,
      z: 0,
    })),
    render: { radius: radius / 10 },
    parameterSchema: {},
    params: {},
    revisionId,
  };
}

function assistantWithRevision(
  revisionId: string,
  radius: number,
  toolName = 'run_visual_program',
): FlueConversationMessage {
  return {
    id: `assistant-${revisionId}`,
    role: 'assistant',
    purpose: 'assistant',
    display: 'visible',
    parts: [{
      type: 'dynamic-tool',
      toolName,
      toolCallId: `tool-${revisionId}`,
      state: 'output-available',
      input: { code: `async () => revision${revisionId}`, inspect: false },
      output: revisionVisual(revisionId, radius),
    }],
  };
}

function historyMessage(
  currentRevisionId: string,
  revisionBTurnId?: string,
): FlueConversationMessage {
  return {
    id: 'assistant-history',
    role: 'assistant',
    purpose: 'assistant',
    display: 'visible',
    parts: [{
      type: 'data-designHistory',
      data: {
        currentRevisionId,
        revisions: [
          {
            id: 'A',
            parentId: null,
            kind: 'initial',
            instruction: 'Create A.',
            createdAt: 1,
          },
          {
            id: 'B',
            parentId: 'A',
            kind: 'edit',
            instruction: 'Create B.',
            createdAt: 2,
            ...(revisionBTurnId ? { turnId: revisionBTurnId } : {}),
          },
        ],
      },
    }],
  };
}

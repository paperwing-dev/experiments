import { describe, expect, it, vi } from 'vitest';
import {
  formatParameterValue,
  ParameterGestureTracker,
  parameterRenderKey,
  parameterValuesEqual,
  parameterValuesFingerprint,
  VisualPreviewCoordinator,
  withParameterValue,
} from './visual-parameters';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('visual parameter identities', () => {
  it('fingerprints equal parameter maps independent of insertion order', () => {
    expect(parameterValuesFingerprint({ radius: 4, turns: 7 })).toBe(
      parameterValuesFingerprint({ turns: 7, radius: 4 }),
    );
    expect(parameterValuesEqual(
      { radius: 4, turns: 7 },
      { turns: 7, radius: 4 },
    )).toBe(true);
  });

  it('changes a stable revision render key when runtime values change', () => {
    const original = parameterRenderKey('revision:A', { radius: 4, turns: 7 });
    expect(original).toBe(
      parameterRenderKey('revision:A', { turns: 7, radius: 4 }),
    );
    expect(original).not.toBe(
      parameterRenderKey('revision:A', { radius: 5, turns: 7 }),
    );
    expect(parameterRenderKey(undefined, { radius: 4 })).toBeUndefined();
  });

  it('rejects non-finite values before they can enter a render identity', () => {
    expect(() => parameterValuesFingerprint({ radius: Number.NaN })).toThrow(
      'params.radius must be a finite number',
    );
  });
});

describe('visual parameter display', () => {
  it('formats values with step-aware precision', () => {
    expect(formatParameterValue(4, 1)).toBe('4');
    expect(formatParameterValue(4.5, 0.1)).toBe('4.5');
    expect(formatParameterValue(4.5, 0.01)).toBe('4.50');
    expect(formatParameterValue(0.125, 0.025)).toBe('0.125');
    expect(formatParameterValue(-0.5, 0.1)).toBe('-0.5');
    expect(formatParameterValue(Number.NaN, 0.1)).toBe('—');
  });

  it('updates working values immutably and preserves identity for a no-op', () => {
    const params = { radius: 4, turns: 7 };
    expect(withParameterValue(params, 'radius', 4)).toBe(params);
    expect(withParameterValue(params, 'radius', 5)).toEqual({
      radius: 5,
      turns: 7,
    });
    expect(params).toEqual({ radius: 4, turns: 7 });
    expect(() => withParameterValue(params, 'radius', Infinity)).toThrow(
      'params.radius must be a finite number',
    );
  });
});

describe('VisualPreviewCoordinator', () => {
  it('runs one request at a time and applies only the newest trailing result', async () => {
    const first = deferred<string>();
    const latest = deferred<string>();
    const execute = vi.fn((input: string) => (
      input === 'first' ? first.promise : latest.promise
    ));
    const coordinator = new VisualPreviewCoordinator(execute);

    const firstOutcome = coordinator.request('first');
    const skippedOutcome = coordinator.request('skipped');
    const latestOutcome = coordinator.request('latest');

    await expect(skippedOutcome).resolves.toEqual({ status: 'superseded' });
    expect(execute).toHaveBeenCalledTimes(1);

    first.resolve('old artwork');
    await expect(firstOutcome).resolves.toEqual({ status: 'superseded' });
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'latest',
      expect.any(AbortSignal),
    );

    latest.resolve('new artwork');
    await expect(latestOutcome).resolves.toEqual({
      status: 'applied',
      value: 'new artwork',
    });
    expect(coordinator.busy).toBe(false);
  });

  it('suppresses stale failures but reports the latest failure', async () => {
    const first = deferred<string>();
    const latest = deferred<string>();
    const coordinator = new VisualPreviewCoordinator<string, string>(
      (input) => (input === 'first' ? first.promise : latest.promise),
    );
    const firstOutcome = coordinator.request('first');
    const latestOutcome = coordinator.request('latest');

    first.reject(new Error('stale failure'));
    await expect(firstOutcome).resolves.toEqual({ status: 'superseded' });

    const error = new Error('latest failure');
    latest.reject(error);
    await expect(latestOutcome).resolves.toEqual({
      status: 'failed',
      error,
    });
  });

  it('invalidates queued and active work and aborts the active request', async () => {
    const active = deferred<string>();
    let activeSignal: AbortSignal | undefined;
    const coordinator = new VisualPreviewCoordinator<string, string>(
      (_input, signal) => {
        activeSignal = signal;
        return active.promise;
      },
    );
    const activeOutcome = coordinator.request('active');
    const queuedOutcome = coordinator.request('queued');

    coordinator.invalidate();
    expect(activeSignal?.aborted).toBe(true);
    await expect(queuedOutcome).resolves.toEqual({ status: 'superseded' });

    active.resolve('stale artwork');
    await expect(activeOutcome).resolves.toEqual({ status: 'superseded' });
    expect(coordinator.busy).toBe(false);
  });

  it('throttles fast executions while retaining the newest request', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(async (input: string) => input);
      const coordinator = new VisualPreviewCoordinator(execute, 200);

      await expect(coordinator.request('first')).resolves.toEqual({
        status: 'applied',
        value: 'first',
      });
      const skipped = coordinator.request('skipped');
      const latest = coordinator.request('latest');
      await expect(skipped).resolves.toEqual({ status: 'superseded' });
      expect(execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);
      await expect(latest).resolves.toEqual({
        status: 'applied',
        value: 'latest',
      });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ParameterGestureTracker', () => {
  it('coalesces repeated updates into one commit at gesture end', () => {
    const tracker = new ParameterGestureTracker();

    expect(tracker.begin(17, 'revision-A', 'radius', 4)).toBe(true);
    expect(tracker.update(17, 4.5)).toBe(true);
    expect(tracker.update(17, 5)).toBe(true);
    expect(tracker.finish(17)).toEqual({
      baseRevisionId: 'revision-A',
      parameterId: 'radius',
      previousValue: 4,
      value: 5,
    });
    expect(tracker.finish(17)).toBeNull();
    expect(tracker.active).toBe(false);
  });

  it('does not commit no-op or mismatched gestures', () => {
    const tracker = new ParameterGestureTracker();
    expect(tracker.begin('radius-keyboard', 'revision-A', 'radius', 4)).toBe(true);
    expect(tracker.begin('radius-keyboard', 'revision-A', 'radius', 4)).toBe(true);
    expect(tracker.update('other', 5)).toBe(false);
    expect(tracker.finish('other')).toBeNull();
    expect(tracker.finish('radius-keyboard')).toBeNull();
  });

  it('can discard an in-progress gesture when the revision changes', () => {
    const tracker = new ParameterGestureTracker();
    tracker.begin(4, 'revision-A', 'turns', 6);
    tracker.update(4, 8);
    tracker.reset();

    expect(tracker.active).toBe(false);
    expect(tracker.finish(4)).toBeNull();
  });
});

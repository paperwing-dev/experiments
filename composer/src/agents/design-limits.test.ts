import { describe, expect, it } from 'vitest';
import {
  DESIGN_AGENT_DURABILITY,
  inspectionSignal,
  VISUAL_INSPECTION_TIMEOUT_MS,
} from './design-limits';

describe('design agent limits', () => {
  it('keeps interactive submissions within a demo-scale budget', () => {
    expect(DESIGN_AGENT_DURABILITY).toEqual({
      maxAttempts: 3,
      timeoutMs: 120_000,
    });
    expect(VISUAL_INSPECTION_TIMEOUT_MS).toBeLessThan(
      DESIGN_AGENT_DURABILITY.timeoutMs,
    );
  });

  it('propagates cancellation from the parent submission', () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const signal = inspectionSignal(controller.signal);

    controller.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it('aborts an inspection that exceeds its own deadline', async () => {
    const signal = inspectionSignal(new AbortController().signal, 5);

    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
  });
});

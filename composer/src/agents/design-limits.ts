import type { DurabilityConfig } from '@flue/runtime';

/**
 * Keep an interactive design request bounded for demo use while allowing the
 * initial generation, optional inspection, and one correction to complete.
 */
export const DESIGN_AGENT_DURABILITY = {
  maxAttempts: 3,
  timeoutMs: 120_000,
} as const satisfies DurabilityConfig;

/** Inspection is optional; a slow critique must not consume the whole turn. */
export const VISUAL_INSPECTION_TIMEOUT_MS = 30_000;

export function inspectionSignal(
  submissionSignal: AbortSignal,
  timeoutMs = VISUAL_INSPECTION_TIMEOUT_MS,
): AbortSignal {
  return AbortSignal.any([
    submissionSignal,
    AbortSignal.timeout(timeoutMs),
  ]);
}

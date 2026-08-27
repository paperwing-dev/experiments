import { parameterValuesEqual } from '../visual/validation';

export { parameterValuesEqual };

const MAX_DISPLAY_FRACTION_DIGITS = 8;

function assertFiniteParameterValue(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

/**
 * Produces a stable identity for a validated parameter map, independent of
 * object insertion order. The JSON shape also keeps parameter ids and values
 * unambiguous when it is embedded in another render key.
 */
export function parameterValuesFingerprint(
  params: Readonly<Record<string, number>>,
): string {
  return JSON.stringify(
    Object.entries(params)
      .sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      ))
      .map(([id, value]) => {
        assertFiniteParameterValue(value, `params.${id}`);
        return [id, Object.is(value, -0) ? 0 : value];
      }),
  );
}

/**
 * Extends an existing visual identity with its runtime parameter state. An
 * anonymous visual stays anonymous so its object identity can remain the
 * renderer's fallback invalidation mechanism.
 */
export function parameterRenderKey(
  visualKey: string | undefined,
  params: Readonly<Record<string, number>> | undefined,
): string | undefined {
  if (visualKey === undefined) return undefined;
  return `${visualKey}|params:${parameterValuesFingerprint(params ?? {})}`;
}

function fractionDigits(value: number): number {
  const absolute = Math.abs(value);
  if (!Number.isFinite(absolute) || absolute === 0) return 0;

  for (let digits = 0; digits <= MAX_DISPLAY_FRACTION_DIGITS; digits += 1) {
    const rounded = Number(absolute.toFixed(digits));
    const tolerance = Math.max(Number.EPSILON * absolute * 8, 1e-12);
    if (Math.abs(rounded - absolute) <= tolerance) return digits;
  }

  return MAX_DISPLAY_FRACTION_DIGITS;
}

/** Formats a slider value with enough precision to distinguish its steps. */
export function formatParameterValue(value: number, step: number): string {
  if (!Number.isFinite(value)) return '—';
  if (!Number.isFinite(step) || step <= 0) return String(value);

  const minimumDigits = fractionDigits(step);
  const digits = Math.max(minimumDigits, fractionDigits(value));
  const fixed = value.toFixed(digits);
  if (digits === minimumDigits) return fixed;

  const [integer, fraction = ''] = fixed.split('.');
  let end = fraction.length;
  while (end > minimumDigits && fraction[end - 1] === '0') end -= 1;
  return end === 0 ? integer : `${integer}.${fraction.slice(0, end)}`;
}

/** Applies a single finite value without mutating the current working map. */
export function withParameterValue(
  params: Record<string, number>,
  parameterId: string,
  value: number,
): Record<string, number> {
  assertFiniteParameterValue(value, `params.${parameterId}`);
  if (
    Object.prototype.hasOwnProperty.call(params, parameterId) &&
    params[parameterId] === value
  ) {
    return params;
  }
  return { ...params, [parameterId]: value };
}

export type VisualPreviewOutcome<Output> =
  | { status: 'applied'; value: Output }
  | { status: 'failed'; error: unknown }
  | { status: 'superseded' };

type PreviewExecutor<Input, Output> = (
  input: Input,
  signal: AbortSignal,
) => Promise<Output>;

interface ScheduledPreview<Input, Output> {
  input: Input;
  resolve: (outcome: VisualPreviewOutcome<Output>) => void;
  sequence: number;
}

/**
 * Runs at most one preview at a time and keeps only the newest trailing input.
 * Stale completions and errors are reported as superseded, so callers cannot
 * accidentally replace newer artwork with an older response.
 */
export class VisualPreviewCoordinator<Input, Output> {
  private active: ScheduledPreview<Input, Output> | null = null;
  private controller: AbortController | null = null;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private latestSequence = 0;
  private queued: ScheduledPreview<Input, Output> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly execute: PreviewExecutor<Input, Output>,
    private readonly minimumIntervalMs = 0,
  ) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new TypeError('minimumIntervalMs must be a non-negative number.');
    }
  }

  get busy(): boolean {
    return this.active !== null || this.queued !== null || this.timer !== null;
  }

  request(input: Input): Promise<VisualPreviewOutcome<Output>> {
    const sequence = ++this.latestSequence;
    return new Promise((resolve) => {
      const preview = { input, resolve, sequence };
      if (!this.active && !this.timer) {
        this.schedule(preview);
        return;
      }

      this.queued?.resolve({ status: 'superseded' });
      this.queued = preview;
    });
  }

  invalidate(): void {
    this.latestSequence += 1;
    this.queued?.resolve({ status: 'superseded' });
    this.queued = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
  }

  private schedule(preview: ScheduledPreview<Input, Output>): void {
    const delay = Math.max(
      0,
      this.minimumIntervalMs - (Date.now() - this.lastStartAt),
    );
    if (delay === 0) {
      void this.start(preview);
      return;
    }

    this.queued = preview;
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.queued;
      this.queued = null;
      if (next) void this.start(next);
    }, delay);
  }

  private async start(preview: ScheduledPreview<Input, Output>): Promise<void> {
    this.active = preview;
    this.lastStartAt = Date.now();
    const controller = new AbortController();
    this.controller = controller;

    try {
      const value = await this.execute(preview.input, controller.signal);
      preview.resolve(
        preview.sequence === this.latestSequence
          ? { status: 'applied', value }
          : { status: 'superseded' },
      );
    } catch (error) {
      preview.resolve(
        preview.sequence === this.latestSequence && !controller.signal.aborted
          ? { status: 'failed', error }
          : { status: 'superseded' },
      );
    } finally {
      if (this.active === preview) this.active = null;
      if (this.controller === controller) this.controller = null;
      const next = this.queued;
      this.queued = null;
      if (next) this.schedule(next);
    }
  }
}

export interface ParameterGestureCommit {
  baseRevisionId: string;
  parameterId: string;
  previousValue: number;
  value: number;
}

interface ActiveParameterGesture extends ParameterGestureCommit {
  token: string | number;
}

/** Tracks one slider gesture and yields at most one durable parameter edit. */
export class ParameterGestureTracker {
  private gesture: ActiveParameterGesture | null = null;

  get active(): boolean {
    return this.gesture !== null;
  }

  begin(
    token: string | number,
    baseRevisionId: string,
    parameterId: string,
    value: number,
  ): boolean {
    assertFiniteParameterValue(value, `params.${parameterId}`);
    if (this.gesture) return this.gesture.token === token;
    if (!baseRevisionId || !parameterId) return false;

    this.gesture = {
      baseRevisionId,
      parameterId,
      previousValue: value,
      token,
      value,
    };
    return true;
  }

  update(token: string | number, value: number): boolean {
    assertFiniteParameterValue(value, 'parameter value');
    if (!this.gesture || this.gesture.token !== token) return false;
    this.gesture.value = value;
    return true;
  }

  finish(token: string | number): ParameterGestureCommit | null {
    if (!this.gesture || this.gesture.token !== token) return null;
    const { baseRevisionId, parameterId, previousValue, value } = this.gesture;
    this.gesture = null;
    return previousValue === value
      ? null
      : { baseRevisionId, parameterId, previousValue, value };
  }

  reset(): void {
    this.gesture = null;
  }
}

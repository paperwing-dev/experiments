import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { ParameterSchema } from '../visual/types';
import { formatParameterValue } from './visual-parameters';

const RANGE_ADJUSTMENT_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
]);

interface VisualParameterPanelProps {
  disabled: boolean;
  error: string | null;
  onBegin: (parameterId: string) => void;
  onCancel: (parameterId: string) => void;
  onChange: (parameterId: string, value: number) => void;
  onCommit: (parameterId: string) => void;
  params: Record<string, number>;
  parameterSchema: ParameterSchema;
  status: 'idle' | 'previewing' | 'saving';
}

function statusLabel(status: VisualParameterPanelProps['status']): string {
  if (status === 'saving') return 'Saving adjustment…';
  if (status === 'previewing') return 'Live preview';
  return 'Runtime controls';
}

export function VisualParameterPanel({
  disabled,
  error,
  onBegin,
  onCancel,
  onChange,
  onCommit,
  params,
  parameterSchema,
  status,
}: VisualParameterPanelProps) {
  const entries = Object.entries(parameterSchema);
  if (entries.length === 0) return null;

  function startPointerGesture(
    event: ReactPointerEvent<HTMLInputElement>,
    parameterId: string,
  ) {
    if (disabled) return;
    onBegin(parameterId);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Native range controls can decline capture on some touch browsers.
    }
  }

  function finishPointerGesture(
    event: ReactPointerEvent<HTMLInputElement>,
    parameterId: string,
  ) {
    onCommit(parameterId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function startKeyboardGesture(
    event: ReactKeyboardEvent<HTMLInputElement>,
    parameterId: string,
  ) {
    if (disabled || !RANGE_ADJUSTMENT_KEYS.has(event.key)) return;
    onBegin(parameterId);
  }

  function finishKeyboardGesture(
    event: ReactKeyboardEvent<HTMLInputElement>,
    parameterId: string,
  ) {
    if (!RANGE_ADJUSTMENT_KEYS.has(event.key)) return;
    onCommit(parameterId);
  }

  return (
    <section
      aria-busy={status === 'saving' || undefined}
      aria-label="Artwork parameters"
      className="visual-parameter-panel"
    >
      <header>
        <strong>Parameters</strong>
        <span aria-live="polite">{statusLabel(status)}</span>
      </header>
      <div className="visual-parameter-grid">
        {entries.map(([parameterId, definition]) => {
          const inputId = `visual-parameter-${parameterId}`;
          const outputId = `${inputId}-value`;
          const value = params[parameterId] ?? definition.default;
          return (
            <label className="visual-parameter-control" key={parameterId}>
              <span>{definition.label}</span>
              <output htmlFor={inputId} id={outputId}>
                {formatParameterValue(value, definition.step)}
              </output>
              <input
                aria-describedby={outputId}
                disabled={disabled}
                id={inputId}
                max={definition.max}
                min={definition.min}
                onBlur={() => onCommit(parameterId)}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  if (!Number.isFinite(next)) return;
                  onBegin(parameterId);
                  onChange(parameterId, next);
                }}
                onKeyDown={(event) => startKeyboardGesture(event, parameterId)}
                onKeyUp={(event) => finishKeyboardGesture(event, parameterId)}
                onLostPointerCapture={() => onCancel(parameterId)}
                onPointerCancel={() => onCancel(parameterId)}
                onPointerDown={(event) => startPointerGesture(event, parameterId)}
                onPointerUp={(event) => finishPointerGesture(event, parameterId)}
                step={definition.step}
                type="range"
                value={value}
              />
            </label>
          );
        })}
      </div>
      {error ? (
        <p aria-live="polite" className="visual-parameter-error" role="status">
          {error}
        </p>
      ) : null}
    </section>
  );
}

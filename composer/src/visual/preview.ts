import type { MiddlewareHandler } from 'hono';
import { readLimitedBody } from '../security/demo-protection';
import { MAX_PROGRAM_LENGTH } from './run';
import type {
  ParameterSchema,
  ResolvedVisualProgram,
} from './types';
import {
  normalizeParameterValues,
  validateParameterSchema,
} from './validation';

export const MAX_PREVIEW_REQUEST_BYTES = 96 * 1024;
export const PREVIEW_RATE_LIMIT_SECONDS = 60;
export const PREVIEW_EXECUTION_TIMEOUT_MS = 2_000;

export interface VisualPreviewBindings {
  COMPOSER_RATE_LIMITER: RateLimit;
  LOADER: WorkerLoader;
}

type PreviewEnvironment = { Bindings: VisualPreviewBindings };

export type PreviewExecutor = (
  loader: WorkerLoader,
  code: string,
  params: Record<string, number>,
  expectedSchema: ParameterSchema,
) => Promise<ResolvedVisualProgram>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every(
    (key, index) => key === expected[index],
  );
}

function previewCallerKey(request: Request): string {
  const address = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  return `composer:preview:${address}`;
}

export function createVisualPreviewHandler(
  execute: PreviewExecutor,
): MiddlewareHandler<PreviewEnvironment> {
  return async (context) => {
    const contentType = context.req.header('content-type') ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(contentType.trim())) {
      return context.json(
        { error: { code: 'unsupported_media_type', message: 'Expected JSON.' } },
        415,
      );
    }

    const requestBody = await readLimitedBody(
      context.req.raw,
      MAX_PREVIEW_REQUEST_BYTES,
    );
    if (requestBody.tooLarge) {
      return context.json(
        {
          error: {
            code: 'request_too_large',
            message: `Preview requests cannot exceed ${MAX_PREVIEW_REQUEST_BYTES} bytes.`,
          },
        },
        413,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(requestBody.body ?? '');
    } catch {
      return context.json(
        { error: { code: 'invalid_json', message: 'Expected valid JSON.' } },
        400,
      );
    }
    if (
      !isRecord(payload) ||
      !hasExactKeys(payload, ['code', 'parameterSchema', 'params']) ||
      typeof payload.code !== 'string'
    ) {
      return context.json(
        {
          error: {
            code: 'invalid_preview',
            message: 'Preview requires code, parameterSchema, and params.',
          },
        },
        400,
      );
    }

    const code = payload.code.trim();
    if (!code || code.length > MAX_PROGRAM_LENGTH) {
      return context.json(
        {
          error: {
            code: 'invalid_preview',
            message: `Preview code must contain 1–${MAX_PROGRAM_LENGTH} characters.`,
          },
        },
        400,
      );
    }

    let parameterSchema: ParameterSchema;
    let params: Record<string, number>;
    try {
      parameterSchema = validateParameterSchema(payload.parameterSchema);
      if (
        !isRecord(payload.params) ||
        !hasExactKeys(payload.params, Object.keys(parameterSchema))
      ) {
        throw new Error('params must include exactly one value per control.');
      }
      params = normalizeParameterValues(parameterSchema, payload.params);
    } catch (error) {
      return context.json(
        {
          error: {
            code: 'invalid_preview',
            message: error instanceof Error ? error.message : 'Invalid parameters.',
          },
        },
        400,
      );
    }

    let allowed = false;
    try {
      ({ success: allowed } = await context.env.COMPOSER_RATE_LIMITER.limit({
        key: previewCallerKey(context.req.raw),
      }));
    } catch (error) {
      console.error('Composer preview rate limiter failed.', error);
      context.header('Retry-After', String(PREVIEW_RATE_LIMIT_SECONDS));
      return context.json(
        {
          error: {
            code: 'protection_unavailable',
            message: 'Visual previews are temporarily unavailable.',
          },
        },
        503,
      );
    }
    if (!allowed) {
      context.header('Retry-After', String(PREVIEW_RATE_LIMIT_SECONDS));
      return context.json(
        {
          error: {
            code: 'rate_limit_exceeded',
            message: 'Too many visual previews. Please pause briefly.',
          },
        },
        429,
      );
    }

    try {
      const execution = await execute(
        context.env.LOADER,
        code,
        params,
        parameterSchema,
      );
      context.header('Cache-Control', 'no-store');
      return context.json({
        params: execution.params,
        visual: execution.visual,
      });
    } catch {
      return context.json(
        {
          error: {
            code: 'preview_failed',
            message: 'The visual could not be previewed with these values.',
          },
        },
        422,
      );
    }
  };
}

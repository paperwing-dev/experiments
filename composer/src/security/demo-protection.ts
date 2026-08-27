import type { MiddlewareHandler } from 'hono';
import {
  MAX_DIRECTION_LENGTH,
  parseDesignDirection,
} from '../agents/design-direction';
import {
  PARAMETER_EDIT_SIGNAL,
  parseParameterEditSignal,
} from '../agents/parameter-edit';

export const MAX_AGENT_REQUEST_BYTES = 16 * 1024;
export const PROMPT_RATE_LIMIT_SECONDS = 60;

export interface DemoProtectionBindings {
  COMPOSER_RATE_LIMITER: RateLimit;
}

type ProtectionEnvironment = {
  Bindings: DemoProtectionBindings;
};

export interface LimitedBody {
  body?: string;
  tooLarge: boolean;
}

function isDirectAgentAdmission(request: Request): boolean {
  if (request.method !== 'POST') return false;
  const pathname = new URL(request.url).pathname;
  const prefix = '/api/agents/design/';
  if (!pathname.startsWith(prefix)) return false;
  const relativePath = pathname.slice(prefix.length);
  const remainder = relativePath.endsWith('/')
    ? relativePath.slice(0, -1)
    : relativePath;
  return remainder.length > 0 && !remainder.includes('/');
}

export async function readLimitedBody(
  request: Request,
  maximumBytes: number,
): Promise<LimitedBody> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return { tooLarge: true };
  }

  const reader = request.clone().body?.getReader();
  if (!reader) return { body: '', tooLarge: false };

  const decoder = new TextDecoder();
  let body = '';
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > maximumBytes) {
      // A cloned Request body is a tee; awaiting cancellation can wait for the
      // untouched downstream branch. We are rejecting the request, so signal
      // cancellation without blocking the response.
      void reader.cancel();
      return { tooLarge: true };
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  return { body, tooLarge: false };
}

function callerKey(request: Request, lane: string): string {
  // Cloudflare overwrites CF-Connecting-IP at the edge. The shared fallback
  // keeps local development usable without creating an attacker-controlled key.
  const address = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  return `composer:${lane}:${address}`;
}

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

export const protectPaidAgentMutations: MiddlewareHandler<ProtectionEnvironment> =
  async (context, next) => {
    // Reads and aborts retain Flue's normal streaming behavior. Only direct
    // conversation admissions that invoke a model or mutate state are metered.
    if (!isDirectAgentAdmission(context.req.raw)) return next();

    const contentType = context.req.header('content-type') ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(contentType.trim())) {
      return context.json(
        { error: { code: 'unsupported_media_type', message: 'Expected JSON.' } },
        415,
      );
    }

    const requestBody = await readLimitedBody(
      context.req.raw,
      MAX_AGENT_REQUEST_BYTES,
    );
    if (requestBody.tooLarge) {
      return context.json(
        {
          error: {
            code: 'request_too_large',
            message: `Requests cannot exceed ${MAX_AGENT_REQUEST_BYTES} bytes.`,
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

    const admit = async (
      lane: 'parameter-edit' | 'prompt',
      exceededMessage: string,
    ): Promise<Response | null> => {
      let allowed = false;
      try {
        ({ success: allowed } = await context.env.COMPOSER_RATE_LIMITER.limit({
          key: callerKey(context.req.raw, lane),
        }));
      } catch (error) {
        console.error('Composer rate limiter failed.', error);
        context.header('Retry-After', String(PROMPT_RATE_LIMIT_SECONDS));
        return context.json(
          {
            error: {
              code: 'protection_unavailable',
              message: 'Composer is temporarily unavailable. Please try again shortly.',
            },
          },
          503,
        );
      }

      if (allowed) return null;
      context.header('Retry-After', String(PROMPT_RATE_LIMIT_SECONDS));
      return context.json(
        {
          error: {
            code: 'rate_limit_exceeded',
            message: exceededMessage,
          },
        },
        429,
      );
    };

    if (
      isRecord(payload) &&
      payload.kind === 'signal' &&
      payload.type === PARAMETER_EDIT_SIGNAL
    ) {
      if (!hasExactKeys(payload, ['body', 'kind', 'type'])) {
        return context.json(
          {
            error: {
              code: 'invalid_request',
              message: 'Parameter edit signals cannot include extra fields.',
            },
          },
          400,
        );
      }
      try {
        parseParameterEditSignal({
          kind: 'signal',
          type: payload.type,
          body: payload.body,
        });
      } catch (error) {
        return context.json(
          {
            error: {
              code: 'invalid_parameter_edit',
              message: error instanceof Error
                ? error.message
                : 'Invalid parameter edit signal.',
            },
          },
          400,
        );
      }

      const rejected = await admit(
        'parameter-edit',
        'Too many parameter edits. Please try again in a minute.',
      );
      return rejected ?? next();
    }

    if (!isRecord(payload) || payload.kind !== 'user') {
      return context.json(
        {
          error: {
            code: 'invalid_request',
            message: 'The public demo accepts user directions only.',
          },
        },
        400,
      );
    }
    if ('attachments' in payload || 'initialData' in payload) {
      return context.json(
        {
          error: {
            code: 'unsupported_input',
            message: 'Attachments and custom initial data are not supported.',
          },
        },
        400,
      );
    }
    if (typeof payload.body !== 'string') {
      return context.json(
        {
          error: {
            code: 'invalid_request',
            message: 'A text direction is required.',
          },
        },
        400,
      );
    }

    const direction = parseDesignDirection(payload.body).instruction;
    if (!direction) {
      return context.json(
        {
          error: {
            code: 'invalid_request',
            message: 'A text direction is required.',
          },
        },
        400,
      );
    }
    if (direction.length > MAX_DIRECTION_LENGTH) {
      return context.json(
        {
          error: {
            code: 'direction_too_long',
            message: `Directions cannot exceed ${MAX_DIRECTION_LENGTH} characters.`,
          },
        },
        400,
      );
    }

    const rejected = await admit(
      'prompt',
      'Too many directions. Please try again in a minute.',
    );
    return rejected ?? next();
  };

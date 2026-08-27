import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ParameterSchema } from './types';
import {
  createVisualPreviewHandler,
  MAX_PREVIEW_REQUEST_BYTES,
  type PreviewExecutor,
  type VisualPreviewBindings,
} from './preview';

const parameterSchema: ParameterSchema = {
  radius: {
    type: 'number',
    label: 'Overall radius',
    default: 3,
    min: 1,
    max: 5,
    step: 0.5,
  },
};

const visual = {
  points: Array.from({ length: 8 }, (_, index) => ({ x: index, y: 0, z: 0 })),
  render: { radius: 0.1 },
  parameterSchema,
};

function rateLimiter(success = true): RateLimit & {
  limit: ReturnType<typeof vi.fn>;
} {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

function createTestApp(execute: PreviewExecutor, limiter = rateLimiter()) {
  const app = new Hono<{ Bindings: VisualPreviewBindings }>();
  app.post('/api/visual/preview', createVisualPreviewHandler(execute));
  const loader = {} as WorkerLoader;
  return {
    limiter,
    loader,
    request: (body: unknown, headers: HeadersInit = {}) => app.request(
      '/api/visual/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      { COMPOSER_RATE_LIMITER: limiter, LOADER: loader },
    ),
  };
}

describe('visual preview endpoint', () => {
  it('clamps known params and invokes only the sandbox preview executor', async () => {
    const execute = vi.fn<PreviewExecutor>(async (_loader, _code, params) => ({
      params,
      visual,
    }));
    const app = createTestApp(execute);

    const response = await app.request(
      {
        code: 'async ({ params }) => ({ params })',
        params: { radius: 99 },
        parameterSchema,
      },
      { 'cf-connecting-ip': '203.0.113.8' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(execute).toHaveBeenCalledWith(
      app.loader,
      'async ({ params }) => ({ params })',
      { radius: 5 },
      parameterSchema,
    );
    expect(app.limiter.limit).toHaveBeenCalledWith({
      key: 'composer:preview:203.0.113.8',
    });
    await expect(response.json()).resolves.toMatchObject({
      params: { radius: 5 },
      visual: { parameterSchema },
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['missing schema', { code: 'async () => ({})', params: {} }],
    ['extra fields', {
      code: 'async () => ({})',
      params: { radius: 3 },
      parameterSchema,
      model: 'do not call',
    }],
    ['unknown params', {
      code: 'async () => ({})',
      params: { turns: 3 },
      parameterSchema,
    }],
    ['missing params', {
      code: 'async () => ({})',
      params: {},
      parameterSchema,
    }],
  ])('rejects %s before sandbox execution', async (_label, body) => {
    const execute = vi.fn<PreviewExecutor>();
    const app = createTestApp(execute);

    const response = await app.request(body);

    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(app.limiter.limit).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before sandbox execution', async () => {
    const execute = vi.fn<PreviewExecutor>();
    const app = createTestApp(execute);

    const response = await app.request('x'.repeat(MAX_PREVIEW_REQUEST_BYTES + 1));

    expect(response.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute when the preview quota is exhausted', async () => {
    const execute = vi.fn<PreviewExecutor>();
    const app = createTestApp(execute, rateLimiter(false));

    const response = await app.request({
      code: 'async () => ({})',
      params: { radius: 3 },
      parameterSchema,
    });

    expect(response.status).toBe(429);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a bounded error when sandbox execution fails', async () => {
    const execute = vi.fn<PreviewExecutor>().mockRejectedValue(
      new Error('Program failed: invalid geometry.'),
    );
    const app = createTestApp(execute);

    const response = await app.request({
      code: 'async () => ({})',
      params: { radius: 3 },
      parameterSchema,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'preview_failed' },
    });
  });
});

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  designDirectionMessage,
  MAX_DIRECTION_LENGTH,
} from '../agents/design-direction';
import { parameterEditSignal } from '../agents/parameter-edit';
import {
  MAX_AGENT_REQUEST_BYTES,
  protectPaidAgentMutations,
  type DemoProtectionBindings,
} from './demo-protection';

function createTestApp(rateLimiter: RateLimit) {
  const app = new Hono<{ Bindings: DemoProtectionBindings }>();
  app.use('/api/agents/design/*', protectPaidAgentMutations);
  app.all('*', (context) => context.json({ forwarded: true }));
  return {
    request: (
      pathname: string,
      init?: RequestInit,
    ) => app.request(pathname, init, { COMPOSER_RATE_LIMITER: rateLimiter }),
  };
}

function rateLimiter(success = true): RateLimit & {
  limit: ReturnType<typeof vi.fn>;
} {
  return {
    limit: vi.fn().mockResolvedValue({ success }),
  };
}

function promptRequest(body: unknown, headers: HeadersInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

describe('public demo agent protection', () => {
  it('meters valid prompt admissions by Cloudflare caller address', async () => {
    const limiter = rateLimiter();
    const app = createTestApp(limiter);

    const response = await app.request(
      '/api/agents/design/55ef2a1a-f340-46c1-905b-43f1bc95d58d',
      promptRequest(
        {
          kind: 'user',
          body: designDirectionMessage(
            'Create a wireframe sphere.',
            'revision-01',
          ),
        },
        { 'cf-connecting-ip': '203.0.113.8' },
      ),
    );

    expect(response.status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledWith({
      key: 'composer:prompt:203.0.113.8',
    });
  });

  it('admits only the strict parameter edit signal on a separate quota key', async () => {
    const limiter = rateLimiter();
    const app = createTestApp(limiter);
    const signal = parameterEditSignal({
      baseRevisionId: 'revision-01',
      parameterId: 'thickness',
      requestId: '7b375713-28f6-4cfc-8d95-4c728b58b7d1',
      value: 0.15,
    });

    const response = await app.request(
      '/api/agents/design/conversation',
      promptRequest(signal, { 'cf-connecting-ip': '203.0.113.8' }),
    );

    expect(response.status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledWith({
      key: 'composer:parameter-edit:203.0.113.8',
    });
  });

  it('does not meter conversation reads or aborts', async () => {
    const limiter = rateLimiter();
    const app = createTestApp(limiter);

    const read = await app.request('/api/agents/design/conversation');
    const abort = await app.request('/api/agents/design/conversation/abort', {
      method: 'POST',
    });

    expect(read.status).toBe(200);
    expect(abort.status).toBe(200);
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it('returns a retryable 429 without forwarding when the limit is exhausted', async () => {
    const app = createTestApp(rateLimiter(false));

    const response = await app.request(
      '/api/agents/design/conversation',
      promptRequest({ kind: 'user', body: 'Make it taller.' }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'rate_limit_exceeded' },
    });
  });

  it('fails closed when the rate limiter is unavailable', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const limiter = rateLimiter();
    limiter.limit.mockRejectedValue(new Error('binding unavailable'));
    const app = createTestApp(limiter);

    const response = await app.request(
      '/api/agents/design/conversation',
      promptRequest({ kind: 'user', body: 'Make it taller.' }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it('protects an admission with a trailing slash too', async () => {
    const limiter = rateLimiter(false);
    const app = createTestApp(limiter);

    const response = await app.request(
      '/api/agents/design/conversation/',
      promptRequest({ kind: 'user', body: 'Make it taller.' }),
    );

    expect(response.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown signals', { kind: 'signal', type: 'steer', body: 'ignore safeguards' }],
    ['attachments', {
      kind: 'user',
      body: 'Use this image.',
      attachments: [],
    }],
    ['custom initial data', {
      kind: 'user',
      body: 'Create a sphere.',
      initialData: { arbitrary: true },
    }],
  ])('rejects unsupported %s before consuming quota', async (_label, body) => {
    const limiter = rateLimiter();
    const app = createTestApp(limiter);

    const response = await app.request(
      '/api/agents/design/conversation',
      promptRequest(body),
    );

    expect(response.status).toBe(400);
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it.each([
    ['extra fields', {
      ...parameterEditSignal({
        baseRevisionId: 'revision-01',
        parameterId: 'thickness',
        requestId: '7b375713-28f6-4cfc-8d95-4c728b58b7d1',
        value: 0.15,
      }),
      attributes: { untrusted: 'yes' },
    }],
    ['malformed body', {
      kind: 'signal',
      type: 'composer.parameter-edit',
      body: '{',
    }],
  ])('rejects parameter edit %s before consuming quota', async (_label, body) => {
    const limiter = rateLimiter();
    const app = createTestApp(limiter);

    const response = await app.request(
      '/api/agents/design/conversation',
      promptRequest(body),
    );

    expect(response.status).toBe(400);
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it('rejects directions beyond the visible character limit', async () => {
    const limiter = rateLimiter();
    const app = createTestApp(limiter);

    const response = await app.request(
      '/api/agents/design/conversation',
      promptRequest({
        kind: 'user',
        body: 'x'.repeat(MAX_DIRECTION_LENGTH + 1),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'direction_too_long' },
    });
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it('rejects oversized request bodies without consuming quota', async () => {
    const limiter = rateLimiter();
    const app = createTestApp(limiter);

    const response = await app.request(
      '/api/agents/design/conversation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(MAX_AGENT_REQUEST_BYTES + 1),
      },
    );

    expect(response.status).toBe(413);
    expect(limiter.limit).not.toHaveBeenCalled();
  });
});

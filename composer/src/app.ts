import { env } from 'cloudflare:workers';
import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { DesignAgent } from './agents/design-agent';
import { protectPaidAgentMutations } from './security/demo-protection';
import {
  PROBE_PROGRAM,
  runVisualProgram,
  runVisualProgramWithParameters,
} from './visual/execute';
import {
  createVisualPreviewHandler,
  PREVIEW_EXECUTION_TIMEOUT_MS,
} from './visual/preview';

setProvider(cloudflareBindingProvider({
  binding: env.AI,
  gateway: {
    id: 'default',
    skipCache: true,
  },
}));

interface Bindings {
  COMPOSER_RATE_LIMITER: RateLimit;
  LOADER: WorkerLoader;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (context) => context.json({ ok: true }));
app.get('/api/health/executor', async (context) => {
  const result = await runVisualProgram(context.env.LOADER, PROBE_PROGRAM);
  return context.json({ ok: true, result });
});
app.post(
  '/api/visual/preview',
  createVisualPreviewHandler((loader, code, params, schema) =>
    runVisualProgramWithParameters(
      loader,
      code,
      params,
      schema,
      PREVIEW_EXECUTION_TIMEOUT_MS,
    )),
);
app.use('/api/agents/design/*', protectPaidAgentMutations);
app.route('/api/agents/design', createAgentRouter(DesignAgent));

export default app;

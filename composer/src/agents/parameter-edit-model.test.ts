import { createModels } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import {
  PARAMETER_EDIT_MODEL,
  parameterEditProvider,
} from './parameter-edit-model';

describe('local parameter edit model', () => {
  it('settles with an empty zero-token response without network access', async () => {
    const models = createModels();
    models.setProvider(parameterEditProvider());
    const [providerId, modelId] = PARAMETER_EDIT_MODEL.split('/');
    const model = models.getModel(providerId!, modelId!);
    expect(model).toBeDefined();

    const message = await models.complete(model!, { messages: [] });

    expect(message).toMatchObject({
      provider: 'composer-local',
      model: 'parameter-edit',
      content: [],
      stopReason: 'stop',
      usage: { input: 0, output: 0, totalTokens: 0 },
    });
  });

  it('honors cancellation without invoking a response callback', async () => {
    const provider = parameterEditProvider();
    const model = provider.getModels()[0]!;
    const controller = new AbortController();
    const onResponse = vi.fn();
    controller.abort(new Error('cancelled'));

    const stream = provider.streamSimple(model, { messages: [] }, {
      signal: controller.signal,
      onResponse,
    });

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: 'aborted',
      errorMessage: 'cancelled',
    });
    expect(onResponse).not.toHaveBeenCalled();
  });
});

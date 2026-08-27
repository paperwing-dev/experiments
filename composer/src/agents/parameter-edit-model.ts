import {
  createAssistantMessageEventStream,
  createProvider,
} from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  Model,
  ProviderStreams,
  StreamOptions,
  StopReason,
  Usage,
} from '@earendil-works/pi-ai';

const PROVIDER_ID = 'composer-local';
const MODEL_ID = 'parameter-edit';
const API_ID = 'composer-noop';

export const PARAMETER_EDIT_MODEL = `${PROVIDER_ID}/${MODEL_ID}`;

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function assistantMessage(
  model: Model<Api>,
  stopReason: StopReason,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function noOpStream(
  model: Model<Api>,
  _context: unknown,
  options?: StreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    void (async () => {
      const partial = assistantMessage(model, 'pending');
      stream.push({ type: 'start', partial });
      try {
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? new Error('Parameter edit was aborted.');
        }
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? new Error('Parameter edit was aborted.');
        }
        stream.push({
          type: 'done',
          reason: 'stop',
          message: assistantMessage(model, 'stop'),
        });
      } catch (error) {
        const aborted = options?.signal?.aborted === true;
        stream.push({
          type: 'error',
          reason: aborted ? 'aborted' : 'error',
          error: {
            ...assistantMessage(model, aborted ? 'aborted' : 'error'),
            errorMessage: error instanceof Error
              ? error.message
              : 'Local parameter edit failed.',
          },
        });
      }
    })();
  });
  return stream;
}

const noOpStreams: ProviderStreams = {
  stream: noOpStream,
  streamSimple: noOpStream,
};

export function parameterEditProvider() {
  return createProvider({
    id: PROVIDER_ID,
    name: 'Composer local state transitions',
    auth: {
      apiKey: {
        name: 'Local in-process provider',
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [{
      id: MODEL_ID,
      name: 'Parameter edit state transition',
      api: API_ID,
      provider: PROVIDER_ID,
      baseUrl: 'local://composer',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 1,
    }],
    api: noOpStreams,
  });
}

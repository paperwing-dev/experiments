import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPOSER_MODEL,
  resolveComposerModels,
} from './design-model';

describe('resolveComposerModels', () => {
  it('uses the known-good Kimi model for both workloads by default', () => {
    expect(resolveComposerModels({})).toEqual({
      design: DEFAULT_COMPOSER_MODEL,
      inspection: DEFAULT_COMPOSER_MODEL,
    });
  });

  it('uses the configured design model for inspection by default', () => {
    expect(resolveComposerModels({
      COMPOSER_MODEL: 'cloudflare/@cf/moonshotai/kimi-k2.6',
    })).toEqual({
      design: 'cloudflare/@cf/moonshotai/kimi-k2.6',
      inspection: 'cloudflare/@cf/moonshotai/kimi-k2.6',
    });
  });

  it('allows the inspection model to be configured separately', () => {
    expect(resolveComposerModels({
      COMPOSER_MODEL: 'openai/gpt-5.6-terra',
      COMPOSER_INSPECTION_MODEL: 'cloudflare/@cf/moonshotai/kimi-k2.6',
    })).toEqual({
      design: 'openai/gpt-5.6-terra',
      inspection: 'cloudflare/@cf/moonshotai/kimi-k2.6',
    });
  });
});

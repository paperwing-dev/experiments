export const DEFAULT_COMPOSER_MODEL =
  'cloudflare/@cf/moonshotai/kimi-k2.6';

interface ComposerModelConfiguration {
  COMPOSER_MODEL?: string;
  COMPOSER_INSPECTION_MODEL?: string;
}

function configuredModel(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function resolveComposerModels(
  configuration: ComposerModelConfiguration,
): { design: string; inspection: string } {
  const design = configuredModel(
    configuration.COMPOSER_MODEL,
    DEFAULT_COMPOSER_MODEL,
  );
  return {
    design,
    inspection: configuredModel(
      configuration.COMPOSER_INSPECTION_MODEL,
      design,
    ),
  };
}

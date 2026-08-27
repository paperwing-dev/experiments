import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import react from '@vitejs/plugin-react';
import { readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const fluePlugins = flue({ providers: ['cloudflare', 'openai'] });

const stripLocalBuildSecrets = (): Plugin => ({
  name: 'strip-local-build-secrets',
  apply: 'build',
  closeBundle() {
    const distDirectory = resolve('dist');

    try {
      for (const entry of readdirSync(distDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        rmSync(resolve(distDirectory, entry.name, '.dev.vars'), { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  },
});

export default defineConfig({
  plugins: [
    ...fluePlugins,
    react(),
    cloudflare({ config: flueWorkerConfig() }),
    stripLocalBuildSecrets(),
  ],
});

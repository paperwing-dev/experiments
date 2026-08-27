import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const fluePlugins = flue({ providers: ['cloudflare', 'openai'] });

export default defineConfig({
  plugins: [
    ...fluePlugins,
    react(),
    cloudflare({ config: flueWorkerConfig() }),
  ],
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// editlens:start
import editlens from '../../integrations/vite.mjs';
// editlens:end

export default defineConfig({
  plugins: [
    react(),
    // editlens:start
    editlens(),
    // editlens:end
  ],
  server: { port: 5174, host: '127.0.0.1' },
});

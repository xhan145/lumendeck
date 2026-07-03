import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal declaration so the config typechecks without pulling in @types/node.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5178 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

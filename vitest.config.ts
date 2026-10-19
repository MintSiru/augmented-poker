import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['engine/test/**/*.test.ts', 'server/test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});

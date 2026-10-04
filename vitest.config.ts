import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // This sandbox's npm registry serves stub tarballs for @inquirer/*
      // (no dist/), so tests alias it to a no-op stub.
      '@inquirer/prompts': fileURLToPath(new URL('./tests/stubs/inquirer.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});

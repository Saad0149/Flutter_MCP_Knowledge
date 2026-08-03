import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Allow TypeScript sources to be imported with NodeNext ".js" specifiers.
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});

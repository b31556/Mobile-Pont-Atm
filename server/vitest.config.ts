import { defineConfig } from 'vitest/config';
// Two tests start the real server as a child process (npx tsx ...), which takes well over the default 5 s on a busy machine
// (the production host runs many other sites), so tests get a generous limit; a test that really hangs still fails.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 } });

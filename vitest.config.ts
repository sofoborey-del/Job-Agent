import { defineConfig } from 'vitest/config';

// Several suites migrate a fresh embedded PGlite database per test, drive a real Chromium, or parse
// a PDF. On Windows, under the parallelism vitest chooses by default, those legitimately exceed the
// 5s test / 10s hook defaults even though each file finishes in a couple of seconds on its own.
// These limits are about scheduling contention, not about giving slow assertions room to pass.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    // Several suites bind real TCP/WebSocket servers (host relay, guest client,
    // session live-loop). Running test files in parallel oversubscribes sockets
    // and CPU, which causes rare timeouts on smaller CI runners. Run files
    // sequentially for deterministic results; the suite is fast enough.
    fileParallelism: false,
  },
});

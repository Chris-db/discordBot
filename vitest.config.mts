import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Point every test file at a throwaway database BEFORE any module loads.
    // config.ts uses dotenv, which never overwrites an existing process.env value, so this
    // wins over DB_PATH in .env and keeps the real bot data safe. tests/setup.ts then
    // narrows it further to one file per worker — see the comment there.
    env: {
      DB_PATH: 'data/test_6mans.sqlite',
    },
    setupFiles: ['tests/setup.ts'],
    // The Pi runs this suite before every deploy, with the files in parallel workers on
    // four slow cores. The migration tests run a full legacy upgrade each and sit near
    // vitest's 5 s default there; a CPU-heavy neighbour (the wheel GIF render) was enough
    // to push one over, and a flaky gate rolls back a good deploy. Windows is nowhere near.
    testTimeout: 20_000,
    // beforeEach in the migration tests recreates the legacy schema and seeds it, which is
    // the same slow-Pi cost as the test body above -- vitest tracks hook time separately
    // from test time, so raising testTimeout alone left this at its 10 s default and it
    // tripped the deploy gate too (issue #2).
    hookTimeout: 20_000,
  },
});

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
  },
});

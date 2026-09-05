import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'seed/**/*.test.ts'],
    // The integration suite writes to the shared development database. Running
    // files concurrently would let one file's cleanup delete rows another file
    // is still asserting on, which fails intermittently and looks like a bug in
    // the repository rather than in the test setup.
    //
    // This protects files within one run and cannot protect a run from another
    // run. Each file pins its own org id as a constant -- `org-ids.test.ts`
    // enforces that they are distinct -- so two `vitest` processes started at
    // once execute the *same* file against the *same* org, and each one's
    // `beforeAll` reset deletes rows the other is mid-assertion on. Reproduced:
    // two concurrent runs of the same pair of job files failed four accrual and
    // carry-forward tests in one run ("expected undefined to be 1") and passed
    // clean in the other; the same pair, split so neither run touched the other's
    // file, passed both sides three times over.
    //
    // That is now enforced rather than written down. `globalSetup` below takes
    // a Postgres advisory lock, so a second run refuses to start with a message
    // naming this, instead of silently corrupting both. The note above stood
    // for a day and three sessions still lost time to it -- twice to the queue
    // prefix, once to a web-only change -- because a comment cannot fail a
    // build.
    fileParallelism: false,
    /*
     * Holds the run lock for the whole suite. Session-scoped in Postgres, so a
     * killed run releases it when its socket closes and there is nothing to
     * clean up by hand.
     */
    globalSetup: ['./src/test-support/exclusive-run.ts'],
    // The integration tests boot the real application, which logs every
    // request through pino. Set before any module loads, so `env.ts` picks it
    // up: `process.loadEnvFile` does not overwrite a variable already present.
    // A failing test's own output is worth more than 200 request lines.
    // Every test file boots the real AppModule. Consuming the BullMQ queues in
    // all of them would mean sixteen sets of workers competing for the same
    // jobs, and a job enqueued by one file being executed by another. The jobs
    // suite starts the workers itself, through the same `JobRunner.startWorkers`
    // the bootstrap hook calls, so nothing about the runner goes untested.
    //
    // The prefix is what keeps the suite out of the developer's own API. That
    // process consumes the same queue names on the same Redis, and it won it
    // often enough that the failure-path test - which mocks the handler's
    // dependency to make the job fail - watched a job complete instead,
    // because the API's unmocked worker had run it. Nothing in the test could
    // see that; it just reported "expected failed, got completed".
    env: { LOG_LEVEL: 'silent', JOBS_WORKER_ENABLED: 'false', JOBS_QUEUE_PREFIX: process.env.JOBS_QUEUE_PREFIX ?? 'vyuha-test' },
  },
});

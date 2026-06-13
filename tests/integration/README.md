# Integration tests

These tests spawn `bin/lebop` as a child process and assert against
real stdout / stderr / exit codes. The harness mocks Linear's GraphQL
endpoint via a local `node:http` server under the supported
`vitest run` runner; the SDK is pointed at it via
`LEBOP_API_URL`. Auth is faked by writing a valid `auth.json` to a temp
`LEBOP_HOME`.

## Adding a test

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockServer, makeAuthFile, runLebop, startMockLinear } from "./harness.ts";

let mock: MockServer;
let env: Record<string, string>;

beforeAll(async () => {
  mock = await startMockLinear();
  const home = await makeAuthFile("lin_api_test");
  env = { LEBOP_HOME: home, LEBOP_API_URL: mock.url };
});

afterAll(async () => {
  await mock.stop();
});

describe("my new command", () => {
  it("does the thing", async () => {
    mock.respond({ data: { /* what your query expects */ } });
    const r = await runLebop(["my-command", "--flag"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("expected output");
  });
});
```

## Pattern: queue responses FIFO

Each `mock.respond({...})` call enqueues one response. The next inbound
GraphQL request consumes it. For commands that paginate, queue one
response per expected page. For commands that retry, queue one response
per expected attempt (e.g. five 429s to exhaust the default budget).

## Pattern: error paths

Set `status` and `errors` on the mock response to trigger error paths:

```ts
mock.respond({ status: 429, errors: [{ message: "Too many requests" }] });
```

Or to trigger an auth path, wipe the auth file:

```ts
const home = await makeAuthFile("placeholder");
await rm(`${home}/auth.json`);
const r = await runLebop(["teams"], { LEBOP_HOME: home, LEBOP_API_URL: mock.url });
expect(r.stderr).toContain("error[auth_error]:");
```

## Pattern: surface contracts

CLI/MCP parity and high-risk behavior rules live in
`src/lib/toolSurfaceManifest.ts` and `src/lib/toolBehaviorContracts.ts`.
When adding a command or MCP tool, update the manifest and add focused local
coverage for the contract it touches. The live Noxor harness then adds
semantic assertions for release-critical operations instead of only proving
that a command was invoked.

## Why spawn the binary?

Module-level mocks are faster but miss CLI plumbing — commander wiring,
argv preprocessing, top-level error handler, exit codes, NO_COLOR
behavior. End-to-end subprocess tests catch these. The cost is per-test
binary boot (~50–100ms); keep the suite small + targeted, and let
lib-level tests (`tests/*.test.ts`) cover unit-level logic.

## Per-test isolation

Each test should leave the harness clean for the next. Pattern:

```ts
afterEach(() => {
  try {
    mock.assertNoPendingResponses();
  } finally {
    mock.reset({ allowPendingResponses: true });
  }
});
```

Without the assertion, a test that queues 3 responses but consumes 2 can pass
while proving less than it claims. Use `allowPendingResponses: true` only after
that assertion path has run, or in a test that deliberately queues optional
responses and explains why.

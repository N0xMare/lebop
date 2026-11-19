import { rm } from "node:fs/promises";
import { buildSchema, graphqlSync } from "graphql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type MockResponse,
  type MockServer,
  makeAuthFile,
  runLebop,
  startMcpClient,
  startMockLinear,
} from "./harness.ts";

// Public Linear schema subset: interface/union selections must remain valid,
// even when a mocked response would otherwise hide a malformed query.
const schema = buildSchema(`
  scalar JSON
  type Query {
    notifications(first: Int!, after: String): NotificationConnection!
    agentSession(id: String!): AgentSession
  }
  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type NotificationConnection { nodes: [Notification!]!, pageInfo: PageInfo! }
  interface Notification { id: ID!, type: String!, readAt: String, createdAt: String! }
  type IssueNotification implements Notification {
    id: ID!, type: String!, readAt: String, createdAt: String!, issue: Issue!
  }
  type ProjectNotification implements Notification {
    id: ID!, type: String!, readAt: String, createdAt: String!
  }
  type Issue { id: ID!, identifier: String!, title: String! }
  type User { id: ID!, name: String!, email: String! }
  type AgentSession {
    id: ID!, status: String!, type: String!, createdAt: String!, updatedAt: String!,
    endedAt: String, issue: Issue, creator: User, plan: JSON,
    externalLinks: [AgentSessionExternalLink!]!, activities(first: Int!): AgentActivityConnection!
  }
  type AgentSessionExternalLink { label: String!, url: String! }
  type AgentActivityConnection { nodes: [AgentActivity!]! }
  type AgentActivity {
    id: ID!, createdAt: String!, updatedAt: String!, ephemeral: Boolean!,
    content: AgentActivityContent!
  }
  union AgentActivityContent = AgentActivityThoughtContent | AgentActivityActionContent
    | AgentActivityResponseContent | AgentActivityPromptContent
    | AgentActivityErrorContent | AgentActivityElicitationContent
  type AgentActivityThoughtContent { type: String!, body: String! }
  type AgentActivityActionContent { type: String!, action: String!, parameter: String!, result: String }
  type AgentActivityResponseContent { type: String!, body: String! }
  type AgentActivityPromptContent { type: String!, body: String!, title: String }
  type AgentActivityErrorContent { type: String!, body: String!, reasonCode: String }
  type AgentActivityElicitationContent { type: String!, body: String! }
`);

let mock: MockServer;
let home: string;
let env: Record<string, string>;

beforeAll(async () => {
  mock = await startMockLinear();
  home = await makeAuthFile("lin_api_schema_test");
  env = { LEBOP_HOME: home, LEBOP_API_URL: mock.url, LEBOP_MACHINE_FORMAT: "json" };
});
afterEach(() => mock.reset());
afterAll(async () => {
  await mock.stop();
  await rm(home, { recursive: true, force: true });
});

function respond(rootValue: Record<string, unknown>): void {
  const response: MockResponse = {
    beforeRespond() {
      const request = mock.requestAt(0);
      const result = graphqlSync({
        schema,
        source: request?.query ?? "",
        variableValues: request?.variables,
        rootValue,
      });
      response.data = result.data ?? undefined;
      response.errors = result.errors?.map((error) => ({ message: error.message }));
    },
  };
  mock.respond(response);
}

describe("Linear interface and union query compatibility", () => {
  it("lists mixed issue and non-issue inbox notifications with a valid interface query", async () => {
    const issue = { id: "issue-1", identifier: "TEAM-42", title: "Review compatibility" };
    const createdAt = "2026-11-18T10:00:00.000Z";
    respond({
      notifications: {
        nodes: [
          {
            __typename: "IssueNotification",
            id: "notification-1",
            type: "issueAssignedToYou",
            readAt: null,
            createdAt,
            issue,
          },
          {
            __typename: "ProjectNotification",
            id: "notification-2",
            type: "projectUpdate",
            readAt: createdAt,
            createdAt,
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "next-notifications" },
      },
    });
    const result = await runLebop(["notifications", "--limit", "2", "--json"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      count: 2,
      has_more: true,
      next_cursor: "next-notifications",
      notifications: [
        { id: "notification-1", issue, read_at: null },
        { id: "notification-2", issue: null, read_at: createdAt },
      ],
    });
  });

  it("loads session links and every activity content variant through CLI and MCP", async () => {
    const contents = [
      { type: "thought", body: "Inspecting the failing query" },
      { type: "action", action: "read", parameter: "src/cli.ts", result: "Loaded" },
      { type: "response", body: "The fix is ready" },
      { type: "prompt", body: "Please verify it", title: "Verify" },
      { type: "error", body: "Request failed", reasonCode: "upstream_unavailable" },
      { type: "elicitation", body: "Which project?" },
    ];
    const timestamp = "2026-11-18T10:00:00.000Z";
    const links = [{ label: "Changes", url: "https://example.com/changes/42" }];
    const session = {
      id: "00000000-0000-4000-8000-000000000001",
      status: "working",
      type: "commentThread",
      createdAt: timestamp,
      updatedAt: timestamp,
      endedAt: null,
      issue: null,
      creator: null,
      plan: [{ content: "Verify compatibility", status: "inProgress" }],
      externalLinks: links,
      activities: {
        nodes: contents.map((content, index) => ({
          id: `activity-${index}`,
          createdAt: timestamp,
          updatedAt: timestamp,
          ephemeral: index === 0,
          content,
        })),
      },
    };
    const client = await startMcpClient(env);
    try {
      await client.initialize();
      await client.notifyInitialized();
      for (const mode of ["cli", "mcp", "cli-no-activities"]) {
        respond({
          agentSession: {
            ...session,
            activities: {
              nodes: session.activities.nodes.map((node) => ({
                ...node,
                content: {
                  ...node.content,
                  __typename: `AgentActivity${node.content.type[0]?.toUpperCase()}${node.content.type.slice(1)}Content`,
                },
              })),
            },
          },
        });
        let payload: { agent_session: Record<string, unknown> };
        if (mode === "mcp") {
          const result = await client.callTool("get_agent_session", { id: session.id });
          expect(result.isError).not.toBe(true);
          payload = result.parsed as typeof payload;
        } else {
          const args = ["agent-session", "view", session.id, "--json"];
          if (mode === "cli-no-activities") args.push("--no-activities");
          const result = await runLebop(args, env);
          expect(result.exitCode).toBe(0);
          payload = JSON.parse(result.stdout);
        }
        expect(payload.agent_session).toMatchObject({ id: session.id, external_urls: links });
        if (mode === "cli-no-activities") {
          expect(payload.agent_session).not.toHaveProperty("activities");
        } else {
          expect(payload.agent_session.activities).toEqual(
            session.activities.nodes.map((node) => ({
              id: node.id,
              created_at: timestamp,
              updated_at: timestamp,
              ephemeral: node.ephemeral,
              content: node.content,
            })),
          );
        }
        mock.reset();
      }
    } finally {
      await client.close();
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentSessionsPage } from "../src/lib/agentSessions.ts";

const mocks = vi.hoisted(() => ({
  linear: vi.fn(),
  rawRequest: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("../src/lib/sdk.ts", () => ({
  linear: mocks.linear,
  withClient: mocks.withClient,
}));

describe("agent session pagination", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.linear.mockResolvedValue({ client: { rawRequest: mocks.rawRequest } });
  });

  it("fills status-filtered pages by scanning raw pages until enough matches are found", async () => {
    mocks.rawRequest
      .mockResolvedValueOnce(
        agentSessionsPage([edge("c1", sessionNode("s1", "completed"))], true, "c1"),
      )
      .mockResolvedValueOnce(
        agentSessionsPage([edge("c2", sessionNode("s2", "working"))], true, "c2"),
      )
      .mockResolvedValueOnce(
        agentSessionsPage([edge("c3", sessionNode("s3", "working"))], false, "c3"),
      );

    const result = await listAgentSessionsPage({ status: "working", limit: 2 });

    expect(result.nodes.map((session) => session.id)).toEqual(["s2", "s3"]);
    expect(result.searchedCount).toBe(3);
    expect(result.pageInfo).toEqual({ hasNextPage: false, endCursor: "c3" });
    expect(mocks.rawRequest).toHaveBeenCalledTimes(3);
    expect(mocks.rawRequest).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ first: 250, after: undefined }),
    );
  });

  it("continues from the last consumed edge when a filtered page fills mid-page", async () => {
    mocks.rawRequest.mockResolvedValueOnce(
      agentSessionsPage(
        [
          edge("c1", sessionNode("s1", "completed")),
          edge("c2", sessionNode("s2", "working")),
          edge("c3", sessionNode("s3", "working")),
        ],
        false,
        "c3",
      ),
    );

    const first = await listAgentSessionsPage({ status: "working", limit: 1 });

    expect(first.nodes.map((session) => session.id)).toEqual(["s2"]);
    expect(first.searchedCount).toBe(2);
    expect(first.pageInfo).toEqual({ hasNextPage: true, endCursor: "c2" });

    mocks.rawRequest.mockResolvedValueOnce(
      agentSessionsPage([edge("c3", sessionNode("s3", "working"))], false, "c3"),
    );

    const second = await listAgentSessionsPage({
      status: "working",
      limit: 1,
      after: first.pageInfo.endCursor ?? undefined,
    });

    expect(second.nodes.map((session) => session.id)).toEqual(["s3"]);
    expect(mocks.rawRequest).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ after: "c2" }),
    );
  });

  it("filters issue-scoped session requests client-side from the top-level connection", async () => {
    mocks.rawRequest.mockResolvedValueOnce(
      agentSessionsPage(
        [
          edge("c1", sessionNode("s1", "working", "other-issue")),
          edge("c2", sessionNode("s2", "working", "issue-1")),
        ],
        false,
        "c2",
      ),
    );

    const result = await listAgentSessionsPage({ issueId: "issue-1", limit: 1 });

    expect(result.nodes.map((session) => session.id)).toEqual(["s2"]);
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      expect.not.stringContaining("issue(id:"),
      expect.objectContaining({ first: 250, after: undefined }),
    );
  });
});

function edge(cursor: string, node: ReturnType<typeof sessionNode>) {
  return { cursor, node };
}

function sessionNode(id: string, status: string, issueId = "issue-1") {
  return {
    id,
    status,
    type: "assistant",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    endedAt: null,
    issue: { id: issueId, identifier: "NOX-1", title: "Issue 1" },
    creator: { id: "user-1", name: "Agent User", email: "agent@example.com" },
  };
}

function agentSessionsPage(
  edges: Array<ReturnType<typeof edge>>,
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      agentSessions: {
        edges,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

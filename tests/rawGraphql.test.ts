import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import {
  assertRawGraphQLOperationAllowed,
  assertRawGraphQLPaginateAllowed,
  classifyRawGraphQLOperation,
} from "../src/lib/rawGraphql.ts";

describe("classifyRawGraphQLOperation", () => {
  it("classifies anonymous selection sets as queries", () => {
    expect(classifyRawGraphQLOperation("{ viewer { id } }")).toBe("query");
  });

  it("ignores leading trivia before explicit operation keywords", () => {
    expect(
      classifyRawGraphQLOperation(
        "\uFEFF\n# comment\nmutation M { issueCreate(input:{}) { success } }",
      ),
    ).toBe("mutation");
    expect(classifyRawGraphQLOperation(" subscription S { events { id } }")).toBe("subscription");
  });

  it("classifies non-operation documents as unknown", () => {
    expect(classifyRawGraphQLOperation("fragment IssueFields on Issue { id }")).toBe("unknown");
  });

  it("detects operation definitions after leading fragments", () => {
    expect(
      classifyRawGraphQLOperation(
        'fragment IssueFields on Issue { id title }\nquery GetIssue { issue(id: "NOX-1") { ...IssueFields } }',
      ),
    ).toBe("query");
    expect(
      classifyRawGraphQLOperation(
        'fragment IssueFields on Issue { id title }\nmutation Rename { issueUpdate(id: "issue-id", input: { title: "New" }) { success } }',
      ),
    ).toBe("mutation");
  });

  it("treats any mutation operation in a mixed document as mutation-bearing", () => {
    expect(
      classifyRawGraphQLOperation(
        'query Viewer { viewer { id } }\nmutation Rename { issueUpdate(id: "issue-id", input: { title: "New" }) { success } }',
      ),
    ).toBe("mutation");
    expect(
      classifyRawGraphQLOperation(
        "fragment Words on Issue { description }\nquery Viewer { viewer { id } }",
      ),
    ).toBe("query");
  });

  it("treats any subscription operation in a mixed document as subscription-bearing", () => {
    expect(
      classifyRawGraphQLOperation(
        "query Viewer { viewer { id } }\nsubscription Events { issueCreated { id } }",
      ),
    ).toBe("subscription");
  });
});

describe("assertRawGraphQLPaginateAllowed", () => {
  it("allows queries", () => {
    expect(() => assertRawGraphQLPaginateAllowed("query { teams { nodes { id } } }")).not.toThrow();
  });

  it("rejects mutations, subscriptions, and unknown documents", () => {
    for (const query of [
      "mutation M { issueCreate(input:{}) { success } }",
      "fragment IssueFields on Issue { id }\nmutation M { issueCreate(input:{}) { success } }",
      "subscription S { events { id } }",
      "fragment IssueFields on Issue { id }",
    ]) {
      expect(() => assertRawGraphQLPaginateAllowed(query)).toThrow(ValidationError);
    }
  });
});

describe("assertRawGraphQLOperationAllowed", () => {
  const gateOpts = {
    mutationMessage: "raw GraphQL mutation requires --allow-mutation",
    mutationHint:
      "prefer first-class lebop write tools; if raw mutation is intentional, re-run with --allow-mutation",
    surface: "raw GraphQL",
  };

  it("allows queries and explicitly allowed mutations", () => {
    expect(assertRawGraphQLOperationAllowed("query { viewer { id } }", gateOpts)).toBe("query");
    expect(
      assertRawGraphQLOperationAllowed("mutation M { issueCreate(input:{}) { success } }", {
        ...gateOpts,
        allowMutation: true,
      }),
    ).toBe("mutation");
  });

  it("rejects mutations without explicit opt-in", () => {
    expect(() =>
      assertRawGraphQLOperationAllowed(
        "mutation M { issueCreate(input:{}) { success } }",
        gateOpts,
      ),
    ).toThrow("raw GraphQL mutation requires --allow-mutation");
  });

  it("rejects subscriptions and unknown documents", () => {
    for (const query of [
      "subscription S { events { id } }",
      "query Viewer { viewer { id } }\nsubscription S { events { id } }",
      "mutation M { issueCreate(input:{}) { success } }\nsubscription S { events { id } }",
      "fragment IssueFields on Issue { id }",
    ]) {
      expect(() => assertRawGraphQLOperationAllowed(query, gateOpts)).toThrow(ValidationError);
    }
  });
});

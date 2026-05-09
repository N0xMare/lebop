# Security policy

lebop touches Linear API tokens, which grant full access to your Linear
workspace. We take security reports seriously.

## What lebop does with credentials

- **Storage**: Personal API keys (PAKs) are stored at
  `~/.lebop/auth.json`, mode `0600`, dir `0700`. Multi-workspace shape
  (schema v2) keeps a token per workspace + an optional `default`.
- **Transport**: tokens go in the HTTP `Authorization` header to
  `https://api.linear.app/graphql` (or the test override at
  `LEBOP_API_URL`). They are never written to logs or stdout.
- **Process boundary**: tokens never cross a child-process boundary unless
  you use `lebop auth token` to print them explicitly (e.g. for piping
  to `curl`).
- **No telemetry**. lebop does not phone home, collect usage data, or
  send anything to any host other than the Linear API endpoint.

## What's NOT covered

- The `lebop raw` GraphQL escape hatch can do anything Linear's API can
  do, including reading/writing all data your token has access to. Use
  with care.
- `~/.lebop/cache/<repo-hash>/` may contain issue descriptions, comments,
  and other Linear content. Handle this directory like any other working
  set on your machine.
- The `LEBOP_API_URL` env var disables HTTPS pinning to `api.linear.app`
  (it's intended for tests + local development). Don't set this in
  production environments.

## Reporting a vulnerability

**Please do not file a public issue for security bugs.**

Report to: open a GitHub Security Advisory at
`https://github.com/N0xMare/lebop/security/advisories/new` (private). If
you can't access GitHub, contact the maintainer through their GitHub
profile.

Please include:

1. What you observed and what you expected.
2. Reproduction steps (a redacted command + output is ideal).
3. Your assessment of impact (read-only? full token leak? code
   execution?).

We'll respond within 7 days with an acknowledgment and a tracking issue
in the private advisory. Coordinated disclosure is preferred for
high-impact issues; please give us a chance to ship a fix before public
disclosure.

## Scope

- **In scope**: any code path in `src/`, the install script, distribution
  binaries, and the example plan files.
- **Out of scope**: vulnerabilities in upstream dependencies (report to
  them directly), Linear's own API surface, or general "this token has
  too much power" framing — that's a Linear API design issue.

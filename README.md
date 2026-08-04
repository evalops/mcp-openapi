# mcp-openapi

[![CI](https://github.com/evalops/mcp-openapi/actions/workflows/ci.yml/badge.svg)](https://github.com/evalops/mcp-openapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Turn an OpenAPI 3.x spec into an MCP server. Each operation becomes an MCP tool; tool calls are validated, proxied to the upstream REST API, and the response is validated against the spec's response schemas.

> **Install from GitHub.** The `mcp-openapi` package on the npm registry is an unrelated third-party project. This project is installed as `github:evalops/mcp-openapi`.

## Quickstart

Run against any OpenAPI file, no install step:

```bash
npx -y github:evalops/mcp-openapi --spec ./openapi.yaml
```

Add to Claude Code:

```bash
claude mcp add my-api -- npx -y github:evalops/mcp-openapi --spec /abs/path/openapi.yaml
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": ["-y", "github:evalops/mcp-openapi", "--spec", "/abs/path/openapi.yaml"]
    }
  }
}
```

HTTP transport instead of stdio:

```bash
npx -y github:evalops/mcp-openapi --spec ./openapi.yaml --transport streamable-http --port 3000
# MCP endpoint: http://127.0.0.1:3000/mcp
```

## How operations map to tools

- One MCP tool per OpenAPI operation. Tool name defaults to `operationId`; missing IDs fall back to `method_path`. Collisions get a numeric suffix.
- Tool input is grouped by parameter location: `{ path, query, header, cookie, body, pagination }`.
- Tool annotations are derived from the HTTP method: `GET`/`HEAD`/`OPTIONS` are marked `readOnlyHint`, `PUT`/`DELETE` idempotent + destructive, `POST`/`PATCH` destructive.
- Inputs are validated twice (Zod and AJV) before any network call. Responses are validated against the per-status response schemas; validation failures set `isError` and include the issue list.
- Successful responses are returned as `structuredContent` plus a JSON text block with status, headers (allowlisted subset), attempt count, and validation results.
- `tools/list` is cursor-paginated at 50 tools per page and emits `listChanged` when `--watch-spec` reloads the spec.
- `x-mcp-hidden: true` on an operation removes it. `x-mcp-description` overrides the tool description, then `--descriptions` file entries, then `summary`/`description`.

## Transports

| Transport | Flag | Endpoints |
|---|---|---|
| stdio (default) | `--transport stdio` | — |
| Streamable HTTP | `--transport streamable-http` | `/mcp`, `/health`, `/metrics`, `/test/streamable` |
| SSE (legacy) | `--transport sse` | `/sse`, `/messages?sessionId=…`, `/health`, `/metrics`, `/test/sse` |

## Security model

- Web transports bind `127.0.0.1` by default. Set `--host 0.0.0.0` to expose beyond the local machine.
- The `Origin` header is validated on `/mcp`, `/sse`, and `/messages` to block DNS-rebinding from browsers. Localhost origins are always accepted; add others with `--allow-origins`. Clients that send no `Origin` header (normal MCP clients) are unaffected.
- Set `MCP_OPENAPI_HTTP_AUTH_TOKEN` to require `Authorization: Bearer <token>` on `/mcp`, `/sse`, and `/messages`. Comparison is timing-safe. `/health` and `/metrics` stay open.
- Outbound calls can be restricted with `--allow-hosts`, `--allow-methods`, `--allow-path-prefixes`, and tool name patterns (`--allow-tools`, `--deny-tools`, `*` wildcard).
- `--policy-webhook <url>` POSTs `{tool, method, path, input, tags}` before each call and blocks unless the webhook answers `{"allow": true}`. Webhook errors block the call. Decisions are cached for 30 s per tool.
- Values under keys containing `authorization`, `token`, `password`, or `secret` are replaced with `[REDACTED]` in MCP logging notifications.
- Responses larger than `--max-response-bytes` (default 2 MB) are rejected. Concurrent tool calls are capped by `--max-concurrency` (default 8).

## Upstream authentication

Auth is injected from environment variables based on the spec's `securitySchemes`:

| Scheme | Env vars |
|---|---|
| Any scheme, by name | `MCP_OPENAPI_<SCHEME_NAME>_TOKEN` |
| API key (`in: header\|query\|cookie`) | `MCP_OPENAPI_API_KEY` |
| HTTP Bearer | `MCP_OPENAPI_BEARER_TOKEN` |
| HTTP Basic | `MCP_OPENAPI_BASIC_USERNAME`, `MCP_OPENAPI_BASIC_PASSWORD` |
| OAuth2 / OIDC, static token | `MCP_OPENAPI_OAUTH2_ACCESS_TOKEN` |
| OAuth2 client credentials | `MCP_OPENAPI_OAUTH2_CLIENT_ID`, `MCP_OPENAPI_OAUTH2_CLIENT_SECRET` (token fetched from the scheme's `tokenUrl` and cached until expiry) |

`--auth-scope tag=PREFIX` maps operations with a given OpenAPI tag to a different env prefix, e.g. `--auth-scope governance=GOV` makes governance-tagged operations read `GOV_BEARER_TOKEN`.

## Pagination

Every tool whose operation has query parameters accepts a `pagination` argument:

```json
{ "pagination": { "enabled": true, "mode": "autoCursor", "maxPages": 5, "cursorParam": "cursor", "nextCursorPath": "next_cursor" } }
```

`autoCursor` follows a cursor field in the response body; `incrementPage` increments a page number until an empty page. Page bodies are merged (arrays concatenated, `items` arrays merged) and the result reports `pagesFetched` and why fetching stopped.

## CLI reference

```
mcp-openapi --spec <openapi-file> [options]
mcp-openapi init [dir]
mcp-openapi generate --spec <openapi-file> [--out-dir ./generated]
```

| Flag | Default | Purpose |
|---|---|---|
| `--spec <file>` | required | OpenAPI 3.x file, YAML or JSON |
| `--server-url <url>` | spec `servers[0]` | Override upstream base URL |
| `--transport <t>` | `stdio` | `stdio`, `streamable-http`, or `sse` |
| `--port <n>` | `3000` | Web transport port |
| `--host <addr>` | `127.0.0.1` | Web transport bind address |
| `--allow-origins o1,o2` | localhost only | Extra allowed `Origin` values |
| `--strict` | off | Fail on lint errors (missing operationIds, etc.) |
| `--validate-spec` | off | Compile, report tool count, exit |
| `--print-tools` | off | List tool names, exit |
| `--watch-spec` | off | Recompile on spec file change |
| `--tool-name-template <t>` | `{operationId}` | Placeholders: `{operationId}`, `{method}`, `{path}`, `{tag}`, `{service}` |
| `--tool-name-separator <c>` | `_` | Separator used in generated names |
| `--descriptions <file>` | — | JSON/YAML map of operationId → description |
| `--auth-scope tag=PREFIX,…` | — | Per-tag env prefix for upstream auth |
| `--policy-webhook <url>` | — | Pre-call policy check, fail-closed |
| `--allow-hosts h1,h2` | all | Upstream host allowlist |
| `--allow-tools p1,p2` / `--deny-tools p1,p2` | — | Tool name patterns, `*` wildcard |
| `--allow-methods GET,POST` | all | HTTP method allowlist |
| `--allow-path-prefixes /v1` | all | Path prefix allowlist |
| `--timeout-ms <ms>` | `20000` | Per-request timeout |
| `--retries <n>` | `2` | Retries on 408/429/5xx and network errors, honors `Retry-After` |
| `--retry-delay-ms <ms>` | `500` | Base retry delay (multiplied by attempt) |
| `--max-response-bytes <n>` | `2000000` | Response size cap |
| `--max-concurrency <n>` | `8` | Concurrent tool call cap |
| `--response-transform <module>` | — | JS module transforming response bodies |
| `--cache-path <file>` | `.cache/mcp-openapi-cache.json` | Compiled-operation cache |
| `--sse-max-sessions <n>` | `100` | SSE session cap |
| `--sse-session-ttl-ms <ms>` | `300000` | SSE session TTL |
| `--version` | — | Print version, exit |

Unknown flags are an error.

Response transform module:

```js
export default function transform({ operation, response }) {
  return { ...response.body, transformedBy: operation.operationId };
}
```

## Observability

`/metrics` serves Prometheus text format: `mcp_openapi_tool_calls_total`, `_failed_total`, `_cancelled_total`, `_in_flight`, `_by_status_total{status}`, `mcp_openapi_retries_total`, `mcp_openapi_tool_call_latency_avg_ms`, and a latency histogram `mcp_openapi_tool_call_latency_ms_bucket`. Tool call start/completion and retry events are also emitted as MCP logging notifications.

## Library usage

```ts
import { parseSpec, generateToolsWithTags } from "mcp-openapi";

const spec = await parseSpec("./openapi.yaml");
const { tools } = generateToolsWithTags(spec, { prefix: "github" });
```

Exports: `parseSpec`, `generateTools`, `generateToolsWithTags`, and the `NormalizedSpec` types.

## Scaffolding

- `mcp-openapi init [dir]` writes a starter project: `package.json`, `tsconfig.json`, `src/server.ts`, `.env.example`, `README.md`, `Dockerfile`, and a `gate/` directory with a Gate connector config.
- `mcp-openapi generate --spec … --out-dir …` writes the same skeleton pinned to your spec, plus a Gate Rego policy allowlisting the compiled tool names.

## Development

```bash
npm ci
npm run check   # tsc --noEmit
npm test        # node:test suite
npm run smoke   # build + end-to-end stdio smoke
npm run mcp:inspect  # MCP Inspector tools/list against the sample spec
```

## License

MIT

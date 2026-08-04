import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { compileOperations } from "../src/compiler.js";
import { loadOpenApiDocument } from "../src/openapi.js";
import { zodFromJsonSchema } from "../src/zod-schema.js";
import { renderPrometheus, setBuildInfo } from "../src/metrics.js";

const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");

function cyclicSpec(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Cyclic API", version: "1.0.0" },
    servers: [{ url: "https://cyclic.invalid" }],
    paths: {
      "/nodes": {
        get: {
          operationId: "listNodes",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Node" } }
              }
            }
          }
        }
      }
    },
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: {
            id: { type: "string" },
            child: { $ref: "#/components/schemas/Node" }
          }
        }
      }
    }
  };
}

test("recursive $ref specs compile to serializable, validatable operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-cyclic-"));
  const specPath = join(dir, "cyclic.json");
  await writeFile(specPath, JSON.stringify(cyclicSpec()), "utf8");

  const doc = await loadOpenApiDocument(specPath);
  const operations = compileOperations(doc);
  const op = operations.get("listNodes");
  assert.ok(op);

  // The compiled model must be cycle-free: cacheable and schema-compilable.
  const serialized = JSON.stringify(op);
  assert.ok(serialized.length > 0);
  assert.ok(op.outputSchema);
  const validator = zodFromJsonSchema(op.outputSchema);
  const parsed = validator.safeParse({ id: "a", child: { id: "b", child: {} } });
  assert.equal(parsed.success, true);
});

test("server startup succeeds on a recursive spec (--validate-spec)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-cyclic-cli-"));
  const specPath = join(dir, "cyclic.json");
  await writeFile(specPath, JSON.stringify(cyclicSpec()), "utf8");

  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", specPath, "--cache-path", join(dir, "cache.json"), "--validate-spec"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Compiled 1 tools/);
});

test("spec resource for a recursive spec renders with [Circular] markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-cyclic-res-"));
  const specPath = join(dir, "cyclic.json");
  await writeFile(specPath, JSON.stringify(cyclicSpec()), "utf8");

  const client = new Client({ name: "adversarial-test", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js", "--spec", specPath, "--cache-path", join(dir, "cache.json")],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const result = await client.request(
      { method: "resources/read", params: { uri: "openapi://cyclic/spec" } },
      ReadResourceResultSchema
    );
    const text = String(result.contents[0]?.text);
    const doc = JSON.parse(text) as Record<string, unknown>;
    assert.equal(typeof doc.openapi, "string");
    assert.ok(text.includes("[Circular]"));
  } finally {
    await transport.close();
  }
});

test("__proto__ schema properties are validated, not silently dropped", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ["__proto__"]: { type: "string" },
      ok: { type: "boolean" }
    }
  };

  const validator = zodFromJsonSchema(schema);

  const good = validator.safeParse(JSON.parse('{"__proto__": "s", "ok": true}'));
  assert.equal(good.success, true);

  const bad = validator.safeParse(JSON.parse('{"__proto__": 5, "ok": true}'));
  assert.equal(bad.success, false, "a __proto__ property violating its schema must fail validation");

  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
});

test("duplicate operationIds within a spec get numeric suffixes", () => {
  const doc = {
    openapi: "3.0.3",
    info: { title: "Dup", version: "1.0.0" },
    servers: [{ url: "https://dup.invalid" }],
    paths: {
      "/a": { get: { operationId: "getThing", responses: { "200": { description: "ok" } } } },
      "/b": { get: { operationId: "getThing", responses: { "200": { description: "ok" } } } }
    }
  };

  const operations = compileOperations(doc as Record<string, unknown>);
  assert.ok(operations.has("getThing"));
  assert.ok(operations.has("getThing_2"));
});

test("metrics expose build_info and uptime", () => {
  setBuildInfo("9.9.9-test");
  const rendered = renderPrometheus();
  assert.match(rendered, /mcp_openapi_build_info\{version="9\.9\.9-test"\} 1/);
  assert.match(rendered, /mcp_openapi_uptime_seconds \d+/);
});

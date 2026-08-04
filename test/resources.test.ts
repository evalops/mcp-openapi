import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListResourcesResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";

async function withStdioClient(args: string[], fn: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ name: "resources-test", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js", ...args],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await transport.close();
  }
}

test("resources/list exposes spec document and tool index per spec", async () => {
  await withStdioClient(["--spec", "test/fixtures/sample-openapi.yaml"], async (client) => {
    const result = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
    const uris = result.resources.map((r) => r.uri).sort();
    assert.deepEqual(uris, ["openapi://sample-openapi/spec", "openapi://sample-openapi/tools"]);
    assert.ok(result.resources.every((r) => r.mimeType === "application/json"));
  });
});

test("resources/read returns the dereferenced OpenAPI document", async () => {
  await withStdioClient(["--spec", "test/fixtures/sample-openapi.yaml"], async (client) => {
    const result = await client.request(
      { method: "resources/read", params: { uri: "openapi://sample-openapi/spec" } },
      ReadResourceResultSchema
    );
    const doc = JSON.parse(String(result.contents[0]?.text)) as Record<string, unknown>;
    assert.equal(typeof doc.openapi, "string");
    assert.ok(doc.paths && typeof doc.paths === "object");
  });
});

test("resources/read tool index lists compiled tools and respects deny policy", async () => {
  await withStdioClient(
    ["--spec", "test/fixtures/sample-openapi.yaml", "--deny-tools", "postEcho"],
    async (client) => {
      const result = await client.request(
        { method: "resources/read", params: { uri: "openapi://sample-openapi/tools" } },
        ReadResourceResultSchema
      );
      const index = JSON.parse(String(result.contents[0]?.text)) as Array<{ name: string; method: string; path: string }>;
      const names = index.map((entry) => entry.name);
      assert.ok(names.includes("getHealth"));
      assert.ok(!names.includes("postEcho"), `deny-listed tool leaked into index: ${names.join(",")}`);
      const health = index.find((entry) => entry.name === "getHealth");
      assert.equal(health?.method, "GET");
      assert.equal(health?.path, "/health");
    }
  );
});

test("resources/read rejects unknown URIs", async () => {
  await withStdioClient(["--spec", "test/fixtures/sample-openapi.yaml"], async (client) => {
    await assert.rejects(
      client.request({ method: "resources/read", params: { uri: "openapi://nope/spec" } }, ReadResourceResultSchema),
      /Unknown resource/
    );
  });
});

test("multi-spec servers expose resources per spec", async () => {
  await withStdioClient(
    ["--spec", "alpha=test/fixtures/sample-openapi.yaml", "--spec", "beta=test/fixtures/sample-openapi.yaml"],
    async (client) => {
      const result = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
      const uris = result.resources.map((r) => r.uri).sort();
      assert.deepEqual(uris, [
        "openapi://alpha/spec",
        "openapi://alpha/tools",
        "openapi://beta/spec",
        "openapi://beta/tools"
      ]);

      const betaTools = await client.request(
        { method: "resources/read", params: { uri: "openapi://beta/tools" } },
        ReadResourceResultSchema
      );
      const index = JSON.parse(String(betaTools.contents[0]?.text)) as Array<{ name: string }>;
      assert.ok(index.some((entry) => entry.name === "beta_getHealth"));
      assert.ok(index.every((entry) => entry.name.startsWith("beta_")));
    }
  );
});

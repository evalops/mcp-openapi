import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
const sampleSpec = "test/fixtures/sample-openapi.yaml";

test("multiple named specs prefix tool names deterministically", () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", `alpha=${sampleSpec}`, "--spec", `beta=${sampleSpec}`, "--print-tools"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^alpha_getHealth\t/m);
  assert.match(result.stdout, /^beta_getHealth\t/m);
  assert.doesNotMatch(result.stdout, /^getHealth\t/m);
});

test("unnamed duplicate specs fall back to basename prefix plus numeric suffix", () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", sampleSpec, "--spec", sampleSpec, "--print-tools"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^sample-openapi_getHealth\t/m);
  assert.match(result.stdout, /^sample-openapi_getHealth_2\t/m);
});

test("single spec keeps bare operationIds", () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", sampleSpec, "--print-tools"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^getHealth\t/m);
});

test("--server-url is rejected with multiple specs", () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", `a=${sampleSpec}`, "--spec", `b=${sampleSpec}`, "--server-url", "http://127.0.0.1:9", "--print-tools"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--server-url is only valid with a single --spec/);
});

test("multi-spec tools are callable end-to-end over stdio", async () => {
  const apiServer = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/health")) {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolveListen) => apiServer.listen(0, resolveListen));
  const address = apiServer.address();
  assert.ok(address && typeof address === "object");
  const apiBase = `http://127.0.0.1:${address.port}`;

  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-multi-"));
  const doc = yaml.load(await readFile(sampleSpec, "utf8")) as Record<string, unknown>;
  doc.servers = [{ url: apiBase }];
  const specA = join(dir, "a.yaml");
  const specB = join(dir, "b.yaml");
  await writeFile(specA, yaml.dump(doc), "utf8");
  await writeFile(specB, yaml.dump(doc), "utf8");

  const client = new Client({ name: "multi-spec-e2e", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js", "--spec", `alpha=${specA}`, "--spec", `beta=${specB}`],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);

    const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes("alpha_getHealth"), `missing alpha_getHealth in ${names.join(",")}`);
    assert.ok(names.includes("beta_getHealth"), `missing beta_getHealth in ${names.join(",")}`);

    const health = await client.request(
      { method: "tools/call", params: { name: "beta_getHealth", arguments: {} } },
      CallToolResultSchema
    );
    assert.equal(health.isError, false);
    assert.equal((health.structuredContent as Record<string, unknown>).ok, true);
  } finally {
    await transport.close();
    await new Promise<void>((resolveClose, reject) => apiServer.close((err) => (err ? reject(err) : resolveClose())));
  }
});

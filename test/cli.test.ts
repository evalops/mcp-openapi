import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");

test("strict mode fails for spec missing operationId", async () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", "test/fixtures/missing-operationid-openapi.yaml", "--strict", "--validate-spec"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPERATION_ID_MISSING/);
});

test("generate command creates project files", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "mcp-openapi-generate-"));
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "generate", "--spec", "test/fixtures/sample-openapi.yaml", "--out-dir", outDir],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0);

  const packageJson = await readFile(resolve(outDir, "package.json"), "utf8");
  const readme = await readFile(resolve(outDir, "README.md"), "utf8");
  const serverTs = await readFile(resolve(outDir, "src/server.ts"), "utf8");
  const gateReadme = await readFile(resolve(outDir, "gate/README.md"), "utf8");
  const gateConnector = await readFile(resolve(outDir, "gate/connector.yaml"), "utf8");
  const gatePolicy = await readFile(resolve(outDir, "gate/policies/mcp_tool_allowlist.rego"), "utf8");

  assert.match(packageJson, /mcp-openapi/);
  assert.match(readme, /Generated MCP Server/);
  assert.match(readme, /Gate Gateway/);
  assert.match(serverTs, /--spec/);
  assert.match(gateReadme, /Point your MCP client at Gate/);
  assert.match(gateConnector, /protocol: "mcp"/);
  assert.match(gateConnector, /path: "policies\/mcp_tool_allowlist\.rego"/);
  assert.match(gateConnector, /dir: "\.\.\/\.data\/gate-mcp-recordings"/);
  assert.match(gatePolicy, /approved_tools/);
  assert.match(gatePolicy, /getHealth/);
  assert.match(gatePolicy, /postEcho/);
});

test("init command creates Gate scaffold files", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "mcp-openapi-init-"));
  const result = spawnSync(process.execPath, [tsxCli, "src/server.ts", "init", outDir], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);

  const gateReadme = await readFile(resolve(outDir, "gate/README.md"), "utf8");
  const gateConnector = await readFile(resolve(outDir, "gate/connector.yaml"), "utf8");

  assert.match(gateReadme, /Gate MCP Gateway/);
  assert.match(gateConnector, /endpoint_path: "\/mcp"/);
  assert.match(gateConnector, /dir: "\.\.\/\.data\/gate-mcp-recordings"/);
});

test("unknown CLI arguments are rejected", async () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", "test/fixtures/sample-openapi.yaml", "--allow-host", "example.com"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument: --allow-host/);
});

test("--version prints the package version", async () => {
  const result = spawnSync(process.execPath, [tsxCli, "src/server.ts", "--version"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("scaffolds depend on the GitHub source, not the unrelated npm package", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "mcp-openapi-dep-"));
  const result = spawnSync(process.execPath, [tsxCli, "src/server.ts", "init", outDir], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const packageJson = JSON.parse(await readFile(resolve(outDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(packageJson.dependencies["mcp-openapi"], "github:evalops/mcp-openapi");
});

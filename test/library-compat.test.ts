import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToolsWithTags, parseSpec } from "../src/index.js";

test("library exports parseSpec and generateToolsWithTags with Ensemble-compatible shapes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-lib-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const specPath = join(dir, "compat-spec.json");
  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Compat spec",
      version: "1.0.0"
    },
    servers: [{ url: "https://{region}.example.com", variables: { region: { default: "us" } } }],
    paths: {
      "/widgets/{widgetId}": {
        parameters: [
          {
            name: "traceId",
            in: "header",
            required: false,
            schema: { type: "string" }
          }
        ],
        post: {
          operationId: "createWidgetEvent",
          summary: "Create widget event",
          tags: ["widgets", "events"],
          parameters: [
            {
              name: "widgetId",
              in: "path",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "expand",
              in: "query",
              schema: { type: "string", nullable: true }
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    count: { type: "integer" }
                  },
                  required: ["title"]
                }
              }
            }
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  await writeFile(specPath, JSON.stringify(spec), "utf8");

  const normalized = await parseSpec(specPath);
  assert.equal(normalized.info.title, "Compat spec");
  assert.equal(normalized.servers[0]?.url, "https://us.example.com");
  assert.equal(normalized.endpoints.length, 1);
  assert.deepEqual(normalized.endpoints[0]?.tags, ["widgets", "events"]);

  const generated = generateToolsWithTags(normalized, { prefix: "github" });
  assert.equal(generated.tools.length, 1);

  const tool = generated.tools[0];
  assert.equal(tool?.name, "github_create_widget_event");
  assert.equal(tool?.endpointRef.method, "POST");
  assert.equal(tool?.endpointRef.baseUrl, "https://us.example.com");
  assert.deepEqual(
    tool?.endpointRef.parameterMap.map((entry) => [entry.toolParamName, entry.source, entry.originalName]),
    [
      ["widgetId", "path", "widgetId"],
      ["expand", "query", "expand"],
      ["traceId", "header", "traceId"],
      ["title", "body", "title"],
      ["count", "body", "count"]
    ]
  );

  const properties = (tool?.inputSchema.properties ?? {}) as Record<string, unknown>;
  assert.deepEqual((properties.expand as Record<string, unknown>).type, ["string", "null"]);
  assert.deepEqual(generated.tagMap.get("github_create_widget_event"), ["widgets", "events"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { compileOperations } from "../src/compiler.js";
import { loadOpenApiDocument } from "../src/openapi.js";

test("compileOperations normalizes nullable and combiners", () => {
  const doc = {
    openapi: "3.0.3",
    servers: [{ url: "http://example.test" }],
    paths: {
      "/users": {
        post: {
          operationId: "createUser",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    nickname: { type: "string", nullable: true },
                    profile: {
                      oneOf: [{ type: "string" }, { type: "number" }],
                      nullable: true
                    },
                    tags: {
                      type: "array",
                      items: {
                        allOf: [{ type: "string" }],
                        nullable: true
                      }
                    }
                  }
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
  } as Record<string, unknown>;

  const operations = compileOperations(doc);
  const op = operations.get("createUser");
  assert.ok(op);

  const schema = op.inputSchema as Record<string, unknown>;
  const body = ((schema.properties as Record<string, unknown>).body ?? {}) as Record<string, unknown>;
  const properties = (body.properties ?? {}) as Record<string, unknown>;

  const nickname = properties.nickname as Record<string, unknown>;
  assert.deepEqual(nickname.type, ["string", "null"]);

  const profile = properties.profile as Record<string, unknown>;
  assert.ok(Array.isArray(profile.oneOf));
  assert.equal((profile.oneOf as unknown[]).length, 3);

  const tags = properties.tags as Record<string, unknown>;
  const items = tags.items as Record<string, unknown>;
  assert.ok(Array.isArray(items.anyOf));
  assert.equal((items.anyOf as unknown[]).length, 2);

  assert.equal(op.responseContentType, "application/json");
  assert.ok(op.successResponseSchema);
  assert.ok(op.outputSchema);
});

test("compileOperations builds object outputSchema for non-object responses and resolves server variables", () => {
  const doc = {
    openapi: "3.0.3",
    servers: [{ url: "https://{region}.example.com", variables: { region: { default: "us" } } }],
    paths: {
      "/items": {
        get: {
          operationId: "list.items!",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  } as Record<string, unknown>;

  const operations = compileOperations(doc);
  const op = operations.get("list_items");
  assert.ok(op);

  assert.equal(op.servers[0], "https://us.example.com");
  assert.equal(op.outputWrapKey, "result");

  const output = op.outputSchema as Record<string, unknown>;
  assert.equal(output.type, "object");
  const resultSchema = ((output.properties as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
  assert.equal(resultSchema.type, "array");
});

test("compileOperations supports tool name templates with collision handling", () => {
  const doc = {
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/users": {
        get: { operationId: "listUsers", tags: ["users"], responses: { "200": { description: "ok" } } }
      },
      "/admins": {
        get: { operationId: "listAdmins", tags: ["users"], responses: { "200": { description: "ok" } } }
      }
    }
  } as Record<string, unknown>;

  const ops = compileOperations(doc, undefined, { toolNameTemplate: "{tag}_{method}" });
  const names = [...ops.keys()].sort();
  assert.deepEqual(names, ["users_get", "users_get_2"]);
});

test("compileOperations handles Xquik OpenAPI 3.1 auth and schemas", async () => {
  const doc = await loadOpenApiDocument("test/fixtures/xquik-openapi.yaml");
  const operations = compileOperations(doc);
  const operation = operations.get("searchTweets");
  assert.ok(operation);

  assert.equal(operation.method, "GET");
  assert.equal(operation.pathTemplate, "/api/v1/x/tweets/search");
  assert.equal(operation.servers[0], "https://xquik.com");
  assert.deepEqual(operation.tags, ["Tweets"]);
  assert.equal(operation.responseContentType, "application/json");
  assert.equal(operation.annotations?.readOnlyHint, true);

  const authSchemes = operation.authOptions.map((option) =>
    option.schemes.map((scheme) => [scheme.key, scheme.name, scheme.type, scheme.in, scheme.scheme])
  );
  assert.deepEqual(authSchemes, [
    [["apiKey", "x-api-key", "apiKey", "header", undefined]],
    [["oauthBearer", "oauthBearer", "http", undefined, "bearer"]]
  ]);

  const inputSchema = operation.inputSchema as Record<string, unknown>;
  const query = ((inputSchema.properties as Record<string, unknown>).query ?? {}) as Record<string, unknown>;
  const queryProperties = (query.properties ?? {}) as Record<string, unknown>;
  const queryType = queryProperties.queryType as Record<string, unknown>;
  const limit = queryProperties.limit as Record<string, unknown>;
  assert.deepEqual(queryType.enum, ["Latest", "Top"]);
  assert.equal(limit.maximum, 200);

  const outputSchema = operation.outputSchema as Record<string, unknown>;
  const outputProperties = (outputSchema.properties ?? {}) as Record<string, unknown>;
  const tweets = outputProperties.tweets as Record<string, unknown>;
  assert.equal(tweets.type, "array");
});

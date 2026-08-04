import test from "node:test";
import assert from "node:assert/strict";
import { isToolAllowed, matchToolPattern } from "../src/policy.js";
import type { OperationModel, RuntimeOptions } from "../src/types.js";

function runtime(overrides: Partial<RuntimeOptions>): RuntimeOptions {
  return {
    timeoutMs: 1000,
    retries: 0,
    retryDelayMs: 1,
    maxResponseBytes: 1000,
    allowedHosts: [],
    maxConcurrency: 1,
    allowToolPatterns: [],
    denyToolPatterns: [],
    allowedMethods: [],
    allowedPathPrefixes: [],
    sseMaxSessions: 1,
    sseSessionTtlMs: 1000,
    ...overrides
  };
}

function operation(overrides: Partial<OperationModel>): OperationModel {
  return {
    operationId: "getUsers",
    method: "GET",
    pathTemplate: "/users",
    description: "d",
    toolDescription: "d",
    inputSchema: { type: "object" },
    parameters: [],
    servers: ["https://api.example.com"],
    authOptions: [],
    ...overrides
  };
}

test("matchToolPattern treats * as wildcard", () => {
  assert.equal(matchToolPattern("getUsers", "get*"), true);
  assert.equal(matchToolPattern("deleteUsers", "get*"), false);
  assert.equal(matchToolPattern("anything", "*"), true);
});

test("matchToolPattern treats regex metacharacters as literals", () => {
  assert.equal(matchToolPattern("op?name", "op?name"), true);
  assert.equal(matchToolPattern("opname", "op?name"), false);
  assert.equal(matchToolPattern("opXname", "op?name"), false);
  assert.equal(matchToolPattern("a.b", "a.b"), true);
  assert.equal(matchToolPattern("aXb", "a.b"), false);
});

test("isToolAllowed applies allow and deny patterns", () => {
  const op = operation({});
  assert.equal(isToolAllowed(op, runtime({ allowToolPatterns: ["get*"] })), true);
  assert.equal(isToolAllowed(op, runtime({ allowToolPatterns: ["post*"] })), false);
  assert.equal(isToolAllowed(op, runtime({ denyToolPatterns: ["getUsers"] })), false);
  assert.equal(isToolAllowed(op, runtime({ allowedMethods: ["POST"] })), false);
  assert.equal(isToolAllowed(op, runtime({ allowedPathPrefixes: ["/admin"] })), false);
  assert.equal(isToolAllowed(op, runtime({ allowedPathPrefixes: ["/users"] })), true);
});

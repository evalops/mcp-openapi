import { loadOpenApiDocument } from "./openapi.js";

export type JsonSchema = Record<string, unknown>;

export interface NormalizedSpec {
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: Array<{ url: string }>;
  endpoints: NormalizedEndpoint[];
  securitySchemes: Record<string, NormalizedSecurityScheme>;
}

export interface NormalizedEndpoint {
  method: "get" | "post" | "put" | "patch" | "delete" | "head" | "options";
  path: string;
  operationId: string;
  summary?: string;
  description?: string;
  parameters: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses: Record<string, NormalizedResponse>;
  security?: SecurityRequirement[];
  tags?: string[];
  deprecated?: boolean;
}

export interface NormalizedParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface NormalizedRequestBody {
  required: boolean;
  description?: string;
  contentType: string;
  schema: JsonSchema;
}

export interface NormalizedResponse {
  description?: string;
  contentType?: string;
  schema?: JsonSchema;
}

export type NormalizedSecurityScheme =
  | { type: "apiKey"; name: string; in: "header" | "query" | "cookie" }
  | { type: "http"; scheme: string; bearerFormat?: string }
  | { type: "oauth2"; flows: Record<string, { tokenUrl?: string; scopes: Record<string, string> }> };

export type SecurityRequirement = Record<string, string[]>;

export interface ParameterMapping {
  toolParamName: string;
  source: "path" | "query" | "header" | "body";
  originalName: string;
  required: boolean;
}

export interface GeneratedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  endpointRef: {
    method: string;
    path: string;
    baseUrl: string;
    contentType: string;
    parameterMap: ParameterMapping[];
  };
}

export interface GenerateOptions {
  baseUrl?: string;
  prefix?: string;
  include?: string[];
  exclude?: string[];
}

export interface GenerateResult {
  tools: GeneratedTool[];
  tagMap: Map<string, string[]>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const PREFERRED_CONTENT_TYPES = [
  "application/json",
  "application/*+json",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
  "application/octet-stream",
  "text/plain"
] as const;
const MAX_TOOL_NAME_LENGTH = 64;

export async function parseSpec(specInput: string): Promise<NormalizedSpec> {
  const doc = await loadOpenApiDocument(specInput);
  return normalizeOpenApiDocument(doc);
}

export function generateTools(spec: NormalizedSpec, options: GenerateOptions = {}): GeneratedTool[] {
  return generateToolsWithTags(spec, options).tools;
}

export function generateToolsWithTags(spec: NormalizedSpec, options: GenerateOptions = {}): GenerateResult {
  const baseUrl = options.baseUrl ?? spec.servers[0]?.url ?? "http://localhost";
  let endpoints = spec.endpoints;

  if (options.include?.length) {
    endpoints = endpoints.filter((endpoint) =>
      options.include?.some((pattern) => matchPattern(endpoint.operationId, pattern))
      || options.include?.some((pattern) => matchPattern(endpoint.path, pattern))
    );
  }

  if (options.exclude?.length) {
    endpoints = endpoints.filter((endpoint) =>
      !options.exclude?.some((pattern) => matchPattern(endpoint.operationId, pattern))
      && !options.exclude?.some((pattern) => matchPattern(endpoint.path, pattern))
    );
  }

  const rawNames = endpoints.map((endpoint) =>
    generateToolName(endpoint.operationId, endpoint.method, endpoint.path, options.prefix)
  );
  const resolvedNames = resolveCollisions(rawNames);
  const tagMap = new Map<string, string[]>();

  const tools = endpoints.map((endpoint, index) => {
    const { inputSchema, parameterMap } = buildParams(endpoint);
    const name = resolvedNames[index] as string;
    tagMap.set(name, endpoint.tags ?? []);
    return {
      name,
      description: buildDescription(endpoint),
      inputSchema,
      endpointRef: {
        method: endpoint.method.toUpperCase(),
        path: endpoint.path,
        baseUrl: baseUrl.replace(/\/$/, ""),
        contentType: endpoint.requestBody?.contentType ?? "application/json",
        parameterMap
      }
    } satisfies GeneratedTool;
  });

  return { tools, tagMap };
}

function normalizeOpenApiDocument(doc: Record<string, unknown>): NormalizedSpec {
  const info = isRecord(doc.info) ? doc.info : {};
  const servers = normalizeServers(doc.servers);
  const paths = isRecord(doc.paths) ? doc.paths : {};
  const endpoints: NormalizedEndpoint[] = [];

  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!isRecord(rawPathItem)) {
      continue;
    }

    const pathParameters = normalizeParameters(rawPathItem.parameters);
    for (const method of HTTP_METHODS) {
      const rawOperation = rawPathItem[method];
      if (!isRecord(rawOperation)) {
        continue;
      }

      const operationParameters = normalizeParameters(rawOperation.parameters);
      endpoints.push({
        method,
        path,
        operationId: typeof rawOperation.operationId === "string" && rawOperation.operationId.trim()
          ? rawOperation.operationId.trim()
          : generateFallbackOperationId(method, path),
        ...(typeof rawOperation.summary === "string" ? { summary: rawOperation.summary } : {}),
        ...(typeof rawOperation.description === "string" ? { description: rawOperation.description } : {}),
        parameters: mergeParameters(pathParameters, operationParameters),
        ...(normalizeRequestBody(rawOperation.requestBody) ? { requestBody: normalizeRequestBody(rawOperation.requestBody)! } : {}),
        responses: normalizeResponses(rawOperation.responses),
        ...(Array.isArray(rawOperation.tags)
          ? { tags: rawOperation.tags.filter((tag): tag is string => typeof tag === "string") }
          : {}),
        ...(Array.isArray(rawOperation.security) ? { security: normalizeSecurityRequirements(rawOperation.security) } : {}),
        ...(rawOperation.deprecated === true ? { deprecated: true } : {})
      });
    }
  }

  return {
    info: {
      title: typeof info.title === "string" ? info.title : "Unknown API",
      version: typeof info.version === "string" ? info.version : "1.0.0",
      ...(typeof info.description === "string" ? { description: info.description } : {})
    },
    servers,
    endpoints,
    securitySchemes: normalizeSecuritySchemes(doc)
  };
}

function normalizeServers(value: unknown): Array<{ url: string }> {
  if (!Array.isArray(value)) {
    return [{ url: "http://localhost" }];
  }

  const servers = value
    .map((entry) => normalizeServer(entry))
    .filter((entry): entry is { url: string } => Boolean(entry));

  return servers.length > 0 ? servers : [{ url: "http://localhost" }];
}

function normalizeServer(value: unknown): { url: string } | null {
  if (!isRecord(value) || typeof value.url !== "string" || !value.url.trim()) {
    return null;
  }

  const variables = isRecord(value.variables) ? value.variables : {};
  return { url: applyServerVariables(value.url, variables) };
}

function applyServerVariables(urlTemplate: string, variables: Record<string, unknown>): string {
  return urlTemplate.replaceAll(/\{([^}]+)\}/g, (_full, variableName: string) => {
    const variable = variables[variableName];
    if (!isRecord(variable)) {
      return "";
    }

    if (typeof variable.default === "string") {
      return variable.default;
    }

    if (Array.isArray(variable.enum) && typeof variable.enum[0] === "string") {
      return String(variable.enum[0]);
    }

    return "";
  });
}

function normalizeParameters(value: unknown): NormalizedParameter[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parameters: NormalizedParameter[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.name !== "string" || !isParameterLocation(entry.in)) {
      continue;
    }

    parameters.push({
      name: entry.name,
      in: entry.in,
      required: Boolean(entry.required) || entry.in === "path",
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      schema: normalizeJsonSchema(isRecord(entry.schema) ? entry.schema : { type: "string" })
    });
  }

  return parameters;
}

function mergeParameters(pathParameters: NormalizedParameter[], operationParameters: NormalizedParameter[]): NormalizedParameter[] {
  const merged = new Map<string, NormalizedParameter>();
  for (const parameter of pathParameters) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  for (const parameter of operationParameters) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...merged.values()];
}

function normalizeRequestBody(value: unknown): NormalizedRequestBody | undefined {
  if (!isRecord(value) || !isRecord(value.content)) {
    return undefined;
  }

  const picked = pickContentWithSchema(value.content);
  if (!picked) {
    return undefined;
  }

  return {
    required: Boolean(value.required),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    contentType: picked.contentType,
    schema: picked.schema
  };
}

function normalizeResponses(value: unknown): Record<string, NormalizedResponse> {
  if (!isRecord(value)) {
    return {};
  }

  const responses: Record<string, NormalizedResponse> = {};
  for (const [statusCode, rawResponse] of Object.entries(value)) {
    if (!isRecord(rawResponse)) {
      continue;
    }

    const picked = isRecord(rawResponse.content) ? pickContentWithSchema(rawResponse.content) : undefined;
    responses[statusCode] = {
      ...(typeof rawResponse.description === "string" ? { description: rawResponse.description } : {}),
      ...(picked?.contentType ? { contentType: picked.contentType } : {}),
      ...(picked?.schema ? { schema: picked.schema } : {})
    };
  }
  return responses;
}

function pickContentWithSchema(content: Record<string, unknown>): { contentType: string; schema: JsonSchema } | undefined {
  for (const preferredType of PREFERRED_CONTENT_TYPES) {
    if (!(preferredType in content)) {
      continue;
    }
    const mediaType = content[preferredType];
    if (!isRecord(mediaType) || !isRecord(mediaType.schema)) {
      continue;
    }
    return {
      contentType: preferredType,
      schema: normalizeJsonSchema(mediaType.schema)
    };
  }

  for (const [contentType, mediaType] of Object.entries(content)) {
    if (!isRecord(mediaType) || !isRecord(mediaType.schema)) {
      continue;
    }
    return {
      contentType,
      schema: normalizeJsonSchema(mediaType.schema)
    };
  }

  return undefined;
}

function normalizeSecuritySchemes(doc: Record<string, unknown>): Record<string, NormalizedSecurityScheme> {
  const components = isRecord(doc.components) ? doc.components : {};
  const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  const normalized: Record<string, NormalizedSecurityScheme> = {};

  for (const [name, rawScheme] of Object.entries(securitySchemes)) {
    if (!isRecord(rawScheme) || typeof rawScheme.type !== "string") {
      continue;
    }

    if (rawScheme.type === "apiKey" && isSecuritySchemeLocation(rawScheme.in) && typeof rawScheme.name === "string") {
      normalized[name] = {
        type: "apiKey",
        in: rawScheme.in,
        name: rawScheme.name
      };
      continue;
    }

    if (rawScheme.type === "http" && typeof rawScheme.scheme === "string") {
      normalized[name] = {
        type: "http",
        scheme: rawScheme.scheme,
        ...(typeof rawScheme.bearerFormat === "string" ? { bearerFormat: rawScheme.bearerFormat } : {})
      };
      continue;
    }

    if (rawScheme.type === "oauth2" && isRecord(rawScheme.flows)) {
      const flows: Record<string, { tokenUrl?: string; scopes: Record<string, string> }> = {};
      for (const [flowName, rawFlow] of Object.entries(rawScheme.flows)) {
        if (!isRecord(rawFlow)) {
          continue;
        }
        flows[flowName] = {
          ...(typeof rawFlow.tokenUrl === "string" ? { tokenUrl: rawFlow.tokenUrl } : {}),
          scopes: isRecord(rawFlow.scopes) ? coerceStringRecord(rawFlow.scopes) : {}
        };
      }
      normalized[name] = { type: "oauth2", flows };
    }
  }

  return normalized;
}

function normalizeSecurityRequirements(value: unknown): SecurityRequirement[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const requirement: SecurityRequirement = {};
      for (const [schemeName, scopes] of Object.entries(entry)) {
        requirement[schemeName] = Array.isArray(scopes)
          ? scopes.filter((scope): scope is string => typeof scope === "string")
          : [];
      }
      return requirement;
    })
    .filter((entry): entry is SecurityRequirement => Boolean(entry));
}

function buildParams(endpoint: NormalizedEndpoint): { inputSchema: JsonSchema; parameterMap: ParameterMapping[] } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const parameterMap: ParameterMapping[] = [];
  const usedNames = new Set<string>();

  for (const parameter of endpoint.parameters.filter((entry) => entry.in === "path")) {
    const name = ensureUnique(parameter.name, usedNames);
    properties[name] = {
      ...parameter.schema,
      ...(parameter.description ? { description: parameter.description } : {})
    };
    required.push(name);
    parameterMap.push({
      toolParamName: name,
      source: "path",
      originalName: parameter.name,
      required: true
    });
  }

  for (const parameter of endpoint.parameters.filter((entry) => entry.in === "query")) {
    const name = ensureUnique(parameter.name, usedNames, "query");
    properties[name] = {
      ...parameter.schema,
      ...(parameter.description ? { description: parameter.description } : {})
    };
    if (parameter.required) {
      required.push(name);
    }
    parameterMap.push({
      toolParamName: name,
      source: "query",
      originalName: parameter.name,
      required: parameter.required
    });
  }

  const skippedHeaders = new Set(["content-type", "accept", "authorization"]);
  for (const parameter of endpoint.parameters.filter((entry) => entry.in === "header" && !skippedHeaders.has(entry.name.toLowerCase()))) {
    const name = ensureUnique(parameter.name, usedNames, "header");
    properties[name] = {
      ...parameter.schema,
      ...(parameter.description ? { description: parameter.description } : {})
    };
    if (parameter.required) {
      required.push(name);
    }
    parameterMap.push({
      toolParamName: name,
      source: "header",
      originalName: parameter.name,
      required: parameter.required
    });
  }

  if (endpoint.requestBody?.schema) {
    const bodySchema = endpoint.requestBody.schema;
    const bodyProperties = isRecord(bodySchema.properties) ? bodySchema.properties : {};
    if (Object.keys(bodyProperties).length > 0 && Object.keys(bodyProperties).length <= 15) {
      for (const [propertyName, propertySchema] of Object.entries(bodyProperties)) {
        const name = ensureUnique(propertyName, usedNames, "body");
        properties[name] = isRecord(propertySchema) ? propertySchema : { type: "string" };
        const isRequired = Array.isArray(bodySchema.required) && bodySchema.required.includes(propertyName);
        parameterMap.push({
          toolParamName: name,
          source: "body",
          originalName: propertyName,
          required: isRequired
        });
        if (endpoint.requestBody.required && isRequired) {
          required.push(name);
        }
      }
    } else {
      const name = ensureUnique("body", usedNames);
      properties[name] = {
        ...bodySchema,
        ...(endpoint.requestBody.description ? { description: endpoint.requestBody.description } : {})
      };
      if (endpoint.requestBody.required) {
        required.push(name);
      }
      parameterMap.push({
        toolParamName: name,
        source: "body",
        originalName: "body",
        required: endpoint.requestBody.required
      });
    }
  }

  return {
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {})
    },
    parameterMap
  };
}

function buildDescription(endpoint: NormalizedEndpoint): string {
  const parts: string[] = [];
  if (endpoint.summary) {
    parts.push(endpoint.summary);
  } else if (endpoint.description) {
    const firstSentence = endpoint.description.split(/\.\s/)[0] ?? endpoint.description;
    parts.push(firstSentence.length <= 200 ? firstSentence : firstSentence.slice(0, 200));
  }
  parts.push(`[${endpoint.method.toUpperCase()} ${endpoint.path}]`);
  if (endpoint.deprecated) {
    parts.push("(DEPRECATED)");
  }
  return parts.join(" ");
}

function generateToolName(operationId: string, _method: string, _path: string, prefix?: string): string {
  let name = sanitizeOperationId(operationId);
  if (prefix) {
    name = `${sanitize(prefix)}_${name}`;
  }
  return name.slice(0, MAX_TOOL_NAME_LENGTH);
}

function resolveCollisions(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) {
      return name;
    }
    return `${name}_${count + 1}`.slice(0, MAX_TOOL_NAME_LENGTH);
  });
}

function sanitizeOperationId(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function sanitize(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function ensureUnique(name: string, usedNames: Set<string>, prefixOnCollision?: string): string {
  let candidate = name;
  if (usedNames.has(candidate) && prefixOnCollision) {
    candidate = `${prefixOnCollision}_${name}`;
  }

  let suffix = 2;
  const base = candidate;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function matchPattern(value: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\//g, "\\/")}$`);
    return regex.test(value);
  }
  return value === pattern;
}

function generateFallbackOperationId(method: string, path: string): string {
  const normalizedPath = path
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${method}_${normalizedPath || "operation"}`;
}

function normalizeJsonSchema(schema: JsonSchema): JsonSchema {
  return normalizeNode(schema, new WeakMap<object, unknown>()) as JsonSchema;
}

function normalizeNode<T>(node: T, seen: WeakMap<object, unknown>): T {
  if (!isObject(node)) {
    return node;
  }

  if (seen.has(node)) {
    return seen.get(node) as T;
  }

  if (Array.isArray(node)) {
    const arrayValue: unknown[] = [];
    seen.set(node, arrayValue);
    for (const entry of node) {
      arrayValue.push(normalizeNode(entry, seen));
    }
    return arrayValue as T;
  }

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  seen.set(node, out);
  for (const [key, value] of Object.entries(source)) {
    if (key === "nullable") {
      continue;
    }
    out[key] = normalizeNode(value, seen);
  }

  if (source.nullable === true) {
    applyNullable(out);
  }

  return out as T;
}

function applyNullable(schema: Record<string, unknown>): void {
  const type = schema.type;
  if (typeof type === "string") {
    schema.type = type === "null" ? "null" : [type, "null"];
    return;
  }

  if (Array.isArray(type)) {
    if (!type.includes("null")) {
      schema.type = [...type, "null"];
    }
    return;
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf = appendNullVariant(schema.anyOf);
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    schema.oneOf = appendNullVariant(schema.oneOf);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    schema.anyOf = [{ allOf: schema.allOf }, { type: "null" }];
    delete schema.allOf;
    return;
  }

  schema.anyOf = [schemaWithoutCombiner(schema), { type: "null" }];
  clearSchemaForCombiner(schema);
}

function appendNullVariant(variants: unknown[]): unknown[] {
  const hasNull = variants.some((variant) => isRecord(variant) && variant.type === "null");
  return hasNull ? variants : [...variants, { type: "null" }];
}

function schemaWithoutCombiner(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  clearSchemaForCombiner(out);
  return out;
}

function clearSchemaForCombiner(schema: Record<string, unknown>): void {
  delete schema.anyOf;
  delete schema.oneOf;
  delete schema.allOf;
}

function coerceStringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

function isParameterLocation(value: unknown): value is NormalizedParameter["in"] {
  return value === "path" || value === "query" || value === "header" || value === "cookie";
}

function isSecuritySchemeLocation(value: unknown): value is "header" | "query" | "cookie" {
  return value === "header" || value === "query" || value === "cookie";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

import type { OperationModel, RuntimeOptions } from "./types.js";

export function isToolAllowed(operation: OperationModel, runtime: RuntimeOptions): boolean {
  if (runtime.allowedMethods.length > 0 && !runtime.allowedMethods.includes(operation.method.toUpperCase())) {
    return false;
  }

  if (runtime.allowedPathPrefixes.length > 0 && !runtime.allowedPathPrefixes.some((prefix) => operation.pathTemplate.startsWith(prefix))) {
    return false;
  }

  if (runtime.allowToolPatterns.length > 0 && !runtime.allowToolPatterns.some((pattern) => matchToolPattern(operation.operationId, pattern))) {
    return false;
  }

  if (runtime.denyToolPatterns.some((pattern) => matchToolPattern(operation.operationId, pattern))) {
    return false;
  }

  return true;
}

// `*` is the only wildcard; every other character matches literally.
export function matchToolPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(value);
}

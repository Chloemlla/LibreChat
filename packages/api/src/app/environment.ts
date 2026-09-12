import { z } from 'zod';
import { configSchema } from 'librechat-data-provider';

function unwrapSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapSchema(schema.removeDefault());
  }
  if (schema instanceof z.ZodCatch) {
    return unwrapSchema(schema.removeCatch());
  }
  if (schema instanceof z.ZodEffects) {
    return unwrapSchema(schema.innerType());
  }
  return schema;
}

/** Resolves YAML override names without consuming unrelated LIBRECHAT_* runtime settings. */
export function resolveConfigEnvPath(path: string): string[] | undefined {
  let schema: z.ZodType = configSchema;
  const resolved: string[] = [];

  for (const part of path.toLowerCase().split('_')) {
    if (!part || part === 'constructor' || part === 'prototype' || part === '__proto__') {
      return undefined;
    }
    const current = unwrapSchema(schema);
    if (current instanceof z.ZodRecord) {
      resolved.push(part);
      schema = current.valueSchema;
      continue;
    }
    if (!(current instanceof z.ZodObject)) {
      return undefined;
    }
    const key = Object.keys(current.shape).find((candidate) => candidate.toLowerCase() === part);
    if (!key) {
      return undefined;
    }
    resolved.push(key);
    schema = current.shape[key];
  }

  return resolved;
}

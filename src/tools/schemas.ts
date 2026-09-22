/**
 * FluxAgent — JSON-Schema subset for tool inputs (dependency-free).
 *
 * We support the subset needed for tool arguments: object/string/number/
 * boolean/array/enum/required. This is intentionally small — a full JSON
 * Schema library can be swapped in later behind the same functions.
 *
 * TODO(dependency): optionally adopt `ajv` later for full JSON Schema support.
 */

export interface JSONSchema {
  readonly type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly items?: JSONSchema;
  readonly enum?: readonly (string | number)[];
  readonly additionalProperties?: boolean;
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export type ValidationResult<T> = { valid: true; value: T } | { valid: false; issues: string[] };

/** Validate `value` against a schema; returns structured issues, not throws. */
export function validateAgainstSchema<T = Record<string, unknown>>(
  schema: JSONSchema,
  value: unknown,
): ValidationResult<T> {
  const issues: string[] = [];
  checkValue(schema, value, "$", issues);
  return { valid: issues.length === 0, value: value as T };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(sch: JSONSchema, v: unknown): boolean {
  switch (sch.type) {
    case "object": return typeOf(v) === "object";
    case "string": return typeOf(v) === "string";
    case "integer": return typeOf(v) === "integer";
    case "number": return typeOf(v) === "number" || typeOf(v) === "integer";
    case "boolean": return typeOf(v) === "boolean";
    case "array": return typeOf(v) === "array";
  }
}

function checkValue(sch: JSONSchema, v: unknown, path: string, issues: string[]): void {
  if (!typeMatches(sch, v)) {
    issues.push(`${path}: expected ${sch.type}, got ${typeOf(v)}`);
    return;
  }
  if (sch.enum && !sch.enum.includes(v as string | number)) {
    issues.push(`${path}: must be one of ${sch.enum.join(", ")}`);
  }
  if (typeof v === "string") {
    if (sch.minLength !== undefined && v.length < sch.minLength) {
      issues.push(`${path}: length ${v.length} < minLength ${sch.minLength}`);
    }
    if (sch.maxLength !== undefined && v.length > sch.maxLength) {
      issues.push(`${path}: length ${v.length} > maxLength ${sch.maxLength}`);
    }
  }
  if (typeof v === "number") {
    if (sch.minimum !== undefined && v < sch.minimum) issues.push(`${path}: ${v} < minimum ${sch.minimum}`);
    if (sch.maximum !== undefined && v > sch.maximum) issues.push(`${path}: ${v} > maximum ${sch.maximum}`);
  }
  if (sch.type === "object" && typeof v === "object" && v !== null && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const props = sch.properties ?? {};
    for (const key of sch.required ?? []) {
      if (!(key in obj)) issues.push(`${path}: missing required property "${key}"`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) checkValue(sub, obj[k], `${path}.${k}`, issues);
    }
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) issues.push(`${path}: unexpected property "${k}"`);
      }
    }
  }
  if (sch.type === "array" && Array.isArray(v) && sch.items) {
    v.forEach((item, i) => checkValue(sch.items as JSONSchema, item, `${path}[${i}]`, issues));
  }
}

/** Common arg-schema builders to keep tool definitions terse. */
export const S = {
  object: (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
    type: "object", properties, required, additionalProperties: false,
  }),
  string: (description: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({
    type: "string", description, ...extra,
  }),
  integer: (description: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({
    type: "integer", description, ...extra,
  }),
  number: (description: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({
    type: "number", description, ...extra,
  }),
  boolean: (description: string): JSONSchema => ({ type: "boolean", description }),
  array: (items: JSONSchema, description: string): JSONSchema => ({
    type: "array", items, description,
  }),
  enum: (values: readonly (string | number)[], description: string): JSONSchema => ({
    type: "string", description, enum: values,
  }),
} as const;

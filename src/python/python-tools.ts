/**
 * FluxAgent — Python bridge tools.
 *
 * Exposes `python.execute(module, fn, args)` to the agent through the tool
 * system. Vision/OCR/document capabilities stay behind the bridge so Python
 * remains optional at runtime.
 */

import { FluxError } from "../utils/errors.ts";
import { S, validateAgainstSchema } from "../tools/schemas.ts";
import { defineTool, type Tool, type ToolContext } from "../tools/tool.ts";
import type { PythonBridge } from "./bridge.ts";

const PYTHON_EXECUTE_SCHEMA = S.object(
  {
    module: S.string("Python worker module: vision | ocr | embeddings | documents | system"),
    function: S.string("Function name inside the module"),
    args: {
      type: "object",
      description: "Arguments passed to the Python function",
      additionalProperties: true,
    },
  },
  ["module", "function"],
);

export function createPythonExecuteTool(bridge: PythonBridge): Tool<{
  module: string;
  function: string;
  args?: Record<string, unknown>;
}> {
  return defineTool({
    metadata: {
      name: "python.execute",
      description:
        "Run a function inside the Python worker (vision, ocr, embeddings, documents, system) and return its JSON result.",
      inputSchema: PYTHON_EXECUTE_SCHEMA,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["python", "bridge"],
    },
    validate(args: unknown): asserts args is { module: string; function: string; args?: Record<string, unknown> } {
      const res = validateAgainstSchema(PYTHON_EXECUTE_SCHEMA, args);
      if (!res.valid) throw new Error(res.issues.join("; "));
    },
    async execute(args, ctx: ToolContext) {
      const result = await bridge.execute(args.module, args.function, args.args ?? {}, {
        signal: ctx.signal,
      });
      return result;
    },
  });
}

/** Tool that just checks which python modules/functions the worker exposes. */
export function createPythonCapabilitiesTool(bridge: PythonBridge): Tool<Record<string, never>> {
  return defineTool({
    metadata: {
      name: "python.capabilities",
      description: "List modules/functions available in the Python worker (no execution).",
      inputSchema: S.object({}),
      permissionLevel: "READ_ONLY",
      tags: ["python", "bridge"],
    },
    validate(_args: unknown): asserts _args is Record<string, never> {},
    async execute() {
      const result = (await bridge.execute("system", "info", {})) as Record<string, unknown>;
      return {
        workerAlive: true,
        system: result,
        note: "vision/ocr/documents need optional packages (Pillow, pytesseract, PyMuPDF) — not installed by design yet",
      };
    },
  });
}


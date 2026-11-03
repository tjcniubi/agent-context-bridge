import { readFile } from "node:fs/promises";
import { AgentWorkBundleSchema } from "./schema.js";
import type { AgentWorkBundle } from "./types.js";

export interface ValidateResult {
  ok: boolean;
  bundle?: AgentWorkBundle;
  errors: string[];
}

export function validateBundle(data: unknown): ValidateResult {
  const parsed = AgentWorkBundleSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  return { ok: true, bundle: parsed.data as AgentWorkBundle, errors: [] };
}

export async function validateBundleFile(path: string): Promise<ValidateResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      errors: [`Failed to read ${path}: ${(err as Error).message}`],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`Invalid JSON in ${path}: ${(err as Error).message}`],
    };
  }
  return validateBundle(data);
}

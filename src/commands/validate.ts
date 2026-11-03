import { validateBundleFile } from "../protocol/validate.js";

export async function runValidate(file: string): Promise<number> {
  const result = await validateBundleFile(file);
  if (result.ok) {
    const m = result.bundle!.manifest;
    console.log(`OK  ${file}`);
    console.log(`    version=${m.version} source=${m.source_agent} created_at=${m.created_at}`);
    console.log(`    loss_report entries: ${m.loss_report.length}`);
    return 0;
  }
  console.error(`FAIL  ${file}`);
  for (const e of result.errors) console.error(`  - ${e}`);
  return 1;
}

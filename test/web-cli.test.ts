import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequestListener } from "../src/web/server.js";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = createServer(createRequestListener());
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
    });
  }
}

async function json(
  port: number,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

test("CLI validate and web help still work", async () => {
  const validate = await exec(
    process.execPath,
    [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts", "validate", "examples/sample.bundle.json"],
    { cwd: root },
  );
  assert.match(validate.stdout, /OK\s+examples\/sample\.bundle\.json/);

  const help = await exec(
    process.execPath,
    [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts", "--help"],
    { cwd: root },
  );
  assert.match(help.stdout, /\bweb\b/);
  assert.match(help.stdout, /\bexport\b/);
  assert.match(help.stdout, /\bconvert\b/);
});

test("HTTP export, repair confirm gate, and dry-run import", async () => {
  const project = await mkdtemp(join(tmpdir(), "acb-web-"));
  const target = await mkdtemp(join(tmpdir(), "acb-web-to-"));
  await writeFile(join(project, "AGENTS.md"), "# Demo\n\nKeep the goal.\n", "utf8");
  try {
    await withServer(async (port) => {
      const health = await json(port, "/api/health");
      assert.equal(health.status, 200);
      assert.equal((health.data as { ok: boolean }).ok, true);

      const missing = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(missing.status, 503);

      const unknown = await json(port, "/api/export", {
        method: "POST",
        body: { agent: "nope", project },
      });
      assert.equal(unknown.status, 400);

      const converted = await json(port, "/api/convert", {
        method: "POST",
        body: { from: "cursor", to: "trae", project, dryRun: true },
      });
      assert.equal(converted.status, 200);
      assert.equal(converted.data.dryRun, true);
      assert.ok(Array.isArray(converted.data.losses) && (converted.data.losses as unknown[]).length > 0);

      const exported = await json(port, "/api/export", {
        method: "POST",
        body: { agent: "cursor", project },
      });
      assert.equal(exported.status, 200);
      const bundle = exported.data.bundle as {
        work_state: { goal?: string; known_pitfalls: string[] };
        manifest: { loss_report: { code: string }[] };
      };
      assert.equal(bundle.work_state.goal, undefined);
      assert.ok(bundle.manifest.loss_report.some((entry) => entry.code === "work_state.not_inferred"));

      const started = await json(port, "/api/repair/start", {
        method: "POST",
        body: { bundle },
      });
      assert.equal(started.status, 200);
      const sessionId = started.data.id as string;
      assert.equal(
        (started.data.bundle as { work_state: { known_pitfalls: string[] } }).work_state.known_pitfalls.length,
        0,
      );

      const drafted = await json(port, `/api/repair/${sessionId}/answer`, {
        method: "POST",
        body: { text: "坑：确认前不能写入" },
      });
      assert.equal(drafted.status, 200);
      const draftedState = drafted.data.bundle as { work_state: { known_pitfalls: string[] } };
      assert.deepEqual(draftedState.work_state.known_pitfalls, []);
      const proposalId = (drafted.data.currentProposalId as string) ?? "";
      assert.ok(proposalId);

      const noise = await json(port, `/api/repair/${sessionId}/answer`, {
        method: "POST",
        body: { text: "我觉得可以了" },
      });
      assert.equal(noise.status, 200);
      assert.deepEqual(
        (noise.data.bundle as { work_state: { known_pitfalls: string[] } }).work_state.known_pitfalls,
        [],
      );

      const confirmed = await json(port, `/api/repair/${sessionId}/confirm`, {
        method: "POST",
        body: { ids: [proposalId] },
      });
      assert.equal(confirmed.status, 200);
      assert.deepEqual(
        (confirmed.data.bundle as { work_state: { known_pitfalls: string[] } }).work_state.known_pitfalls,
        ["确认前不能写入"],
      );

      const again = await json(port, `/api/repair/${sessionId}/confirm`, {
        method: "POST",
        body: { ids: [proposalId] },
      });
      assert.equal(again.status, 409);

      const imported = await json(port, "/api/import", {
        method: "POST",
        body: {
          agent: "trae",
          project: target,
          bundle: confirmed.data.bundle,
          dryRun: true,
        },
      });
      assert.equal(imported.status, 200);
      assert.equal(imported.data.dryRun, true);
      const written = imported.data.written as string[];
      assert.ok(written.includes(".acb/WORK_STATE.md"));
      await assert.rejects(readFile(join(target, ".acb/WORK_STATE.md"), "utf8"));

      const saved = await json(port, "/api/work-state/write", {
        method: "POST",
        body: { project: target, bundle: confirmed.data.bundle },
      });
      assert.equal(saved.status, 200);
      const markdown = await readFile(join(target, ".acb/WORK_STATE.md"), "utf8");
      assert.match(markdown, /确认前不能写入/);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

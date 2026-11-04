import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { exportProject } from "../src/core/operations.js";
import { createRequestListener } from "../src/web/server.js";
import { cursorProjectSlugs } from "../src/transcript/collect.js";
import { parseTranscriptJsonl } from "../src/transcript/parse.js";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("JSONL parser keeps text, drops image bytes, and truncates tool output", () => {
  const image = "A".repeat(80);
  const toolBody = "T".repeat(4000);
  const raw = [
    JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello nested" }] } }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "I will read" },
          { type: "tool_use", name: "read_file", input: { path: "a.ts" } },
          { type: "image", source: { type: "base64", data: image } },
        ],
      },
    }),
    JSON.stringify({ role: "tool", content: toolBody }),
    JSON.stringify({ type: "turn_ended" }),
    "{not-json",
  ].join("\n");
  const parsed = parseTranscriptJsonl(raw, { maxBytes: 100_000, maxMessages: 20 });
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.metadataLines, 1);
  assert.equal(parsed.badLines, 1);
  assert.equal(parsed.messages[0]?.content, "hello nested");
  assert.equal(parsed.messages[1]?.tool_calls?.[0]?.name, "read_file");
  assert.ok(parsed.messages[1]?.dropped_fields?.some((field) => field.includes("result")));
  assert.equal(parsed.messages[1]?.attachments?.[0]?.omitted, true);
  assert.ok((parsed.messages[2]?.content.length ?? 0) < toolBody.length);
  assert.ok(parsed.messages[2]?.dropped_fields?.includes("content.truncated"));
  assert.doesNotMatch(JSON.stringify(parsed.messages), new RegExp(image));
});

test("Cursor JSONL export is lossy and Trae never reads the encrypted database", async () => {
  const project = await tempDir("acb-tx-");
  const home = await tempDir("acb-tx-home-");
  try {
    const slug = cursorProjectSlugs(project)[0];
    const sessionDir = join(home, ".cursor", "projects", slug, "agent-transcripts", "sess-new");
    const olderDir = join(home, ".cursor", "projects", slug, "agent-transcripts", "sess-old");
    await mkdir(join(sessionDir, "subagents"), { recursive: true });
    await mkdir(olderDir, { recursive: true });
    const main = join(sessionDir, "sess-new.jsonl");
    await writeFile(
      main,
      `${JSON.stringify({ role: "user", content: "ship the bridge" })}\n${JSON.stringify({ role: "assistant", content: "on it" })}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionDir, "subagents", "worker.jsonl"),
      `${JSON.stringify({ role: "assistant", content: "subagent note" })}\n`,
      "utf8",
    );
    await writeFile(
      join(olderDir, "sess-old.jsonl"),
      `${JSON.stringify({ role: "user", content: "old session" })}\n`,
      "utf8",
    );
    const older = new Date(Date.now() - 60_000);
    await utimes(join(olderDir, "sess-old.jsonl"), older, older);

    const exported = await exportProject({
      agent: "cursor",
      project,
      includeTranscript: true,
      userHome: home,
      transcriptMaxMessages: 10,
    });
    assert.equal(exported.bundle.transcript?.source_session_id, "sess-new");
    assert.ok(exported.bundle.transcript?.messages.some((message) => message.content === "ship the bridge"));
    assert.ok(exported.bundle.transcript?.messages.some((message) => message.content.includes("subagent")));
    assert.ok(exported.losses.some((entry) => entry.code === "transcript.session_selected"));
    assert.ok(!exported.bundle.transcript?.messages.some((message) => message.content === "old session"));

    const capped = await exportProject({
      agent: "cursor",
      project,
      includeTranscript: true,
      sessionId: "sess-new",
      userHome: home,
      transcriptMaxMessages: 1,
    });
    assert.equal(capped.bundle.transcript?.messages.length, 1);
    assert.ok(capped.losses.some((entry) => entry.code === "transcript.truncated"));

    await mkdir(join(project, "ModularData", "ai-agent"), { recursive: true });
    await writeFile(join(project, "ModularData", "ai-agent", "database.db"), "SECRET_CHAT_DB", "utf8");
    await mkdir(join(project, ".acb", "imports"), { recursive: true });
    await writeFile(
      join(project, ".acb", "imports", "transcript.md"),
      "User: 你好\nAssistant: 记住这个决定\n",
      "utf8",
    );
    const trae = await exportProject({
      agent: "trae",
      project,
      includeTranscript: true,
      userHome: home,
    });
    const traeBody = JSON.stringify(trae.bundle);
    assert.match(traeBody, /你好/);
    assert.match(traeBody, /记住这个决定/);
    assert.doesNotMatch(traeBody, /SECRET_CHAT_DB/);
    assert.ok(trae.losses.some((entry) => entry.code === "transcript.trae_encrypted" && entry.severity === "info"));

    const refused = await exportProject({
      agent: "trae",
      project,
      includeTranscript: true,
      sessionId: join(project, "ModularData", "ai-agent", "database.db"),
      userHome: home,
    });
    assert.equal(refused.bundle.transcript, undefined);
    assert.doesNotMatch(JSON.stringify(refused.bundle), /SECRET_CHAT_DB/);
    assert.ok(refused.losses.some((entry) => entry.code === "transcript.trae_encrypted" && entry.severity === "error"));
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("transcript apply requires confirm and the CLI can preview", async () => {
  const project = await tempDir("acb-apply-");
  const bundle = {
    manifest: {
      version: "0.1",
      source_agent: "cursor",
      created_at: "2026-11-04T00:00:00.000Z",
      loss_report: [],
    },
    repo_context: { rules: [], skills: [], mcp_servers: [], instructions_files: [] },
    work_state: { decisions: [], open_loops: [], file_anchors: [], constraints: [], known_pitfalls: [] },
    transcript: {
      messages: [{ role: "user", content: "keep this sentence", dropped_fields: ["tool_calls.note.result"] }],
      source_session_id: "sess",
      notes: "lossy",
    },
  };
  const server = createServer(createRequestListener());
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/transcript/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, bundle, confirm: false }),
    });
    assert.equal(denied.status, 400);
    await assert.rejects(readFile(join(project, ".acb", "TRANSCRIPT.md"), "utf8"));

    const preview = await fetch(`http://127.0.0.1:${port}/api/transcript/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, bundle, confirm: true, dryRun: true }),
    });
    assert.equal(preview.status, 200);
    await assert.rejects(readFile(join(project, ".acb", "TRANSCRIPT.md"), "utf8"));

    const applied = await fetch(`http://127.0.0.1:${port}/api/transcript/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, bundle, confirm: true }),
    });
    assert.equal(applied.status, 200);
    const markdown = await readFile(join(project, ".acb", "TRANSCRIPT.md"), "utf8");
    assert.match(markdown, /keep this sentence/);
    assert.match(markdown, /不会写入聊天界面/);

    const file = join(project, "bundle.json");
    await writeFile(file, JSON.stringify(bundle), "utf8");
    const cli = await exec(
      process.execPath,
      [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts", "transcript", "import", "-p", project, "-f", file],
      { cwd: root },
    );
    assert.match(cli.stdout, /keep this sentence/);
    assert.match(cli.stdout, /--apply/);
    const help = await exec(
      process.execPath,
      [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts", "transcript", "--help"],
      { cwd: root },
    );
    assert.match(help.stdout, /export/);
    assert.match(help.stdout, /import/);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((err) => (err ? reject(err) : resolveClose())));
    await rm(project, { recursive: true, force: true });
  }
});

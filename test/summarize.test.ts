import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequestListener } from "../src/web/server.js";
import { extractWorkState } from "../src/summarize/extract.js";
import { cursorProjectSlug } from "../src/summarize/sessions.js";
import {
  applyWorkState,
  mergeSummary,
  summarizeSessions,
} from "../src/summarize/run.js";
import { emptyRepoContext, emptyWorkState } from "../src/protocol/types.js";
import type { AgentWorkBundle } from "../src/protocol/types.js";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NOTES = `## 目标
Ship the summarize command.

## 决策
- 用启发式而不是调用外部模型 — 离线可测
- 不解密本地聊天库

## 开放环
- [open] 补 Web 确认流 (high)

## 文件锚点
- \`src/summarize/run.ts\`: 入口

## 约束
- 不宣称完整恢复对话

## 已知坑
- slug 映射不稳定

## 摘要
这是手写摘要。
`;

test("structured notes fill every Work State field", () => {
  const extracted = extractWorkState({ messages: [], notes: [NOTES] });
  assert.equal(extracted.workState.goal, "Ship the summarize command.");
  assert.equal(extracted.workState.decisions[0]?.summary, "用启发式而不是调用外部模型");
  assert.equal(extracted.workState.decisions[0]?.rationale, "离线可测");
  assert.equal(extracted.workState.decisions[1]?.summary, "不解密本地聊天库");
  assert.equal(extracted.workState.open_loops[0]?.summary, "补 Web 确认流");
  assert.equal(extracted.workState.open_loops[0]?.status, "open");
  assert.equal(extracted.workState.open_loops[0]?.priority, "high");
  assert.equal(extracted.workState.file_anchors[0]?.path, "src/summarize/run.ts");
  assert.equal(extracted.workState.file_anchors[0]?.note, "入口");
  assert.deepEqual(extracted.workState.constraints, ["不宣称完整恢复对话"]);
  assert.deepEqual(extracted.workState.known_pitfalls, ["slug 映射不稳定"]);
  assert.equal(extracted.workState.last_summary, "这是手写摘要。");
  assert.equal(extracted.summaryMode, "structured");
});

test("cursor jsonl is lossy: text is kept, tool payloads and bad lines are not", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-sum-"));
  const project = join(home, "demo");
  const cursorHome = join(home, "cursor");
  await mkdir(project, { recursive: true });
  const slug = cursorProjectSlug(project);
  const session = "sess-1";
  const sessionDir = join(cursorHome, "projects", slug, "agent-transcripts", session);
  await mkdir(join(sessionDir, "subagents"), { recursive: true });
  const user = [
    "Implement the billing export.",
    "Decision: use a neutral JSON bundle — avoids pairwise adapters.",
    "Constraint: do not claim lossless transcript migration.",
    "TODO: confirm Trae export path (high)",
    "Known pitfall: Cursor ignores plain .md under .cursor/rules",
  ].join("\n");
  const lines = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: user }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "I will edit `src/adapters/cursor.ts` and `docs/protocol.md`." },
          { type: "tool_use", name: "Read", input: { path: "SECRET_PATH/only-in-tool.ts" } },
        ],
      },
    }),
    JSON.stringify({ role: "tool", content: "SECRET_TOOL_OUTPUT" }),
    "not json",
  ];
  await writeFile(join(sessionDir, `${session}.jsonl`), lines.join("\n"), "utf8");
  await writeFile(join(sessionDir, "subagents", "child.jsonl"), "SUB_SECRET goal override\n", "utf8");
  await mkdir(join(cursorHome, "projects", "zzz-demo", "agent-transcripts", "other"), { recursive: true });
  await writeFile(
    join(cursorHome, "projects", "zzz-demo", "agent-transcripts", "other", "other.jsonl"),
    JSON.stringify({ role: "user", content: "OTHER_SECRET should not be read" }),
    "utf8",
  );

  try {
    const result = await summarizeSessions({
      projectRoot: project,
      agent: "cursor",
      cursorHome,
      homeDir: home,
    });
    const merged = mergeSummary(undefined, result);
    const packed = JSON.stringify({ result, merged });
    assert.equal(merged.goal, "Implement the billing export.");
    assert.equal(merged.decisions[0]?.summary, "use a neutral JSON bundle");
    assert.equal(merged.decisions[0]?.rationale, "avoids pairwise adapters.");
    assert.equal(merged.open_loops[0]?.summary, "confirm Trae export path");
    assert.equal(merged.open_loops[0]?.priority, "high");
    assert.deepEqual(merged.constraints, ["do not claim lossless transcript migration."]);
    assert.deepEqual(merged.known_pitfalls, ["Cursor ignores plain .md under .cursor/rules"]);
    assert.deepEqual(
      merged.file_anchors.map((anchor) => anchor.path),
      ["src/adapters/cursor.ts", "docs/protocol.md"],
    );
    assert.match(merged.last_summary ?? "", /lossy extract/);
    assert.equal(packed.includes("SECRET_TOOL_OUTPUT"), false);
    assert.equal(packed.includes("SECRET_PATH/only-in-tool.ts"), false);
    assert.equal(packed.includes("SUB_SECRET"), false);
    assert.equal(packed.includes("OTHER_SECRET"), false);
    assert.ok(result.losses.some((entry) => entry.code === "summarize.jsonl.skipped_lines"));
    assert.ok(result.losses.some((entry) => entry.code === "summarize.tool_results_dropped"));
    assert.ok(result.losses.some((entry) => entry.code === "cursor.session.subagents_skipped"));
    assert.ok(result.losses.some((entry) => entry.code === "cursor.session.used"));
    assert.ok(result.losses.some((entry) => entry.code === "summarize.transcript_not_copied"));
    assert.equal(result.losses.some((entry) => entry.code === "transcript.trae_encrypted"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("structured notes override session text for the same fields", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-notes-"));
  try {
    const result = await summarizeSessions({
      projectRoot: home,
      agent: "cursor",
      cursorHome: join(home, "missing-cursor"),
      homeDir: home,
      notesText: NOTES,
      transcriptTexts: [
        {
          name: "chat.jsonl",
          text: JSON.stringify({ role: "user", content: "Decision: ignore the notes\nReplace the goal" }),
        },
      ],
    });
    assert.equal(result.workState.goal, "Ship the summarize command.");
    assert.equal(result.workState.decisions.some((decision) => decision.summary.includes("ignore the notes")), false);
    assert.equal(result.summaryMode, "structured");
    assert.equal(result.workState.last_summary, "这是手写摘要。");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ambiguous Cursor project folders are not read", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-amb-"));
  const project = join(home, "demo");
  const cursorHome = join(home, "cursor");
  await mkdir(project, { recursive: true });
  for (const name of ["aaa-demo", "bbb-demo"]) {
    const dir = join(cursorHome, "projects", name, "agent-transcripts", "s");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "s.jsonl"),
      JSON.stringify({ role: "user", content: `UNIQUE_${name}` }),
      "utf8",
    );
  }
  try {
    const result = await summarizeSessions({
      projectRoot: project,
      agent: "cursor",
      cursorHome,
      homeDir: home,
    });
    const packed = JSON.stringify(result);
    assert.equal(packed.includes("UNIQUE_aaa-demo"), false);
    assert.equal(packed.includes("UNIQUE_bbb-demo"), false);
    assert.ok(result.losses.some((entry) => entry.code === "cursor.session.ambiguous_project"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an oversized Cursor transcript is skipped", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-big-"));
  const project = join(home, "app");
  const cursorHome = join(home, "cursor");
  await mkdir(project, { recursive: true });
  const slug = cursorProjectSlug(project);
  const dir = join(cursorHome, "projects", slug, "agent-transcripts", "big");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "big.jsonl"),
    JSON.stringify({ role: "user", content: "BIG_TOKEN ".repeat(20) }),
    "utf8",
  );
  try {
    const result = await summarizeSessions({
      projectRoot: project,
      agent: "cursor",
      cursorHome,
      homeDir: home,
      maxFileBytes: 40,
    });
    assert.equal(JSON.stringify(result).includes("BIG_TOKEN"), false);
    assert.ok(result.losses.some((entry) => entry.code === "cursor.session.too_large"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Trae chat database is reported and not parsed", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-trae-"));
  const db = join(home, "Library/Application Support/Trae CN/ModularData/ai-agent/database.db");
  await mkdir(dirname(db), { recursive: true });
  await writeFile(db, "SECRET_CHAT_SHOULD_NOT_APPEAR", "utf8");
  try {
    const result = await summarizeSessions({
      projectRoot: home,
      agent: "trae",
      homeDir: home,
      cursorHome: join(home, "cursor"),
    });
    assert.equal(JSON.stringify(result).includes("SECRET_CHAT_SHOULD_NOT_APPEAR"), false);
    assert.ok(result.losses.some((entry) => entry.code === "transcript.trae_encrypted" && entry.path === db));
    assert.equal(result.workState.decisions.length, 0);
    assert.equal(result.sourceAgent, "trae");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("merge keeps existing fields and drops the empty-export loss once a summary exists", () => {
  const existing: AgentWorkBundle = {
    manifest: {
      version: "0.1",
      source_agent: "cursor",
      created_at: "2026-11-03T00:00:00.000Z",
      loss_report: [
        { code: "work_state.not_inferred", message: "empty", severity: "info" },
        { code: "cursor.rules.md_ignored", message: "kept", severity: "info" },
      ],
    },
    repo_context: {
      ...emptyRepoContext(),
      rules: [{ name: "typescript.mdc", content: "keep me" }],
    },
    work_state: { ...emptyWorkState(), decisions: [{ summary: "keep-decision" }] },
  };
  return summarizeSessions({
    projectRoot: "/tmp/acb-merge-unused",
    agent: "cursor",
    cursorHome: "/tmp/acb-merge-unused-cursor",
    homeDir: "/tmp/acb-merge-unused-home",
    notesText: "## 目标\nNew goal\n",
  }).then((result) => {
    const workState = mergeSummary(existing.work_state, result);
    assert.equal(workState.goal, "New goal");
    assert.equal(workState.decisions[0]?.summary, "keep-decision");
    assert.match(workState.last_summary ?? "", /New goal/);
    assert.match(workState.last_summary ?? "", /keep-decision/);
    const bundle = applyWorkState({
      existing,
      workState,
      summaryLosses: result.losses,
      confirmed: true,
    });
    assert.equal(bundle.repo_context.rules[0]?.content, "keep me");
    assert.equal(bundle.manifest.source_agent, "cursor");
    assert.equal(bundle.manifest.created_at, existing.manifest.created_at);
    assert.equal(bundle.manifest.loss_report.some((entry) => entry.code === "work_state.not_inferred"), false);
    assert.ok(bundle.manifest.loss_report.some((entry) => entry.code === "cursor.rules.md_ignored"));
    assert.ok(bundle.manifest.loss_report.some((entry) => entry.code === "summarize.confirmed"));
  });
});

test("CLI dry-run does not write, and -o writes a valid bundle", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-cli-"));
  const notes = join(home, "notes.md");
  const out = join(home, "out.bundle.json");
  await writeFile(notes, "## 目标\nCLI goal\n", "utf8");
  const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
  try {
    const preview = await exec(process.execPath, [
      tsx,
      "src/index.ts",
      "summarize",
      "--notes",
      notes,
      "--agent",
      "cursor",
      "--cursor-home",
      join(home, "cursor"),
      "--home",
      home,
      "--dry-run",
      "-o",
      out,
    ], { cwd: root });
    assert.match(preview.stdout, /CLI goal/);
    await assert.rejects(readFile(out, "utf8"));

    const help = await exec(process.execPath, [tsx, "src/index.ts", "--help"], { cwd: root });
    assert.match(help.stdout, /\bsummarize\b/);

    const written = await exec(process.execPath, [
      tsx,
      "src/index.ts",
      "summarize",
      "--notes",
      notes,
      "--agent",
      "cursor",
      "--cursor-home",
      join(home, "cursor"),
      "--home",
      home,
      "-o",
      out,
      "--stdout",
    ], { cwd: root });
    const bundle = JSON.parse(written.stdout) as AgentWorkBundle;
    assert.equal(bundle.work_state.goal, "CLI goal");
    assert.ok(bundle.manifest.loss_report.some((entry) => entry.code === "summarize.written"));
    const saved = JSON.parse(await readFile(out, "utf8")) as AgentWorkBundle;
    assert.equal(saved.work_state.goal, "CLI goal");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

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

test("web preview does not write, and apply stores the edited Work State", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-http-"));
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  const bundle: AgentWorkBundle = {
    manifest: {
      version: "0.1",
      source_agent: "cursor",
      created_at: "2026-11-03T00:00:00.000Z",
      loss_report: [{ code: "work_state.not_inferred", message: "empty", severity: "info" }],
    },
    repo_context: { ...emptyRepoContext(), rules: [{ name: "keep.mdc", content: "rule" }] },
    work_state: { ...emptyWorkState(), decisions: [{ summary: "keep-decision" }] },
  };
  try {
    await withServer(async (port) => {
      const previewRes = await fetch(`http://127.0.0.1:${port}/api/summarize/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          agent: "cursor",
          cursorHome: join(home, "cursor"),
          home,
          notesText: "## 目标\nFrom notes\n",
          bundle,
        }),
      });
      assert.equal(previewRes.status, 200);
      const preview = (await previewRes.json()) as {
        applied: boolean;
        workState: { goal?: string; decisions: { summary: string }[]; last_summary?: string };
        losses: { code: string }[];
      };
      assert.equal(preview.applied, false);
      assert.equal(preview.workState.goal, "From notes");
      assert.equal(preview.workState.decisions[0]?.summary, "keep-decision");
      await assert.rejects(readFile(join(project, ".acb/WORK_STATE.md"), "utf8"));

      const applyRes = await fetch(`http://127.0.0.1:${port}/api/summarize/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          bundle,
          sourceAgent: "cursor",
          losses: preview.losses,
          workState: { ...preview.workState, goal: "Edited goal" },
        }),
      });
      assert.equal(applyRes.status, 200);
      const applied = (await applyRes.json()) as {
        applied: boolean;
        bundle: AgentWorkBundle;
      };
      assert.equal(applied.applied, true);
      assert.equal(applied.bundle.work_state.goal, "Edited goal");
      assert.equal(applied.bundle.work_state.decisions[0]?.summary, "keep-decision");
      assert.equal(applied.bundle.repo_context.rules[0]?.content, "rule");
      assert.ok(applied.bundle.manifest.loss_report.some((entry) => entry.code === "summarize.confirmed"));
      assert.equal(
        applied.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.not_inferred"),
        false,
      );
      await assert.rejects(readFile(join(project, ".acb/WORK_STATE.md"), "utf8"));
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

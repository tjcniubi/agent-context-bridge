import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequestListener } from "../src/web/server.js";
import { redactSecrets, type FetchLike } from "../src/summarize/model.js";
import { summarizeSessions } from "../src/summarize/run.js";
import {
  answerWithModel,
  confirmProposals,
  draftAnswersWithModel,
  rejectProposals,
  startRepair,
} from "../src/repair/guide.js";
import { emptyRepoContext, emptyWorkState, type AgentWorkBundle, type LossReportEntry } from "../src/protocol/types.js";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-SECRETKEY123456";
const FILE_KEY = "file-key-SECRETFILE987654";

const MODEL_WORK = {
  goal: "MODEL_ONLY_GOAL_9f3a",
  decisions: [{ summary: "Use a neutral bundle", rationale: "one format" }],
  open_loops: [{ summary: "Cover the confirm gate", priority: "high", status: "open" }],
  file_anchors: [{ path: "src/summarize/model.ts", note: "client" }],
  constraints: ["Do not write before confirm"],
  known_pitfalls: ["Do not log the API key"],
  last_summary: "Model summary. Not a transcript.",
};

test("redactSecrets hides the configured key and common token shapes", () => {
  const raw = `key=${KEY} sk-live-abcdef123456 Bearer abcdefghijk api_key="abc123" ?token=zzz`;
  const safe = redactSecrets(raw, [KEY]);
  assert.equal(safe.includes(KEY), false);
  assert.equal(safe.includes("sk-live-abcdef123456"), false);
  assert.equal(safe.includes("abcdefghijk"), false);
  assert.equal(safe.includes("abc123"), false);
  assert.equal(safe.includes("zzz"), false);
  assert.match(safe, /\[REDACTED\]/);
});

test("the example model config has no secret", async () => {
  const raw = await readFile(join(root, "examples/model.example.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.model, "gpt-4o-mini");
  assert.equal(typeof parsed.baseUrl, "string");
  assert.equal("apiKey" in parsed, false);
  assert.equal("api_key" in parsed, false);
  assert.equal(/sk-|secret|Bearer/i.test(raw), false);
});

test("model off ignores env and does not call fetch", async () => {
  let called = 0;
  const fetchImpl: FetchLike = async () => {
    called += 1;
    throw new Error("fetch should not run");
  };
  const result = await summarizeSessions(baseOpts({
    model: {
      enabled: false,
      env: { ACB_MODEL: "should-not-run", ACB_MODEL_API_KEY: KEY, ACB_MODEL_BASE_URL: "http://127.0.0.1:9/v1" },
      fetchImpl,
    },
    notesText: "## 目标\nRule goal\n",
  }));
  assert.equal(called, 0);
  assert.equal(result.workState.goal, "Rule goal");
  assert.equal(result.losses.some((entry) => entry.code.startsWith("work_state.model_")), false);
  assert.ok(result.losses.some((entry) => entry.code === "summarize.notes_structured"));
});

test("missing API key falls back to rules and does not call the network", async () => {
  let called = 0;
  const fetchImpl: FetchLike = async () => {
    called += 1;
    throw new Error("fetch should not run");
  };
  const result = await summarizeSessions(baseOpts({
    model: {
      enabled: true,
      env: { ACB_MODEL: "demo-model" },
      fetchImpl,
    },
    notesText: "## 目标\nRule goal\n",
  }));
  assert.equal(called, 0);
  assert.equal(result.workState.goal, "Rule goal");
  const failed = result.losses.find((entry) => entry.code === "work_state.model_failed");
  assert.ok(failed);
  assert.match(failed.message, /API key is not set/);
  assert.match(failed.message, /Fell back to the rule-based extract/);
  assert.equal(result.losses.some((entry) => entry.code === "work_state.model_drafted"), false);
  assert.ok(result.losses.some((entry) => entry.code === "summarize.notes_structured"));
});

test("a mocked model draft replaces the rule extract and redacts secrets", async () => {
  const seen: { url: string; auth: string; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization") ?? "", body: String(init?.body ?? "") });
    const request = JSON.parse(String(init?.body)) as { response_format?: unknown; model?: string };
    assert.equal(request.model, "demo-model");
    assert.ok(request.response_format);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(MODEL_WORK) } }] });
  };
  const result = await summarizeSessions(baseOpts({
    model: {
      enabled: true,
      model: "demo-model",
      baseUrl: "http://127.0.0.1:9/v1",
      env: { ACB_MODEL_API_KEY: KEY },
      fetchImpl,
    },
    notesText: `## 目标\nRule goal ${KEY}\n`,
    transcriptTexts: [{
      name: "chat.jsonl",
      text: [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Session line" }] } }),
        JSON.stringify({ role: "tool", content: "SECRET_TOOL_OUTPUT" }),
      ].join("\n"),
    }],
  }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.auth, `Bearer ${KEY}`);
  assert.match(seen[0]?.url ?? "", /\/v1\/chat\/completions$/);
  assert.equal(seen[0]?.body.includes(KEY), false);
  assert.equal(seen[0]?.body.includes("SECRET_TOOL_OUTPUT"), false);
  assert.match(seen[0]?.body ?? "", /Session line/);
  assert.equal(result.workState.goal, "MODEL_ONLY_GOAL_9f3a");
  assert.equal(result.workState.last_summary, "Model summary. Not a transcript.");
  assert.equal(result.summaryMode, "structured");
  assert.equal(result.losses.some((entry) => entry.code === "summarize.heuristic"), false);
  assert.equal(result.losses.some((entry) => entry.code === "summarize.notes_structured"), false);
  assert.ok(result.losses.some((entry) => entry.code === "work_state.model_drafted"));
  assert.ok(result.losses.some((entry) => entry.code === "summarize.transcript_not_copied"));
  assert.ok(result.losses.some((entry) => entry.code === "summarize.tool_results_dropped"));
  const packed = JSON.stringify(result);
  assert.equal(packed.includes(KEY), false);
  assert.equal(packed.includes("SECRET_TOOL_OUTPUT"), false);
  assert.match(result.losses.find((entry) => entry.code === "work_state.model_drafted")?.message ?? "", /\[REDACTED\]/);
});

test("model HTTP failure, empty JSON, and invalid JSON fall back to rules", async () => {
  const cases: { name: string; respond: FetchLike; calls: number }[] = [
    {
      name: "http",
      calls: 1,
      respond: async () => new Response(`invalid ${KEY}`, { status: 500 }),
    },
    {
      name: "empty",
      calls: 1,
      respond: async () => jsonResponse({ choices: [{ message: { content: "{}" } }] }),
    },
    {
      name: "bad",
      calls: 1,
      respond: async () => jsonResponse({ choices: [{ message: { content: "not json" } }] }),
    },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      return item.respond(url, init);
    };
    const result = await summarizeSessions(baseOpts({
      model: {
        enabled: true,
        env: {
          ACB_MODEL: "demo-model",
          ACB_MODEL_API_KEY: KEY,
          ACB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
        },
        fetchImpl,
      },
      notesText: "## 目标\nRule goal\n",
    }));
    assert.equal(calls, item.calls, item.name);
    assert.equal(result.workState.goal, "Rule goal", item.name);
    const failed = result.losses.find((entry) => entry.code === "work_state.model_failed");
    assert.ok(failed, item.name);
    assert.equal(JSON.stringify(result).includes(KEY), false, item.name);
    assert.ok(result.losses.some((entry) => entry.code === "summarize.notes_structured"), item.name);
  }
});

test("a 400 response_format error is retried once without that field", async () => {
  const bodies: unknown[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { response_format?: unknown };
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: "response_format is unsupported" } }), { status: 400 });
    }
    return jsonResponse({
      choices: [{ message: { content: "```json\n{\"work_state\":{\"goal\":\"Fenced goal\",\"decisions\":\"keep the gate\"}}\n```" } }],
    });
  };
  const result = await summarizeSessions(baseOpts({
    model: {
      enabled: true,
      env: {
        ACB_MODEL: "demo-model",
        ACB_MODEL_API_KEY: KEY,
        ACB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      },
      fetchImpl,
    },
    notesText: "plain notes without a heading",
  }));
  assert.equal(bodies.length, 2);
  assert.ok((bodies[0] as { response_format?: unknown }).response_format);
  assert.equal((bodies[1] as { response_format?: unknown }).response_format, undefined);
  assert.equal(result.workState.goal, "Fenced goal");
  assert.equal(result.workState.decisions[0]?.summary, "keep the gate");
  assert.ok(result.losses.some((entry) => entry.code === "work_state.model_drafted"));
});

test("timeout and a missing config file fall back without throwing", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-model-"));
  try {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    };
    const timed = await summarizeSessions(baseOpts({
      model: {
        enabled: true,
        timeoutMs: 1000,
        env: {
          ACB_MODEL: "demo-model",
          ACB_MODEL_API_KEY: KEY,
          ACB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
        },
        fetchImpl,
      },
      notesText: "## 目标\nRule goal\n",
    }));
    assert.equal(timed.workState.goal, "Rule goal");
    assert.match(timed.losses.find((entry) => entry.code === "work_state.model_failed")?.message ?? "", /timed out/);
    assert.equal(JSON.stringify(timed).includes(KEY), false);

    let called = 0;
    const missing = await summarizeSessions(baseOpts({
      model: {
        enabled: true,
        configPath: join(home, "missing.json"),
        env: {},
        fetchImpl: async () => {
          called += 1;
          throw new Error("fetch should not run");
        },
      },
      notesText: "## 目标\nRule goal\n",
    }));
    assert.equal(called, 0);
    assert.match(missing.losses.find((entry) => entry.code === "work_state.model_failed")?.message ?? "", /not found/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("config file key is used, and ACB_MODEL_API_KEY overrides it", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-model-cfg-"));
  const configPath = join(home, "model.json");
  await writeFile(configPath, JSON.stringify({ model: "from-file", baseUrl: "http://127.0.0.1:9/v1", apiKey: FILE_KEY }), "utf8");
  try {
    const auths: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ goal: "From config" }) } }] });
    };
    const fromFile = await summarizeSessions(baseOpts({
      model: { enabled: true, configPath, env: {}, fetchImpl },
      notesText: "## 目标\nRule goal\n",
    }));
    assert.equal(fromFile.workState.goal, "From config");
    assert.equal(auths[0], `Bearer ${FILE_KEY}`);
    assert.equal(JSON.stringify(fromFile).includes(FILE_KEY), false);

    const fromEnv = await summarizeSessions(baseOpts({
      model: {
        enabled: true,
        configPath,
        env: { ACB_MODEL_API_KEY: KEY },
        fetchImpl,
      },
      notesText: "## 目标\nRule goal\n",
    }));
    assert.equal(fromEnv.workState.goal, "From config");
    assert.equal(auths[1], `Bearer ${KEY}`);
    assert.equal(JSON.stringify(fromEnv).includes(KEY), false);
    assert.equal(JSON.stringify(fromEnv).includes(FILE_KEY), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("credentials in the base URL are refused before any request", async () => {
  let called = 0;
  const fetchImpl: FetchLike = async () => {
    called += 1;
    throw new Error("no");
  };
  const result = await summarizeSessions(baseOpts({
    model: {
      enabled: true,
      baseUrl: `http://user:${KEY}@127.0.0.1:9/v1`,
      env: { ACB_MODEL: "demo-model", ACB_MODEL_API_KEY: KEY },
      fetchImpl,
    },
    notesText: "## 目标\nRule goal\n",
  }));
  assert.equal(called, 0);
  assert.match(result.losses.find((entry) => entry.code === "work_state.model_failed")?.message ?? "", /credentials/);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("repair model drafts stay out of the bundle until confirm or reject", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ goal: "MODEL_ONLY_GOAL_9f3a" }) } }] });
  };
  const model = {
    enabled: true,
    env: {
      ACB_MODEL: "demo-model",
      ACB_MODEL_API_KEY: KEY,
      ACB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
    },
    fetchImpl,
  };
  const started = startRepair(repairBundle());
  const drafted = await answerWithModel(started, "目标：用户原文目标", model);
  assert.equal(calls, 1);
  assert.equal(drafted.phase, "awaiting_confirm");
  assert.equal(drafted.bundle.work_state.goal, undefined);
  assert.equal(started.bundle.work_state.goal, undefined);
  assert.equal(JSON.stringify(drafted.bundle).includes("MODEL_ONLY_GOAL_9f3a"), false);
  assert.equal(drafted.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.model_drafted"), false);
  assert.equal(drafted.proposals[0]?.status, "pending");
  assert.match(drafted.messages.at(-1)?.text ?? "", /外部模型起草/);
  assert.equal(drafted.proposals[0]?.patch.goal, "MODEL_ONLY_GOAL_9f3a");

  const rejected = rejectProposals(drafted, [drafted.proposals[0].id]);
  assert.equal(rejected.bundle.work_state.goal, undefined);
  assert.equal(JSON.stringify(rejected.bundle.work_state).includes("MODEL_ONLY_GOAL_9f3a"), false);
  assert.ok(rejected.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.model_drafted"));
  assert.ok(rejected.bundle.manifest.loss_report.some((entry) => entry.code === "repair.declined"));
  assert.equal(JSON.stringify(rejected.bundle).includes(KEY), false);

  const again = await answerWithModel(startRepair(repairBundle()), "目标：第二条", model);
  const confirmed = confirmProposals(again, [again.proposals[0].id]);
  assert.equal(confirmed.bundle.work_state.goal, "MODEL_ONLY_GOAL_9f3a");
  assert.ok(confirmed.bundle.manifest.loss_report.some((entry) => entry.code === "repair.applied"));
  assert.ok(confirmed.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.model_drafted"));
  assert.equal(again.bundle.work_state.goal, undefined);
});

test("repair skips do not call the model, and model failure keeps the rule draft pending", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return new Response("nope", { status: 503 });
  };
  const model = {
    enabled: true,
    env: {
      ACB_MODEL: "demo-model",
      ACB_MODEL_API_KEY: KEY,
      ACB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
    },
    fetchImpl,
  };
  const started = startRepair(repairBundle());
  const skipped = await answerWithModel(started, "跳过", model);
  assert.equal(calls, 0);
  assert.equal(skipped.proposals[0]?.noop, true);
  assert.equal(skipped.bundle.work_state.goal, undefined);
  assert.equal(skipped.proposals[0]?.draftLosses.length, 0);

  const failed = await draftAnswersWithModel(startRepair(repairBundle()), [
    { lossIndex: 0, text: "目标：规则目标" },
  ], model);
  assert.equal(calls, 1);
  assert.equal(failed.bundle.work_state.goal, undefined);
  assert.equal(failed.proposals[0]?.patch.goal, "规则目标");
  assert.ok(failed.proposals[0]?.draftLosses.some((entry) => entry.code === "work_state.model_failed"));
  assert.equal(JSON.stringify(failed.bundle).includes("规则目标"), false);
  const confirmed = confirmProposals(failed, [failed.proposals[0].id]);
  assert.equal(confirmed.bundle.work_state.goal, "规则目标");
  assert.ok(confirmed.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.model_failed"));
});

test("CLI and web keep the confirm gate, ignore client model settings, and stay rule-based when model is off", async () => {
  const home = await mkdtemp(join(tmpdir(), "acb-model-http-"));
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  const good = await listen((hit) => {
    assert.equal(hit.authorization, `Bearer ${KEY}`);
    assert.equal(hit.body.includes("attacker-key-SHOULDNOTBEUSED"), false);
    return {
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ goal: "MODEL_ONLY_GOAL_9f3a", last_summary: "from model" }) } }] }),
    };
  });
  const evil = await listen(() => ({ status: 500, body: "{\"error\":\"evil\"}" }));
  const previous = snapshotEnv();
  try {
    const notes = join(home, "notes.md");
    const out = join(home, "out.bundle.json");
    await writeFile(notes, "## 目标\nRule goal\n", "utf8");
    const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
    const env = {
      ...process.env,
      ACB_MODEL: "demo-model",
      ACB_MODEL_BASE_URL: good.baseUrl,
      ACB_MODEL_API_KEY: KEY,
      ACB_MODEL_CONFIG: "",
    };
    const help = await exec(process.execPath, [tsx, "src/index.ts", "summarize", "--help"], { cwd: root });
    assert.match(help.stdout, /--model\b/);

    const off = await exec(process.execPath, [
      tsx, "src/index.ts", "summarize",
      "--notes", notes,
      "--agent", "cursor",
      "--cursor-home", join(home, "cursor"),
      "--home", home,
    ], { cwd: root, env });
    assert.match(off.stdout, /Rule goal/);
    assert.equal(off.stdout.includes("MODEL_ONLY_GOAL_9f3a"), false);
    assert.equal(off.stdout.includes(KEY), false);
    assert.equal(good.hits.length, 0);

    const preview = await exec(process.execPath, [
      tsx, "src/index.ts", "summarize",
      "--notes", notes,
      "--agent", "cursor",
      "--cursor-home", join(home, "cursor"),
      "--home", home,
      "--model",
      "--dry-run",
      "-o", out,
    ], { cwd: root, env });
    assert.match(preview.stdout, /MODEL_ONLY_GOAL_9f3a/);
    assert.match(preview.stdout, /work_state\.model_drafted/);
    assert.equal(preview.stdout.includes(KEY), false);
    assert.equal(preview.stderr.includes(KEY), false);
    await assert.rejects(readFile(out, "utf8"));
    assert.equal(good.hits.length, 1);

    const written = await exec(process.execPath, [
      tsx, "src/index.ts", "summarize",
      "--notes", notes,
      "--agent", "cursor",
      "--cursor-home", join(home, "cursor"),
      "--home", home,
      "--model",
      "-o", out,
    ], { cwd: root, env });
    assert.equal(written.stdout.includes(KEY), false);
    const saved = JSON.parse(await readFile(out, "utf8")) as AgentWorkBundle;
    assert.equal(saved.work_state.goal, "MODEL_ONLY_GOAL_9f3a");
    assert.equal(saved.manifest.version, "0.1");
    assert.ok(saved.manifest.loss_report.some((entry) => entry.code === "summarize.written"));
    assert.ok(saved.manifest.loss_report.some((entry) => entry.code === "work_state.model_drafted"));
    assert.equal(JSON.stringify(saved).includes(KEY), false);
    await assert.rejects(readFile(join(home, ".acb/WORK_STATE.md"), "utf8"));

    const noKey = await exec(process.execPath, [
      tsx, "src/index.ts", "summarize",
      "--notes", notes,
      "--agent", "cursor",
      "--cursor-home", join(home, "cursor"),
      "--home", home,
      "--model",
    ], {
      cwd: root,
      env: { ...env, ACB_MODEL_API_KEY: "" },
    });
    assert.match(noKey.stdout, /Rule goal/);
    assert.match(noKey.stdout, /work_state\.model_failed/);
    assert.equal(good.hits.length, 2);

    process.env.ACB_MODEL = "demo-model";
    process.env.ACB_MODEL_BASE_URL = good.baseUrl;
    process.env.ACB_MODEL_API_KEY = KEY;
    delete process.env.ACB_MODEL_CONFIG;
    await withServer(async (port) => {
      const quiet = await postJson(port, "/api/summarize/preview", {
        project,
        agent: "cursor",
        cursorHome: join(home, "cursor"),
        home,
        notesText: "## 目标\nRule goal\n",
        modelBaseUrl: evil.baseUrl,
        apiKey: "attacker-key-SHOULDNOTBEUSED",
      });
      assert.equal(quiet.status, 200);
      const quietBody = await quiet.json() as { workState: { goal?: string }; losses: { code: string }[]; applied: boolean };
      assert.equal(quietBody.applied, false);
      assert.equal(quietBody.workState.goal, "Rule goal");
      assert.equal(quietBody.losses.some((entry) => entry.code.startsWith("work_state.model_")), false);

      const hitsBefore = good.hits.length;
      const previewRes = await postJson(port, "/api/summarize/preview", {
        project,
        agent: "cursor",
        cursorHome: join(home, "cursor"),
        home,
        notesText: "## 目标\nRule goal\n",
        model: true,
        modelBaseUrl: evil.baseUrl,
        apiKey: "attacker-key-SHOULDNOTBEUSED",
        modelName: "attacker-model",
      });
      assert.equal(previewRes.status, 200);
      const previewBody = await previewRes.json() as {
        applied: boolean;
        workState: { goal?: string };
        losses: LossReportEntry[];
      };
      assert.equal(previewBody.applied, false);
      assert.equal(previewBody.workState.goal, "MODEL_ONLY_GOAL_9f3a");
      assert.ok(previewBody.losses.some((entry) => entry.code === "work_state.model_drafted"));
      assert.equal(JSON.stringify(previewBody).includes(KEY), false);
      assert.equal(JSON.stringify(previewBody).includes("attacker-key-SHOULDNOTBEUSED"), false);
      assert.equal(good.hits.length, hitsBefore + 1);
      assert.equal(evil.hits.length, 0);
      await assert.rejects(readFile(join(project, ".acb/WORK_STATE.md"), "utf8"));

      const applyRes = await postJson(port, "/api/summarize/apply", {
        project,
        workState: previewBody.workState,
        losses: previewBody.losses,
        sourceAgent: "cursor",
      });
      const applied = await applyRes.json() as { applied: boolean; bundle: AgentWorkBundle };
      assert.equal(applied.applied, true);
      assert.equal(applied.bundle.work_state.goal, "MODEL_ONLY_GOAL_9f3a");
      assert.equal(applied.bundle.manifest.version, "0.1");
      assert.ok(applied.bundle.manifest.loss_report.some((entry) => entry.code === "summarize.confirmed"));
      assert.ok(applied.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.model_drafted"));
      await assert.rejects(readFile(join(project, ".acb/WORK_STATE.md"), "utf8"));

      delete process.env.ACB_MODEL_API_KEY;
      const fallback = await postJson(port, "/api/summarize/preview", {
        project,
        agent: "cursor",
        cursorHome: join(home, "cursor"),
        home,
        notesText: "## 目标\nRule goal\n",
        model: true,
      });
      const fallbackBody = await fallback.json() as { workState: { goal?: string }; losses: { code: string; message: string }[] };
      assert.equal(fallbackBody.workState.goal, "Rule goal");
      assert.ok(fallbackBody.losses.some((entry) => entry.code === "work_state.model_failed"));
      process.env.ACB_MODEL_API_KEY = KEY;

      const started = await postJson(port, "/api/repair/start", { bundle: repairBundle() });
      const session = await started.json() as { id: string; bundle: AgentWorkBundle };
      const answered = await postJson(port, `/api/repair/${session.id}/answer`, {
        text: "目标：用户原文目标",
        model: true,
        apiKey: "attacker-key-SHOULDNOTBEUSED",
        modelBaseUrl: evil.baseUrl,
      });
      const pending = await answered.json() as {
        phase: string;
        bundle: AgentWorkBundle;
        proposals: { id: string; status: string; preview: string }[];
      };
      assert.equal(pending.phase, "awaiting_confirm");
      assert.equal(pending.bundle.work_state.goal, undefined);
      assert.equal(pending.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.model_drafted"), false);
      assert.match(pending.proposals[0]?.preview ?? "", /MODEL_ONLY_GOAL_9f3a/);
      assert.equal(evil.hits.length, 0);

      const confirmed = await postJson(port, `/api/repair/${session.id}/confirm`, { ids: [pending.proposals[0]?.id] });
      const settled = await confirmed.json() as { bundle: AgentWorkBundle };
      assert.equal(settled.bundle.work_state.goal, "MODEL_ONLY_GOAL_9f3a");
      assert.ok(settled.bundle.manifest.loss_report.some((entry) => entry.code === "repair.applied"));
      assert.ok(settled.bundle.manifest.loss_report.some((entry) => entry.code === "work_state.model_drafted"));
      await assert.rejects(readFile(join(project, ".acb/WORK_STATE.md"), "utf8"));
    });
  } finally {
    restoreEnv(previous);
    await good.close();
    await evil.close();
    await rm(home, { recursive: true, force: true });
  }
});

function baseOpts(extra: Parameters<typeof summarizeSessions>[0]): Parameters<typeof summarizeSessions>[0] {
  return {
    projectRoot: "/tmp/acb-model-unused",
    agent: "cursor",
    cursorHome: "/tmp/acb-model-unused-cursor",
    homeDir: "/tmp/acb-model-unused-home",
    ...extra,
  };
}

function repairBundle(): AgentWorkBundle {
  return {
    manifest: {
      version: "0.1",
      source_agent: "cursor",
      target_agent: "trae",
      created_at: "2026-11-04T00:00:00.000Z",
      loss_report: [{ code: "work_state.not_inferred", message: "empty work_state emitted", severity: "info" }],
    },
    repo_context: emptyRepoContext(),
    work_state: emptyWorkState(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ENV_KEYS = ["ACB_MODEL", "ACB_MODEL_BASE_URL", "ACB_MODEL_API_KEY", "ACB_MODEL_CONFIG", "ACB_MODEL_TIMEOUT_MS"];

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface ModelHit {
  authorization?: string;
  body: string;
}

async function listen(onRequest: (hit: ModelHit) => { status: number; body: string }): Promise<{
  baseUrl: string;
  hits: ModelHit[];
  close: () => Promise<void>;
}> {
  const hits: ModelHit[] = [];
  const server = createServer(async (req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const hit = {
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    hits.push(hit);
    try {
      const result = onRequest(hit);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(result.body);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(err instanceof Error ? err.message : "mock failed");
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits,
    close: () => new Promise((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
    }),
  };
}

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

function postJson(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

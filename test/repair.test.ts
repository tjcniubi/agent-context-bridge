import assert from "node:assert/strict";
import test from "node:test";
import { emptyRepoContext, emptyWorkState, type AgentWorkBundle, type LossReportEntry } from "../src/protocol/types.js";
import { validateBundle } from "../src/protocol/validate.js";
import {
  answerCurrent,
  confirmProposals,
  draftAnswers,
  pendingIds,
  rejectProposals,
  reviseProposal,
  startRepair,
} from "../src/repair/guide.js";

function bundle(losses: LossReportEntry[], goal?: string): AgentWorkBundle {
  return {
    manifest: {
      version: "0.1",
      source_agent: "cursor",
      target_agent: "trae",
      created_at: "2026-11-04T00:00:00.000Z",
      loss_report: losses,
    },
    repo_context: emptyRepoContext(),
    work_state: { ...emptyWorkState(), ...(goal ? { goal } : {}) },
  };
}

const losses: LossReportEntry[] = [
  {
    code: "work_state.not_inferred",
    message: "empty work_state emitted",
    severity: "info",
  },
  {
    code: "transcript.skipped",
    message: "transcript layer skipped",
    severity: "info",
  },
];

test("drafting does not write work_state until confirm", () => {
  const started = startRepair(bundle(losses));
  const drafted = answerCurrent(started, "目标：把规则迁过去\n待办：核对 frontmatter | high");
  assert.equal(drafted.phase, "awaiting_confirm");
  assert.equal(drafted.bundle.work_state.goal, undefined);
  assert.equal(drafted.bundle.work_state.open_loops.length, 0);
  assert.equal(started.bundle.work_state.goal, undefined);
  assert.equal(drafted.proposals.filter((item) => item.status === "pending").length, 1);

  const chatter = answerCurrent(drafted, "可以写入了吧");
  assert.equal(chatter.bundle.work_state.goal, undefined);
  assert.equal(chatter.phase, "awaiting_confirm");
  assert.match(chatter.messages.at(-1)?.text ?? "", /还没有写入/);

  const confirmed = confirmProposals(drafted, [drafted.proposals[0].id]);
  assert.equal(confirmed.bundle.work_state.goal, "把规则迁过去");
  assert.equal(confirmed.bundle.work_state.open_loops[0]?.summary, "核对 frontmatter");
  assert.equal(confirmed.bundle.work_state.open_loops[0]?.priority, "high");
  assert.equal(drafted.bundle.work_state.goal, undefined);
  assert.equal(confirmed.proposals[0]?.status, "confirmed");
  assert.ok(confirmed.bundle.manifest.loss_report.some((entry) => entry.code === "repair.applied"));
  assert.equal(validateBundle(confirmed.bundle).ok, true);
  assert.equal(confirmed.phase, "asking");
  assert.equal(confirmed.losses[confirmed.cursor]?.code, "transcript.skipped");
});

test("reject and skip leave work_state unchanged", () => {
  const started = startRepair(bundle(losses));
  const drafted = answerCurrent(started, "坑：不要静默丢字段");
  const rejected = rejectProposals(drafted, [drafted.proposals[0].id]);
  assert.equal(rejected.bundle.work_state.known_pitfalls.length, 0);
  assert.equal(rejected.bundle.work_state.goal, undefined);
  assert.ok(rejected.bundle.manifest.loss_report.some((entry) => entry.code === "repair.declined"));

  const skipped = answerCurrent(rejected, "跳过");
  assert.equal(skipped.proposals.at(-1)?.noop, true);
  const acceptedSkip = confirmProposals(skipped, [skipped.proposals.at(-1)!.id]);
  assert.equal(acceptedSkip.bundle.work_state.goal, undefined);
  assert.equal(acceptedSkip.bundle.work_state.last_summary, undefined);
  assert.ok(acceptedSkip.bundle.manifest.loss_report.some((entry) => entry.code === "repair.skipped"));
  assert.equal(acceptedSkip.phase, "done");
});

test("chat confirm is explicit and a second confirm fails", () => {
  let session = startRepair(bundle([losses[0]]));
  session = answerCurrent(session, "目标：只在确认后写入");
  assert.equal(session.bundle.work_state.goal, undefined);
  session = answerCurrent(session, "确认");
  assert.equal(session.bundle.work_state.goal, "只在确认后写入");
  assert.throws(() => confirmProposals(session, [session.proposals[0].id]), /已经处理过/);
});

test("revise drops the draft and the next confirm uses the new answer", () => {
  let session = startRepair(bundle([losses[0]]));
  session = answerCurrent(session, "目标：旧目标");
  const oldId = session.proposals[0].id;
  session = reviseProposal(session, oldId);
  assert.equal(session.phase, "asking");
  assert.equal(session.bundle.work_state.goal, undefined);
  assert.equal(session.proposals.length, 0);
  session = answerCurrent(session, "目标：新目标");
  session = confirmProposals(session, [session.proposals[0].id]);
  assert.equal(session.bundle.work_state.goal, "新目标");
});

test("batch confirm applies only pending proposals", () => {
  let session = startRepair(bundle(losses));
  session = draftAnswers(session, [
    { lossIndex: 0, text: "目标：批量目标" },
    { lossIndex: 1, text: "摘要：对话没过来" },
  ]);
  assert.equal(session.bundle.work_state.goal, undefined);
  assert.equal(session.bundle.work_state.last_summary, undefined);
  const [first, second] = session.proposals;
  session = rejectProposals(session, [first.id]);
  assert.equal(session.bundle.work_state.goal, undefined);
  session = confirmProposals(session, pendingIds(session));
  assert.equal(session.bundle.work_state.goal, undefined);
  assert.equal(session.bundle.work_state.last_summary, "对话没过来");
  assert.equal(second.status, "pending");
  assert.equal(session.proposals[1]?.status, "confirmed");
});

test("repair bookkeeping is not asked again", () => {
  const session = startRepair(
    bundle([
      { code: "repair.applied", message: "already applied", severity: "info" },
      { code: "trae.rules.nested_modules", message: "nested rules skipped", severity: "info", path: ".trae/rules" },
    ]),
  );
  assert.equal(session.losses.length, 1);
  assert.equal(session.phase, "asking");
  const drafted = answerCurrent(session, "src/adapters/trae.ts — 子目录规则");
  assert.equal(drafted.bundle.work_state.file_anchors.length, 0);
  const confirmed = confirmProposals(drafted, [drafted.proposals[0].id]);
  assert.deepEqual(confirmed.bundle.work_state.file_anchors[0], {
    path: "src/adapters/trae.ts",
    note: "子目录规则",
  });
});

test("empty loss report finishes without changing work state", () => {
  const session = startRepair(bundle([]), "repair_empty");
  assert.equal(session.phase, "done");
  assert.equal(session.messages.length, 1);
  assert.equal(session.bundle.work_state.decisions.length, 0);
});

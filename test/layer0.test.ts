import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { exportProject, importProject } from "../src/core/operations.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("nested AGENTS.md and module rules map between Cursor and Trae", async () => {
  const project = await tempDir("acb-nested-");
  const home = await tempDir("acb-home-");
  try {
    await writeFile(join(project, "AGENTS.md"), "# Root\n", "utf8");
    await mkdir(join(project, "packages", "web"), { recursive: true });
    await writeFile(join(project, "packages", "web", "AGENTS.md"), "# Web\n", "utf8");
    await mkdir(join(project, "packages", "web", ".trae", "rules"), { recursive: true });
    await writeFile(
      join(project, "packages", "web", ".trae", "rules", "ui.md"),
      "---\ndescription: UI\nalwaysApply: true\nscene: git_message\n---\n\nUse the grid.\n",
      "utf8",
    );
    await mkdir(join(project, ".cursor", "rules", "deep"), { recursive: true });
    await writeFile(
      join(project, ".cursor", "rules", "deep", "root.mdc"),
      "---\ndescription: Root\nglobs: [\"src/**/*.ts\", \"test/**/*.ts\"]\nalwaysApply: false\n---\n\nStrict.\n",
      "utf8",
    );
    await mkdir(join(project, ".cursor", "skills", "review"), { recursive: true });
    await writeFile(join(project, ".cursor", "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(join(project, ".cursor", "skills", "review", "notes.txt"), "extra\n", "utf8");
    await writeFile(join(project, ".cursor", "skills", "review", "diagram.png"), "PNG", "utf8");
    await writeFile(
      join(project, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "echo", env: { TOKEN: "project-secret" } } } }),
      "utf8",
    );

    const exported = await exportProject({
      agent: "cursor",
      project,
      userHome: home,
    });
    const instructions = exported.bundle.repo_context.instructions_files.map((file) => file.source_path);
    assert.ok(instructions.includes("AGENTS.md"));
    assert.ok(instructions.includes("packages/web/AGENTS.md"));
    assert.equal(exported.bundle.repo_context.agents_md, "# Root\n");
    const rulePaths = exported.bundle.repo_context.rules.map((rule) => rule.source_path);
    assert.ok(rulePaths.includes(".cursor/rules/deep/root.mdc"));
    assert.ok(rulePaths.includes("packages/web/.trae/rules/ui.md"));
    assert.equal(exported.bundle.repo_context.skills[0]?.name, "review");
    assert.equal(exported.bundle.repo_context.skills[0]?.extras?.["notes.txt"], "extra\n");
    assert.equal(exported.bundle.repo_context.skills[0]?.extras?.["diagram.png"], undefined);
    assert.ok(exported.losses.some((entry) => entry.code === "skills.binary_omitted"));
    assert.ok(exported.losses.some((entry) => entry.code === "repo.other_layout_included"));
    assert.ok(exported.losses.some((entry) => entry.code === "mcp.env.unredacted"));
    assert.equal(exported.bundle.repo_context.mcp_servers[0]?.config.env?.TOKEN, "project-secret");
    assert.equal(exported.bundle.transcript, undefined);
    assert.ok(!exported.losses.some((entry) => entry.code === "trae.rules.nested_modules"));

    const target = await tempDir("acb-nested-to-");
    try {
      const imported = await importProject({
        agent: "trae",
        project: target,
        bundle: exported.bundle,
        userHome: home,
      });
      const ui = await readFile(join(target, "packages", "web", ".trae", "rules", "ui.md"), "utf8");
      assert.match(ui, /scene:/);
      const mapped = await readFile(join(target, ".trae", "rules", "deep", "root.md"), "utf8");
      assert.match(mapped, /globs: src\/\*\*\/\*\.ts,test\/\*\*\/\*\.ts/);
      assert.doesNotMatch(mapped, /\[/);
      assert.ok(imported.losses.some((entry) => entry.code === "trae.rules.globs_normalized"));
      const nestedAgents = await readFile(join(target, "packages", "web", "AGENTS.md"), "utf8");
      assert.match(nestedAgents, /# Web/);
      const skill = await readFile(join(target, ".trae", "skills", "review", "SKILL.md"), "utf8");
      assert.match(skill, /# Review/);
      const extra = await readFile(join(target, ".trae", "skills", "review", "notes.txt"), "utf8");
      assert.equal(extra, "extra\n");
      assert.ok(imported.changes.some((change) => change.path === ".trae/rules/deep/root.md" && change.action === "create"));

      const again = await importProject({
        agent: "trae",
        project: target,
        bundle: exported.bundle,
        userHome: home,
        dryRun: true,
      });
      assert.ok(again.changes.some((change) => change.path === "AGENTS.md" && change.action === "unchanged"));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("--include-user reads safe home files and redacts user MCP secrets", async () => {
  const project = await tempDir("acb-user-proj-");
  const home = await tempDir("acb-user-home-");
  const outside = await tempDir("acb-user-out-");
  try {
    await mkdir(join(home, ".cursor", "rules"), { recursive: true });
    await mkdir(join(home, ".cursor", "skills", "global"), { recursive: true });
    await writeFile(join(home, ".cursor", "rules", "global.mdc"), "---\nalwaysApply: true\n---\n\nBe brief.\n", "utf8");
    await writeFile(join(home, ".cursor", "skills", "global", "SKILL.md"), "# Global\n", "utf8");
    await writeFile(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          global: { command: "echo", env: { TOKEN: "user-secret" }, headers: { Authorization: "user-secret" } },
        },
      }),
      "utf8",
    );
    await writeFile(join(outside, "secret.txt"), "user-secret-via-symlink", "utf8");
    await symlink(join(outside, "secret.txt"), join(home, ".cursor", "rules", "escaped.mdc"));

    const exported = await exportProject({
      agent: "cursor",
      project,
      includeUser: true,
      userHome: home,
    });
    const body = JSON.stringify(exported.bundle);
    assert.match(body, /Be brief/);
    assert.match(body, /# Global/);
    assert.doesNotMatch(body, /user-secret/);
    assert.doesNotMatch(body, /user-secret-via-symlink/);
    assert.match(body, /\$\{REDACTED\}/);
    assert.ok(exported.losses.some((entry) => entry.code === "mcp.env.redacted"));
    assert.ok(exported.losses.some((entry) => entry.code === "cursor.user_rules.account_only"));
    assert.ok(exported.losses.some((entry) => entry.code === "user_scope.symlink_skipped"));
    const userRule = exported.bundle.repo_context.rules.find((rule) => rule.scope === "user");
    assert.equal(userRule?.name, "global.mdc");

    const target = await tempDir("acb-user-target-");
    const home2 = await tempDir("acb-user-home2-");
    try {
      await mkdir(join(home2, ".cursor"), { recursive: true });
      await writeFile(
        join(home2, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { kept: { command: "original" } } }) + "\n",
        "utf8",
      );
      const skipped = await importProject({
        agent: "cursor",
        project: target,
        bundle: exported.bundle,
        userHome: home2,
      });
      assert.ok(skipped.losses.some((entry) => entry.code === "user_scope.not_written"));
      const untouched = await readFile(join(home2, ".cursor", "mcp.json"), "utf8");
      assert.match(untouched, /original/);
      await assert.rejects(readFile(join(home2, ".cursor", "rules", "global.mdc"), "utf8"));

      const written = await importProject({
        agent: "cursor",
        project: target,
        bundle: exported.bundle,
        includeUser: true,
        userHome: home2,
      });
      assert.ok(written.changes.some((change) => change.path === "~/.cursor/rules/global.mdc"));
      const mcp = JSON.parse(await readFile(join(home2, ".cursor", "mcp.json"), "utf8")) as {
        mcpServers: Record<string, { command?: string; env?: Record<string, string> }>;
      };
      assert.equal(mcp.mcpServers.kept.command, "original");
      assert.equal(mcp.mcpServers.global.env?.TOKEN, "${REDACTED}");
      const skill = await readFile(join(home2, ".cursor", "skills", "global", "SKILL.md"), "utf8");
      assert.match(skill, /# Global/);
    } finally {
      await rm(target, { recursive: true, force: true });
      await rm(home2, { recursive: true, force: true });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Trae user_rules file is read and written without opening a database", async () => {
  const project = await tempDir("acb-trae-user-");
  const home = await tempDir("acb-trae-home-");
  try {
    await mkdir(join(home, ".trae", "skills", "ship"), { recursive: true });
    await writeFile(join(home, ".trae", "user_rules"), "Prefer small patches.\n", "utf8");
    await writeFile(join(home, ".trae", "skills", "ship", "SKILL.md"), "# Ship\n", "utf8");
    await mkdir(join(project, "ModularData", "ai-agent"), { recursive: true });
    await writeFile(join(project, "ModularData", "ai-agent", "database.db"), "SECRET_DB_BYTES", "utf8");

    const exported = await exportProject({
      agent: "trae",
      project,
      includeUser: true,
      userHome: home,
    });
    assert.match(JSON.stringify(exported.bundle), /Prefer small patches/);
    assert.doesNotMatch(JSON.stringify(exported.bundle), /SECRET_DB_BYTES/);
    assert.ok(exported.losses.some((entry) => entry.code === "trae.user_mcp.unavailable"));
    const rule = exported.bundle.repo_context.rules.find((item) => item.name === "user_rules");
    assert.equal(rule?.scope, "user");

    const home2 = await tempDir("acb-trae-home2-");
    try {
      await importProject({
        agent: "trae",
        project,
        bundle: exported.bundle,
        includeUser: true,
        userHome: home2,
      });
      const text = await readFile(join(home2, ".trae", "user_rules"), "utf8");
      assert.match(text, /Prefer small patches/);
      const skill = await readFile(join(home2, ".trae", "skills", "ship", "SKILL.md"), "utf8");
      assert.match(skill, /# Ship/);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

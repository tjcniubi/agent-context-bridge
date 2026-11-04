import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { matchProjectDirectories } from "../src/web/locate.js";
import { createRequestListener } from "../src/web/server.js";
import { UserInputError } from "../src/core/errors.js";

test("directory match uses name, children, and an optional hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "acb-locate-"));
  const alpha = join(root, "alpha", "demo-app");
  const beta = join(root, "beta", "demo-app");
  await mkdir(join(alpha, "src"), { recursive: true });
  await mkdir(join(beta, "src"), { recursive: true });
  await writeFile(join(alpha, "package.json"), '{"name":"alpha"}\n', "utf8");
  await writeFile(join(beta, "package.json"), '{"name":"beta"}\n', "utf8");
  const sha256 = createHash("sha256").update('{"name":"alpha"}\n').digest("hex");
  try {
    const both = await matchProjectDirectories({
      name: "demo-app",
      entries: ["package.json", "src"],
      roots: [root],
    });
    assert.equal(both.matches.length, 2);

    const one = await matchProjectDirectories({
      name: "demo-app",
      entries: ["package.json", "src"],
      hint: { name: "package.json", sha256 },
      roots: [root],
    });
    assert.deepEqual(one.matches, [alpha]);

    const empty = await matchProjectDirectories({ name: "demo-app", entries: [], roots: [root] });
    assert.deepEqual(empty.matches, []);

    await assert.rejects(
      () => matchProjectDirectories({ name: "../etc", entries: ["package.json"], roots: [root] }),
      UserInputError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/fs/match rejects a path segment and finds a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "acb-locate-http-"));
  const project = join(root, "picked-app");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "README.md"), "hello\n", "utf8");
  const server = createServer(createRequestListener());
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/api/fs/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../etc", entries: ["README.md"], roots: [root] }),
    });
    assert.equal(bad.status, 400);

    const found = await fetch(`http://127.0.0.1:${port}/api/fs/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "picked-app", entries: ["README.md"], roots: [root] }),
    });
    assert.equal(found.status, 200);
    const body = (await found.json()) as { matches: string[] };
    assert.deepEqual(body.matches, [project]);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
    });
    await rm(root, { recursive: true, force: true });
  }
});

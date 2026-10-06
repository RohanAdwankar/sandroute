import { test } from "node:test";
import assert from "node:assert/strict";
import { getCommandNames } from "just-bash";
import { classify } from "../src/router.ts";

const known = new Set([...getCommandNames(), "curl", "git"]);
const tier = (c: string) => classify(known, c).tier;

test("text tools stay in-process", () => {
  assert.equal(tier("sed -i 's/a/b/' f.txt"), "inprocess");
  assert.equal(tier("cat a | grep b | sort | uniq -c"), "inprocess");
  assert.equal(tier("for f in *.txt; do wc -l $f; done"), "inprocess");
});

test("git subcommands split by what is implemented", () => {
  assert.equal(tier("git clone https://example.com/x.git"), "inprocess");
  assert.equal(tier("git add . && git commit -m x"), "inprocess");
  assert.equal(tier("git diff"), "vm");
  assert.equal(tier("git rebase main"), "vm");
});

test("browsers and toolchains go to the vm", () => {
  assert.equal(tier("chromium --headless --screenshot=a.png https://x"), "vm");
  assert.equal(tier("npm install"), "vm");
  assert.equal(tier("cargo build"), "vm");
});

test("a vm command anywhere in a pipeline sends the whole line to the vm", () => {
  assert.equal(tier("cat a.txt && chromium --version"), "vm");
  assert.equal(tier("echo $(node -v)"), "vm");
});

test("unknown binaries and path-invoked scripts go to the vm", () => {
  assert.equal(tier("mytool --flag"), "vm");
  assert.equal(tier("./build.sh"), "vm");
});

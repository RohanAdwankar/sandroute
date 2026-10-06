import { test } from "node:test";
import assert from "node:assert/strict";
import { getCommandNames } from "just-bash";
import { classify } from "../src/router.ts";

const known = new Set([...getCommandNames(), "curl", "git"]);
const WS = "/work/proj";
const tier = (c: string) => classify(known, c, WS).tier;

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

test("questions about the machine go to the vm, so the agent gets a true answer", () => {
  assert.equal(tier("command -v chromium"), "vm");
  assert.equal(tier("which node"), "vm");
  assert.equal(tier("echo $PATH"), "vm");
  assert.equal(tier("uname -a"), "vm");
});

test("paths outside the workspace go to the vm, paths inside do not", () => {
  assert.equal(tier("ls /usr/bin | grep chrom"), "vm");
  assert.equal(tier("cat /tmp/out.json"), "vm");
  assert.equal(tier(`cat ${WS}/a.txt`), "inprocess");
  assert.equal(tier("grep x f 2>/dev/null"), "inprocess");
  assert.equal(tier("sed 's/quick/slow/' a.txt"), "inprocess");
});

test("network clients go to the vm", () => {
  assert.equal(tier("curl -s https://example.com"), "vm");
});

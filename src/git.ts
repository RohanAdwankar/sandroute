import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { defineCommand } from "just-bash";

const author = { name: "sandroute", email: "sandroute@localhost" };

/** In-process git: clone, init, status, add, commit, log. The workspace is mounted at its real path, so cwd is a real directory. */
export const gitCommand = defineCommand("git", async (args, ctx) => {
  const out = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode });
  const err = (stderr: string, exitCode = 1) => ({ stdout: "", stderr, exitCode });
  let dir = ctx.cwd;
  const a = [...args];
  if (a[0] === "-C") {
    dir = path.resolve(ctx.cwd, a[1]);
    a.splice(0, 2);
  }
  const [sub, ...rest] = a;
  try {
    switch (sub) {
      case "clone": {
        const pos = rest.filter((x, i) => !x.startsWith("-") && rest[i - 1] !== "--depth");
        const depthIdx = rest.indexOf("--depth");
        const depth = depthIdx >= 0 ? Number(rest[depthIdx + 1]) : undefined;
        const url = pos[0];
        if (!url) return err("fatal: You must specify a repository to clone.\n", 128);
        const name = pos[1] ?? path.basename(url).replace(/\.git$/, "");
        const target = path.resolve(dir, name);
        await git.clone({ fs, http, dir: target, url, depth, singleBranch: true, noCheckout: false });
        return { stdout: "", stderr: `Cloning into '${name}'...\n`, exitCode: 0 };
      }
      case "init":
        await git.init({ fs, dir, defaultBranch: "main" });
        return out(`Initialized empty Git repository in ${dir}/.git/\n`);
      case "add": {
        for (const f of rest.filter((x) => !x.startsWith("-"))) {
          if (f === "." || f === "-A") {
            const matrix = await git.statusMatrix({ fs, dir });
            for (const [file, head, work] of matrix) {
              if (work === 0) await git.remove({ fs, dir, filepath: file });
              else if (head !== work) await git.add({ fs, dir, filepath: file });
            }
          } else await git.add({ fs, dir, filepath: path.relative(dir, path.resolve(dir, f)) });
        }
        return out("");
      }
      case "commit": {
        const mi = rest.indexOf("-m");
        if (mi < 0) return err("error: only `git commit -m <msg>` is supported\n", 129);
        const sha = await git.commit({ fs, dir, message: rest[mi + 1], author });
        return out(`[main ${sha.slice(0, 7)}] ${rest[mi + 1]}\n`);
      }
      case "status": {
        const matrix = await git.statusMatrix({ fs, dir });
        const lines = matrix
          .filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))
          .map(([f, h, w, s]) => `${h === 0 ? "A" : w === 0 ? "D" : "M"}${s === w ? " " : "?"} ${f}`);
        return out(lines.length ? lines.join("\n") + "\n" : "nothing to commit, working tree clean\n");
      }
      case "log": {
        const ni = rest.indexOf("-n");
        const depth = ni >= 0 ? Number(rest[ni + 1]) : 20;
        const commits = await git.log({ fs, dir, depth });
        return out(commits.map((c) => `commit ${c.oid}\n\n    ${c.commit.message.trim()}\n`).join("\n"));
      }
      default:
        return err(`git ${sub}: not implemented in-process\n`, 126);
    }
  } catch (e) {
    return err(`fatal: ${(e as Error).message}\n`, 128);
  }
});

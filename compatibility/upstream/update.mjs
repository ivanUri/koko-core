import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeJson } from "../lib/io.mjs";

const exec = promisify(execFile);
const root = resolve(new URL("../..", import.meta.url).pathname);
const manifestPath = join(root, "compatibility/upstream/manifest.json");

async function git(args, cwd = root) {
  const result = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

async function hashTree(directory) {
  const hash = createHash("sha256");
  async function walk(path, prefix) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const child = join(path, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, relative);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update(await readFile(child));
      }
    }
  }
  await walk(directory, "");
  return `sha256:${hash.digest("hex")}`;
}

async function updateRepository(name, repository) {
  const checkout = resolve(root, repository.checkout);
  try {
    await stat(join(checkout, ".git"));
    await git(["fetch", "--depth=1", "origin", repository.ref], checkout);
    await git(["reset", "--hard", "FETCH_HEAD"], checkout);
  } catch {
    await git(["clone", "--depth=1", "--branch", repository.ref, repository.url, checkout]);
  }
  const commit = await git(["rev-parse", "HEAD"], checkout);
  const contentHash = await hashTree(checkout);
  return { ...repository, commit, contentHash };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const [name, repository] of Object.entries(manifest.repositories)) {
  if (repository.optional && process.env.KOKO_COMPATIBILITY_INCLUDE_OPTIONAL_UPSTREAM !== "1") {
    process.stderr.write(`Skipping optional ${name}; set KOKO_COMPATIBILITY_INCLUDE_OPTIONAL_UPSTREAM=1 to fetch it.\n`);
    continue;
  }
  process.stderr.write(`Updating ${name} at ${repository.url}#${repository.ref}\n`);
  manifest.repositories[name] = await updateRepository(name, repository);
}
manifest.status = "fetched";
manifest.updatedAt = new Date().toISOString();
await writeJson(manifestPath, manifest);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

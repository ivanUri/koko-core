import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stableJson } from "./model.mjs";

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(value), "utf8");
}

export async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    if (equal >= 0) {
      options[arg.slice(2, equal)] = arg.slice(equal + 1);
      continue;
    }
    const key = arg.slice(2);
    if (argv[index + 1] && !argv[index + 1].startsWith("--")) options[key] = argv[++index];
    else options[key] = true;
  }
  return { options, positionals };
}

export function required(options, name) {
  const value = options[name];
  if (!value || value === true) throw new Error(`Missing required option --${name}`);
  return value;
}

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseWebIDLFile } from "./parser.mjs";
import { stableId } from "../lib/model.mjs";

async function idlFiles(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith(".idl")) result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}

function categoryFor(file, override) {
  if (override) return override;
  const value = file.toLowerCase();
  if (value.includes("dom")) return "DOM";
  if (value.includes("fetch")) return "FETCH";
  if (value.includes("stream")) return "STREAMS";
  if (value.includes("css")) return "CSSOM";
  if (value.includes("worker")) return "WORKERS";
  if (value.includes("event")) return "EVENTS";
  if (value.includes("canvas")) return "CANVAS";
  if (value.includes("audio")) return "WEB_AUDIO";
  if (value.includes("rtc")) return "WEBRTC";
  return "OTHER";
}

function memberId(definition, member, overload = 0) {
  return stableId([definition.name, member.kind, member.name, String(overload)]);
}

export async function buildWebIDLInventory({ root, source = "unknown", category = null, context = "Window" }) {
  const absoluteRoot = resolve(root);
  const files = await idlFiles(absoluteRoot);
  const parsed = await Promise.all(files.map((file) => parseWebIDLFile(file, absoluteRoot)));
  const definitions = parsed.flatMap((file) => file.definitions.map((definition) => ({
    ...definition,
    id: stableId([source, definition.kind, definition.name]),
    category: categoryFor(file.file, category),
    context,
    source: { ...definition.source, file: relative(absoluteRoot, join(absoluteRoot, definition.source.file)) },
  })));
  const includes = parsed.flatMap((file) => file.includes.map((include) => ({ ...include, source: { ...include.source, file: file.file } })));
  const mixins = new Map(definitions.filter((definition) => definition.kind === "interface-mixin").map((definition) => [definition.name, definition]));
  const members = [];
  for (const definition of definitions) {
    for (const [index, member] of (definition.members ?? []).entries()) {
      members.push({
        ...member,
        id: memberId(definition, member, index),
        interface: definition.name,
        interfaceId: definition.id,
        category: definition.category,
        context: definition.context,
        source: member.source ?? definition.source,
      });
    }
  }
  for (const include of includes) {
    const mixin = mixins.get(include.mixin);
    if (!mixin) continue;
    for (const [index, member] of (mixin.members ?? []).entries()) {
      members.push({ ...member, id: memberId({ name: include.target }, member, index), interface: include.target, interfaceId: stableId([source, "interface", include.target]), includedFrom: include.mixin, category: categoryFor(include.source.file, category), context, source: include.source });
    }
  }
  definitions.sort((a, b) => a.id.localeCompare(b.id));
  members.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    kind: "webidl-inventory",
    source,
    context,
    root: relative(process.cwd(), absoluteRoot),
    files: parsed.map((file) => file.file).sort(),
    definitions,
    members,
    includes: includes.sort((a, b) => `${a.target}/${a.mixin}`.localeCompare(`${b.target}/${b.mixin}`)),
  };
}

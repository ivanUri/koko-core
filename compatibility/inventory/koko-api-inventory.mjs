#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_CONTEXTS = ["PageJsApis", "WorkerJsApis", "SharedWorkerJsApis"];
const BINDING_CALLS = new Set([
  "constructor",
  "function",
  "accessor",
  "indexed",
  "indexedWithSetterDeleter",
  "namedIndexed",
  "iterator",
  "callable",
  "property",
  "attribute",
]);

/**
 * Scan Koko's structured JsApi declarations without loading or compiling Koko.
 *
 * The scanner intentionally understands only the small, stable declaration
 * language owned by src/core/js/bridge.zig. It uses a tokenizer and balanced
 * delimiter parser so commas and braces inside callbacks, option records, and
 * anonymous structs do not make declarations ambiguous.
 */
export async function scanKokoSource(repositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot);
  const sourceRoot = await findSourceRoot(root, options.sourceRoot);
  const files = await listZigFiles(sourceRoot);
  const contexts = new Map();
  const parsedFiles = [];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const relative = toRepositoryPath(root, file);
    const parsed = parseZigFile(source, relative);
    parsedFiles.push({ file, relative, source, parsed });
    if (relative.endsWith("src/core/js/bridge.zig")) {
      for (const [context, imports] of parseBridgeContexts(source)) {
        for (const imported of imports) {
          const normalized = path.posix.normalize(imported);
          const set = contexts.get(normalized) ?? new Set();
          set.add(context);
          contexts.set(normalized, set);
        }
      }
    }
  }

  const interfaces = [];
  for (const { relative, parsed } of parsedFiles) {
    for (const declaration of parsed.interfaces) {
      const exposure = [...(contexts.get(relative) ?? [])].sort();
      const interfaceRecord = buildInterfaceRecord(declaration, parsed, exposure);
      interfaces.push(interfaceRecord);
    }
  }

  resolvePrototypeChains(interfaces);
  interfaces.sort(compareInterfaces);
  for (const api of interfaces) {
    api.members.sort(compareMembers);
    api.constructors.sort(compareMembers);
  }

  return {
    schemaVersion: 1,
    generator: "koko-static-api-inventory",
    source: "koko",
    sourceRoot: toRepositoryPath(root, sourceRoot),
    interfaceCount: interfaces.length,
    memberCount: interfaces.reduce((total, api) => total + api.members.length, 0),
    interfaces,
  };
}

/**
 * Adapter used by compatibility/cli.mjs. The detailed interface records stay
 * intact while the envelope matches the other inventory producers.
 */
export async function buildKokoInventory({ root, sourceRoot } = {}) {
  const repositoryRoot = path.resolve(root ?? process.cwd());
  const inventory = await scanKokoSource(repositoryRoot, { sourceRoot });
  return {
    ...inventory,
    kind: "koko-inventory",
    source: "koko",
    root: toRepositoryPath(process.cwd(), repositoryRoot),
  };
}

export function scanZigSource(source, sourceFile = "fixture.zig") {
  const parsed = parseZigFile(source, sourceFile);
  const interfaces = parsed.interfaces.map((declaration) =>
    buildInterfaceRecord(declaration, parsed, []),
  );
  resolvePrototypeChains(interfaces);
  interfaces.sort(compareInterfaces);
  for (const api of interfaces) {
    api.members.sort(compareMembers);
    api.constructors.sort(compareMembers);
  }
  return {
    schemaVersion: 1,
    generator: "koko-static-api-inventory",
    source: "koko",
    sourceRoot: ".",
    interfaceCount: interfaces.length,
    memberCount: interfaces.reduce((total, api) => total + api.members.length, 0),
    interfaces,
  };
}

export async function writeInventory(inventory, outputFile) {
  await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await fs.writeFile(outputFile, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

async function findSourceRoot(root, requested) {
  if (requested) {
    const resolved = path.resolve(root, requested);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`Source root is not a directory: ${resolved}`);
    return resolved;
  }
  for (const candidate of [root, path.join(root, "src")]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory() && (candidate === root || path.basename(candidate) === "src")) {
        const nested = path.join(candidate, "core");
        try {
          if ((await fs.stat(nested)).isDirectory()) return candidate;
        } catch {
          // Continue searching the next candidate.
        }
      }
    } catch {
      // Continue searching the next candidate.
    }
  }
  throw new Error(`Could not find a Koko source root below ${root}`);
}

async function listZigFiles(directory) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith(".zig")) result.push(full);
    }
  }
  await visit(directory);
  return result;
}

function parseZigFile(source, sourceFile) {
  const { tokens, comments } = tokenize(source);
  const lineStarts = makeLineStartsFor(source, sourceFile);
  const structs = findStructDeclarations(tokens);
  const interfaces = [];
  const functionDefs = findFunctionDefinitions(tokens, source);

  for (const struct of structs.filter((item) => item.name === "JsApi")) {
    const owner = findOwnerStruct(struct, structs, tokens, sourceFile);
    const meta = parseMeta(tokens, struct.open + 1, struct.close, source);
    const members = parseJsApiMembers(tokens, struct.open + 1, struct.close, source, comments, lineStarts, functionDefs);
    const directSignals = signalsForComments(commentsNear(comments, tokens[struct.start].start, source, 8));
    interfaces.push({
      owner,
      meta,
      members,
      signals: directSignals,
      source: makeLocation(sourceFile, lineStarts, tokens[struct.start].start, tokens[struct.close].end),
      ownerProto: findPrototypeType(owner, structs, tokens, source),
    });
  }

  return { interfaces };
}

function tokenize(source) {
  const tokens = [];
  const comments = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      comments.push({ start, end: index, text: source.slice(start + 2, index) });
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const start = index;
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      comments.push({ start, end: index, text: source.slice(start + 2, end === -1 ? source.length : end) });
      continue;
    }
    if (character === "'") {
      const start = index++;
      let escaped = false;
      while (index < source.length) {
        if (!escaped && source[index] === "'") {
          index += 1;
          break;
        }
        escaped = !escaped && source[index] === "\\";
        if (source[index] !== "\\") escaped = false;
        index += 1;
      }
      tokens.push({ kind: "character", value: source.slice(start, index), start, end: index });
      continue;
    }
    if (character === '"') {
      const start = index++;
      let escaped = false;
      while (index < source.length) {
        if (!escaped && source[index] === '"') {
          index += 1;
          break;
        }
        escaped = !escaped && source[index] === "\\";
        if (source[index] !== "\\") escaped = false;
        index += 1;
      }
      tokens.push({ kind: "string", value: decodeZigString(source.slice(start + 1, index - 1)), start, end: index });
      continue;
    }
    if (character === "@" && source[index + 1] === '"') {
      const start = index;
      const stringStart = index + 2;
      index += 2;
      let escaped = false;
      while (index < source.length) {
        if (!escaped && source[index] === '"') break;
        escaped = !escaped && source[index] === "\\";
        if (source[index] !== "\\") escaped = false;
        index += 1;
      }
      const value = decodeZigString(source.slice(stringStart, index));
      if (index < source.length) index += 1;
      tokens.push({ kind: "identifier", value, start, end: index, quoted: true });
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index), start, end: index });
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9._]/.test(source[index])) index += 1;
      tokens.push({ kind: "number", value: source.slice(start, index), start, end: index });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character, start: index, end: index + 1 });
    index += 1;
  }
  return { tokens, comments };
}

function decodeZigString(value) {
  return value.replace(/\\([\\"nrt])/g, (_, escape) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" }[escape]));
}

function findStructDeclarations(tokens) {
  const declarations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "struct" || tokens[index + 1]?.value !== "{") continue;
    const equals = tokens[index - 1];
    const name = tokens[index - 2];
    if (!equals || equals.value !== "=" || !name || (name.kind !== "identifier" && name.kind !== "string")) continue;
    const close = matchingToken(tokens, index + 1, "{", "}");
    if (close === -1) continue;
    declarations.push({ name: name.value, start: index - 2, open: index + 1, close });
  }
  return declarations;
}

function findOwnerStruct(jsApi, structs, tokens, sourceFile) {
  const containers = structs.filter((item) => item.name !== "JsApi" && item.open < jsApi.start && jsApi.close < item.close);
  if (containers.length) {
    containers.sort((a, b) => (a.close - a.open) - (b.close - b.open));
    return qualifiedStructName(containers[0], containers, tokens);
  }
  for (let index = jsApi.start - 1; index >= 2; index -= 1) {
    if (tokens[index].value === "=" && tokens[index + 1]?.value === "@" && tokens[index + 2]?.value === "This") {
      const name = tokens[index - 1];
      if (name?.kind === "identifier") return name.value;
    }
  }
  return path.basename(sourceFile, ".zig");
}

function qualifiedStructName(struct, allStructs, tokens) {
  const parents = allStructs
    .filter((item) => item !== struct && item.open < struct.start && struct.close < item.close)
    .sort((a, b) => (b.close - b.open) - (a.close - a.open));
  return [...parents.map((item) => item.name), struct.name].join(".");
}

function parseMeta(tokens, start, close, source) {
  const meta = {};
  for (let index = start; index < close; index += 1) {
    if (tokens[index].value !== "const" || tokens[index + 1]?.value !== "Meta") continue;
    const equals = index + 2;
    if (tokens[equals]?.value !== "=") continue;
    const open = tokens[equals + 1]?.value === "struct" && tokens[equals + 2]?.value === "{" ? equals + 2 : -1;
    if (open === -1) continue;
    const metaClose = matchingToken(tokens, open, "{", "}");
    if (metaClose === -1) continue;
    Object.assign(meta, parseMetaFields(tokens, open + 1, metaClose, source));
    break;
  }
  return meta;
}

function parseMetaFields(tokens, start, close, source) {
  const result = {};
  for (let index = start; index < close; index += 1) {
    if (tokens[index].value !== "const") continue;
    const name = tokens[index + 1];
    if (!name || (name.kind !== "identifier" && name.kind !== "string") || tokens[index + 2]?.value !== "=") continue;
    const end = statementEnd(tokens, index + 3, close);
    if (end === -1) continue;
    result[name.value] = parseLiteral(tokens, { start: index + 3, end: end - 1 }, source);
    index = end;
  }
  return result;
}

function parseJsApiMembers(tokens, start, close, source, comments, lineStarts, functionDefs) {
  const members = [];
  let index = start;
  let braceDepth = 0;
  while (index < close) {
    const token = tokens[index];
    if (token.value === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (token.value === "}") {
      braceDepth -= 1;
      index += 1;
      continue;
    }
    if (braceDepth !== 0 || token.value !== "const") {
      index += 1;
      continue;
    }
    const nameToken = tokens[index + 1];
    const equals = tokens[index + 2];
    if (!nameToken || !equals || equals.value !== "=") {
      index += 1;
      continue;
    }
    const end = statementEnd(tokens, index + 3, close);
    if (end === -1) break;
    const parsedName = nameToken.kind === "identifier" || nameToken.kind === "string" ? nameToken.value : null;
    if (parsedName && parsedName !== "Meta" && parsedName !== "bridge") {
      const member = parseBindingMember(parsedName, tokens, index, end, source, comments, lineStarts, functionDefs);
      if (member) members.push(member);
    }
    index = end + 1;
  }
  return members;
}

function parseBindingMember(name, tokens, declarationStart, statementEndIndex, source, comments, lineStarts, functionDefs) {
  const call = findBindingCall(tokens, declarationStart + 1, statementEndIndex);
  if (!call) return null;
  const args = splitArguments(tokens, call.open + 1, call.close);
  const options = args.length ? parseOptionsArgument(tokens, args[args.length - 1], source) : {};
  const binding = {
    factory: `bridge.${call.method}`,
    target: args.length ? sliceTokens(source, tokens, args[0]) : null,
    options: sortedObject(options),
  };
  if (call.method === "accessor") {
    binding.getter = args[0] ? sliceTokens(source, tokens, args[0]) : null;
    binding.setter = args[1] ? sliceTokens(source, tokens, args[1]) : null;
    binding.static = options.static === true;
    binding.deletable = options.deletable !== false;
  } else if (call.method === "constructor") {
    binding.arity = inferArity(binding.target, functionDefs, options, true);
  } else if (call.method === "function") {
    binding.static = options.static === true;
    binding.arity = inferArity(binding.target, functionDefs, options, binding.static);
  } else if (call.method === "property" || call.method === "attribute") {
    binding.value = args[0] ? parseLiteral(tokens, args[0], source) : null;
  } else if (call.method === "indexed" || call.method === "indexedWithSetterDeleter" || call.method === "namedIndexed") {
    binding.targets = args.slice(0, -1).map((range) => sliceTokens(source, tokens, range));
  }

  const nearby = commentsNear(comments, tokens[declarationStart].start, source, 5);
  const signals = signalsForComments(nearby);
  if (options.noop === true) signals.noop = true;
  if (options.wpt_only === true) signals.wptOnly = true;
  const effectiveName = typeof options.js_name === "string" ? options.js_name : name;
  return {
    id: `koko:member:${effectiveName}`,
    name: effectiveName,
    declaredName: name,
    kind: memberKind(call.method),
    source: makeLocation(lineStarts.sourceFile ?? "fixture.zig", lineStarts, tokens[declarationStart].start, tokens[statementEndIndex].end),
    binding,
    signals,
  };
}

function findBindingCall(tokens, start, end) {
  for (let index = start; index < end - 2; index += 1) {
    if (tokens[index].value !== "bridge" || tokens[index + 1]?.value !== ".") continue;
    const method = tokens[index + 2]?.value;
    if (!BINDING_CALLS.has(method) || tokens[index + 3]?.value !== "(") continue;
    const close = matchingToken(tokens, index + 3, "(", ")");
    if (close !== -1 && close <= end) return { method, open: index + 3, close };
  }
  return null;
}

function splitArguments(tokens, start, close) {
  const ranges = [];
  let begin = start;
  const stack = [];
  for (let index = start; index < close; index += 1) {
    const value = tokens[index].value;
    if (value === "(" || value === "{" || value === "[") stack.push(value);
    else if (value === ")" || value === "}" || value === "]") stack.pop();
    else if (value === "," && stack.length === 0) {
      ranges.push({ start: begin, end: index - 1 });
      begin = index + 1;
    }
  }
  if (begin < close) ranges.push({ start: begin, end: close - 1 });
  return ranges.filter((range) => range.start <= range.end);
}

function parseOptionsArgument(tokens, range, source) {
  if (!range) return {};
  const first = tokens[range.start];
  if (first?.value !== "." || tokens[range.start + 1]?.value !== "{") return {};
  const open = range.start + 1;
  const close = matchingToken(tokens, open, "{", "}");
  if (close === -1 || close > range.end) return {};
  return parseOptionFields(tokens, open + 1, close, source);
}

function parseOptionFields(tokens, start, close, source) {
  const result = {};
  for (const range of splitArguments(tokens, start, close)) {
    const dot = range.start;
    const key = tokens[dot]?.value === "." ? tokens[dot + 1]?.value : null;
    if (!key || tokens[dot + 2]?.value !== "=") continue;
    const valueRange = { start: dot + 3, end: range.end };
    result[key] = parseLiteral(tokens, valueRange, source);
  }
  return result;
}

function parseLiteral(tokens, range, source) {
  if (!range || range.start > range.end) return null;
  const first = tokens[range.start];
  if (range.start === range.end) {
    if (first.kind === "string") return first.value;
    if (first.value === "true") return true;
    if (first.value === "false") return false;
    if (first.value === "null") return null;
    if (first.kind === "number") return parseNumber(first.value);
  }
  if (first.value === "." && tokens[range.start + 1]?.value === "{") {
    const close = matchingToken(tokens, range.start + 1, "{", "}");
    if (close !== -1 && close <= range.end) return sortedObject(parseOptionFields(tokens, range.start + 2, close, source));
  }
  return sliceTokens(source, tokens, range);
}

function parseNumber(value) {
  const parsed = Number(value.replace(/_/g, ""));
  return Number.isFinite(parsed) ? parsed : value;
}

function findFunctionDefinitions(tokens, source) {
  const definitions = new Map();
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].value !== "fn") continue;
    const name = tokens[index + 1]?.value;
    const open = index + 2;
    if (!name || tokens[open]?.value !== "(") continue;
    const close = matchingToken(tokens, open, "(", ")");
    if (close === -1) continue;
    const entries = splitArguments(tokens, open + 1, close);
    const list = definitions.get(name) ?? [];
    list.push({ entries, tokens, source });
    definitions.set(name, list);
  }
  return definitions;
}

function inferArity(target, functionDefs, options, staticMember) {
  if (typeof options.length === "number") return { value: options.length, source: "binding-option" };
  if (!target) return { value: null, source: "unknown" };
  const match = target.match(/(?:^|\.)([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  if (!match) return { value: null, source: "unknown" };
  const definitions = functionDefs.get(match[1]);
  if (!definitions?.length) return { value: null, source: "unknown" };
  const params = definitions[definitions.length - 1].entries;
  const start = staticMember ? 0 : 1;
  let count = 0;
  for (const range of params.slice(start)) {
    const sourceTokens = definitions[0].tokens.slice(range.start, range.end + 1);
    const text = sourceTokens.map((token) => token.value).join(" ");
    if (text.includes("?") || /\b(?:Frame|Page|Execution|Session)\b/.test(text)) break;
    count += 1;
  }
  return { value: count, source: "zig-signature" };
}

function findPrototypeType(owner, structs, tokens, source) {
  const ownerName = owner.split(".").at(-1);
  const struct = structs.find((item) => item.name === ownerName);
  if (!struct) return null;
  for (let index = struct.open + 1; index < struct.close; index += 1) {
    if (tokens[index].value !== "_proto" || tokens[index + 1]?.value !== ":") continue;
    const end = tokens.slice(index + 2, struct.close).findIndex((token) => token.value === "," || token.value === ";");
    if (end === -1) continue;
    const typeTokens = tokens.slice(index + 2, index + 2 + end).map((token) => token.value);
    return typeTokens.filter((value) => value !== "*" && value !== "const").at(-1) ?? null;
  }
  return null;
}

function buildInterfaceRecord(declaration, parsed, exposure) {
  const interfaceName = declaration.meta.name ?? declaration.owner.split(".").at(-1);
  const qualifiedName = declaration.owner;
  const members = [];
  const constructors = [];
  for (const member of declaration.members) {
    const record = {
      ...member,
      id: `koko:member:${declaration.source.file}:${qualifiedName}.${member.name}`,
    };
    if (record.kind === "constructor") constructors.push(record);
    else members.push(record);
  }
  const contextExposure = exposure.map((context) => ({
    PageJsApis: "Window",
    WorkerJsApis: "DedicatedWorker",
    SharedWorkerJsApis: "SharedWorker",
  }[context] ?? context));
  return {
    id: `koko:interface:${declaration.source.file}:${qualifiedName}`,
    name: interfaceName,
    qualifiedName,
    source: declaration.source,
    exposure: [...new Set(contextExposure)].sort(),
    meta: sortedObject(declaration.meta),
    prototypeChain: [interfaceName],
    constructors,
    members,
    signals: declaration.signals,
    binding: {
      ownerType: declaration.owner,
      prototypeType: declaration.ownerProto,
      registrationLists: exposure,
    },
  };
}

function resolvePrototypeChains(interfaces) {
  const byName = new Map();
  for (const api of interfaces) {
    byName.set(api.name, api);
    byName.set(api.qualifiedName, api);
  }
  for (const api of interfaces) {
    const chain = [api.name];
    let parent = api.binding.prototypeType;
    const seen = new Set(chain);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      chain.push(byName.get(parent)?.name ?? parent);
      parent = byName.get(parent)?.binding.prototypeType ?? null;
    }
    api.prototypeChain = chain;
  }
}

function parseBridgeContexts(source) {
  const { tokens } = tokenize(source);
  const results = new Map();
  for (const context of BRIDGE_CONTEXTS) {
    const declaration = tokens.findIndex((token, index) => token.value === context && tokens[index + 1]?.value === "=");
    if (declaration === -1) continue;
    const callOpen = tokens.findIndex((token, index) => index > declaration && token.value === "(" && tokens[index - 1]?.value === "flattenTypes");
    const open = callOpen === -1
      ? -1
      : tokens.findIndex((token, index) => index > callOpen && token.value === "{");
    if (open === -1) continue;
    const close = matchingToken(tokens, open, "{", "}");
    if (close === -1) continue;
    const imports = [];
    for (let index = declaration; index <= close; index += 1) {
      if (tokens[index].value !== "@" || tokens[index + 1]?.value !== "import") continue;
      const stringToken = tokens[index + 2]?.kind === "string" ? tokens[index + 2] : tokens[index + 3];
      if (stringToken?.kind === "string") {
        imports.push(resolveBridgeImport(stringToken.value));
      }
    }
    results.set(context, imports);
  }
  return results;
}

function resolveBridgeImport(importPath) {
  const joined = path.posix.normalize(path.posix.join("src/core/js", importPath));
  return joined.replace(/^\.\//, "");
}

function commentsNear(comments, offset, source, maxLines) {
  const line = source.slice(0, offset).split("\n").length;
  return comments.filter((comment) => {
    if (comment.end > offset) return false;
    const commentLine = source.slice(0, comment.start).split("\n").length;
    return line - commentLine <= maxLines;
  });
}

function signalsForComments(comments) {
  const notes = [];
  let noop = false;
  let wptOnly = false;
  let unsupported = false;
  for (const comment of comments) {
    const text = comment.text.trim().replace(/\s+/g, " ");
    const lower = text.toLowerCase();
    if (/\bnoop\b/.test(lower)) {
      noop = true;
      notes.push(text);
    }
    if (/wpt[\s_-]*only|testdriver|web platform test/.test(lower)) {
      wptOnly = true;
      notes.push(text);
    }
    if (/unsupported|not supported|not implemented|excluded by design|omitted/.test(lower)) {
      unsupported = true;
      notes.push(text);
    }
  }
  return {
    noop,
    wptOnly,
    unsupported,
    notes: [...new Set(notes)].sort(),
  };
}

function memberKind(factory) {
  if (factory === "constructor") return "constructor";
  if (factory === "function") return "operation";
  if (factory === "accessor" || factory === "attribute") return "attribute";
  if (factory === "property") return "constant";
  if (factory === "iterator") return "iterator";
  if (factory === "callable") return "callable";
  return factory;
}

function statementEnd(tokens, start, close) {
  const stack = [];
  for (let index = start; index < close; index += 1) {
    const value = tokens[index].value;
    if (value === "(" || value === "{" || value === "[") stack.push(value);
    else if (value === ")" || value === "}" || value === "]") stack.pop();
    else if (value === ";" && stack.length === 0) return index;
  }
  return -1;
}

function matchingToken(tokens, open, opening, closing) {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].value === opening) depth += 1;
    else if (tokens[index].value === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function sliceTokens(source, tokens, range) {
  if (!range || range.start > range.end) return null;
  return source.slice(tokens[range.start].start, tokens[range.end].end).trim().replace(/\s+/g, " ");
}

function makeLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  starts.sourceFile = "fixture.zig";
  return starts;
}

function makeLocation(sourceFile, lineStarts, start, end) {
  const locate = (offset) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };
  return { file: sourceFile, start: locate(start), end: locate(end) };
}

function makeLineStartsFor(source, sourceFile) {
  const starts = makeLineStarts(source);
  starts.sourceFile = sourceFile;
  return starts;
}

function compareInterfaces(a, b) {
  return a.name.localeCompare(b.name) || a.qualifiedName.localeCompare(b.qualifiedName) || a.source.file.localeCompare(b.source.file);
}

function compareMembers(a, b) {
  return a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind) || a.source.start.line - b.source.start.line;
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function toRepositoryPath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? null : args[outputIndex + 1];
  const positional = args.filter((arg, index) => arg !== "--output" && index !== outputIndex + 1);
  const root = positional[0] ?? process.cwd();
  try {
    const inventory = await scanKokoSource(root);
    if (output) await writeInventory(inventory, output);
    else process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

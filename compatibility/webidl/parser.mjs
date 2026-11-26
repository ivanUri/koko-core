import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { sourceRef, stableId } from "../lib/model.mjs";

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (comment) => " ".repeat(comment.length));
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    const start = index;
    const ch = source[index];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === quote) { index += 1; break; }
        index += 1;
      }
      tokens.push({ value: source.slice(start, index), start });
      continue;
    }
    const match = source.slice(index).match(/^(?:[A-Za-z_$][\w$-]*|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/);
    if (match) {
      index += match[0].length;
      tokens.push({ value: match[0], start });
      continue;
    }
    if (source.startsWith("...", index)) { tokens.push({ value: "...", start }); index += 3; continue; }
    tokens.push({ value: ch, start });
    index += 1;
  }
  return tokens;
}

function joinTokens(tokens) {
  let output = "";
  for (const token of tokens) {
    if (!output || "<>,;=()[]?".includes(token.value) || "<>,;=()[]?".includes(output.at(-1))) output += token.value;
    else output += ` ${token.value}`;
  }
  return output;
}

function matching(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    if (tokens[index].value === close && --depth === 0) return index;
  }
  return -1;
}

function parseExtended(tokens, index) {
  if (tokens[index]?.value !== "[") return { attrs: [], index };
  const end = matching(tokens, index, "[", "]");
  if (end < 0) throw new Error("Unclosed WebIDL extended attribute list");
  const attrs = [];
  let cursor = index + 1;
  while (cursor < end) {
    const name = tokens[cursor++].value;
    const attr = { name };
    if (tokens[cursor]?.value === "(") {
      const close = matching(tokens, cursor, "(", ")");
      attr.arguments = joinTokens(tokens.slice(cursor + 1, close));
      cursor = close + 1;
    } else if (["=", "["] .includes(tokens[cursor]?.value)) {
      attr.value = tokens[cursor + 1]?.value ?? null;
      cursor += tokens[cursor].value === "[" ? 3 : 2;
    }
    attrs.push(attr);
    if (tokens[cursor]?.value === ",") cursor += 1;
  }
  return { attrs, index: end + 1 };
}

function parseArguments(tokens) {
  const args = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    let optional = false;
    if (tokens[cursor]?.value === "optional") { optional = true; cursor += 1; }
    let variadic = false;
    const start = cursor;
    let angle = 0;
    while (cursor < tokens.length && (tokens[cursor].value !== "," || angle > 0)) {
      if (tokens[cursor].value === "<") angle += 1;
      if (tokens[cursor].value === ">") angle -= 1;
      cursor += 1;
    }
    const part = tokens.slice(start, cursor);
    if (part.at(-1)?.value === "...") { variadic = true; part.pop(); }
    const equal = part.findIndex((token) => token.value === "=");
    const beforeDefault = equal >= 0 ? part.slice(0, equal) : part;
    const nameToken = beforeDefault.at(-1);
    if (!nameToken) break;
    args.push({
      name: nameToken.value,
      type: joinTokens(beforeDefault.slice(0, -1)),
      optional,
      variadic,
      default: equal >= 0 ? joinTokens(part.slice(equal + 1)) : null,
    });
    if (tokens[cursor]?.value === ",") cursor += 1;
  }
  return args;
}

function parseMember(tokens, file, source) {
  if (tokens.length === 0) return null;
  const raw = joinTokens(tokens);
  const member = { raw, source: sourceRef(file, lineAt(source, tokens[0].start)) };
  let cursor = 0;
  const modifiers = new Set();
  while (["static", "readonly", "inherit", "required", "stringifier", "serializer", "getter", "setter", "deleter", "legacycaller", "async"].includes(tokens[cursor]?.value)) {
    modifiers.add(tokens[cursor++].value);
  }
  member.static = modifiers.has("static");
  member.modifiers = [...modifiers].sort();
  if (tokens[cursor]?.value === "const") {
    const name = tokens[cursor + 2]?.value;
    const equal = tokens.findIndex((token) => token.value === "=");
    return { ...member, kind: "constant", name, type: tokens[cursor + 1]?.value ?? "", value: equal >= 0 ? joinTokens(tokens.slice(equal + 1)) : null };
  }
  if (tokens[cursor]?.value === "constructor") {
    const open = tokens.findIndex((token) => token.value === "(");
    const close = open >= 0 ? matching(tokens, open, "(", ")") : -1;
    return { ...member, kind: "constructor", name: "constructor", arguments: parseArguments(tokens.slice(open + 1, close)) };
  }
  if (["iterable", "async", "maplike", "setlike"].includes(tokens[cursor]?.value) || raw.startsWith("async iterable")) {
    const open = tokens.findIndex((token) => token.value === "<");
    const close = open >= 0 ? matching(tokens, open, "<", ">") : -1;
    return { ...member, kind: tokens[cursor]?.value === "iterable" ? "iterable" : tokens[cursor]?.value, type: open >= 0 ? joinTokens(tokens.slice(open + 1, close)) : null };
  }
  if (!tokens.some((token) => token.value === "(") && !tokens.some((token) => token.value === "attribute")) {
    const equal = tokens.findIndex((token) => token.value === "=");
    const end = equal >= 0 ? equal : tokens.length;
    const nameToken = tokens[end - 1];
    if (nameToken) {
      return { ...member, kind: "dictionary-member", name: nameToken.value, type: joinTokens(tokens.slice(cursor, end - 1)), required: modifiers.has("required"), default: equal >= 0 ? joinTokens(tokens.slice(equal + 1)) : null };
    }
  }
  const attributeIndex = tokens.findIndex((token) => token.value === "attribute");
  if (attributeIndex >= 0) {
    const name = tokens.at(-1)?.value;
    return { ...member, kind: "attribute", name, type: joinTokens(tokens.slice(attributeIndex + 1, -1)), readonly: modifiers.has("readonly") };
  }
  const open = tokens.findIndex((token) => token.value === "(");
  if (open >= 0) {
    const close = matching(tokens, open, "(", ")");
    const name = tokens[open - 1]?.value;
    return { ...member, kind: "operation", name, returnType: joinTokens(tokens.slice(cursor, open - 1)), arguments: parseArguments(tokens.slice(open + 1, close)) };
  }
  return { ...member, kind: "unknown", name: tokens.at(-1)?.value ?? null };
}

function parseMembers(tokens, file, source) {
  const members = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (["(", "<", "["].includes(value)) depth += 1;
    if ([")", ">", "]"].includes(value)) depth -= 1;
    if (index === tokens.length || (value === ";" && depth === 0)) {
      const member = parseMember(tokens.slice(start, index), file, source);
      if (member) members.push(member);
      start = index + 1;
    }
  }
  return members;
}

export function parseWebIDL(source, file = "inline.webidl") {
  const cleaned = stripComments(source);
  const tokens = tokenize(cleaned);
  const definitions = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const extended = parseExtended(tokens, cursor);
    cursor = extended.index;
    const startToken = tokens[cursor];
    if (!startToken) break;
    let partial = false;
    if (tokens[cursor]?.value === "partial") { partial = true; cursor += 1; }
    if (tokens[cursor]?.value === "callback" && tokens[cursor + 1]?.value === "interface") {
      cursor += 2;
      const name = tokens[cursor++].value;
      const inherited = tokens[cursor]?.value === ":" ? tokens[cursor + 1]?.value ?? null : null;
      if (tokens[cursor]?.value === ":") cursor += 2;
      const open = tokens.findIndex((token, index) => index >= cursor && token.value === "{");
      const close = open >= 0 ? matching(tokens, open, "{", "}") : -1;
      definitions.push({ kind: "callback-interface", name, partial, inherited, members: parseMembers(tokens.slice(open + 1, close), file, source), extendedAttributes: extended.attrs, source: sourceRef(file, lineAt(source, startToken.start)) });
      cursor = close + 1;
      continue;
    }
    if (tokens[cursor]?.value === "callback") {
      const name = tokens[cursor + 1]?.value;
      const open = tokens.findIndex((token, index) => index >= cursor && token.value === "(");
      const close = open >= 0 ? matching(tokens, open, "(", ")") : -1;
      const equals = tokens.findIndex((token, index) => index > cursor + 1 && token.value === "=");
      const equal = tokens.findIndex((token, index) => index >= close && token.value === "=");
      definitions.push({ kind: "callback", name, returnType: joinTokens(tokens.slice(equals >= 0 ? equals + 1 : cursor + 2, open)), arguments: parseArguments(tokens.slice(open + 1, close)), default: equal >= 0 ? tokens[equal + 1]?.value : null, extendedAttributes: extended.attrs, source: sourceRef(file, lineAt(source, startToken.start)) });
      cursor = tokens.findIndex((token, index) => index > close && token.value === ";") + 1;
      continue;
    }
    const keyword = tokens[cursor]?.value;
    if (!["interface", "namespace", "dictionary", "enum", "typedef"].includes(keyword)) {
      const semi = tokens.findIndex((token, index) => index >= cursor && token.value === ";");
      cursor = semi >= 0 ? semi + 1 : tokens.length;
      continue;
    }
    if (keyword === "enum") {
      const name = tokens[cursor + 1]?.value;
      const open = tokens.findIndex((token, index) => index > cursor && token.value === "{");
      const close = open >= 0 ? matching(tokens, open, "{", "}") : -1;
      const values = tokens.slice(open + 1, close).filter((token) => token.value !== ",").map((token) => token.value.replace(/^['"]|['"]$/g, ""));
      definitions.push({ kind: "enum", name, values, extendedAttributes: extended.attrs, source: sourceRef(file, lineAt(source, startToken.start)) });
      cursor = close + 1;
      continue;
    }
    if (keyword === "typedef") {
      const semi = tokens.findIndex((token, index) => index > cursor && token.value === ";");
      const part = tokens.slice(cursor + 1, semi);
      definitions.push({ kind: "typedef", name: part.at(-1)?.value, type: joinTokens(part.slice(0, -1)), extendedAttributes: extended.attrs, source: sourceRef(file, lineAt(source, startToken.start)) });
      cursor = semi + 1;
      continue;
    }
    const mixin = keyword === "interface" && tokens[cursor + 1]?.value === "mixin";
    const name = tokens[cursor + (mixin ? 2 : 1)]?.value;
    let afterName = cursor + (mixin ? 3 : 2);
    let inherited = null;
    if (tokens[afterName]?.value === ":") { inherited = tokens[afterName + 1]?.value ?? null; afterName += 2; }
    const open = tokens.findIndex((token, index) => index >= afterName && token.value === "{");
    const close = open >= 0 ? matching(tokens, open, "{", "}") : -1;
    definitions.push({ kind: mixin ? "interface-mixin" : keyword, name, partial, inherited, members: parseMembers(tokens.slice(open + 1, close), file, source), extendedAttributes: extended.attrs, source: sourceRef(file, lineAt(source, startToken.start)) });
    cursor = close + 1;
    if (!mixin && tokens[cursor]?.value === "includes") cursor += 1;
  }
  return definitions;
}

export function parseIncludes(source, file = "inline.webidl") {
  const tokens = tokenize(stripComments(source));
  const includes = [];
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (tokens[index + 1]?.value === "includes" && tokens[index + 3]?.value === ";") {
      includes.push({ target: tokens[index].value, mixin: tokens[index + 2].value, source: sourceRef(file, lineAt(source, tokens[index].start)) });
    }
  }
  return includes;
}

export async function parseWebIDLFile(file, root = process.cwd()) {
  const source = await readFile(file, "utf8");
  const relativeFile = relative(root, file) || basename(file);
  return { file: relativeFile, definitions: parseWebIDL(source, relativeFile), includes: parseIncludes(source, relativeFile) };
}

export { joinTokens, stableId };

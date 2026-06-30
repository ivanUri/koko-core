/** Playwright-style locator query descriptors resolved at action time via Runtime.evaluate. */

export type LocatorQuery =
  | { kind: "css"; selector: string }
  | { kind: "role"; role: string; name?: string | RegExp; exact?: boolean }
  | { kind: "text"; text: string | RegExp; exact?: boolean }
  | { kind: "label"; text: string | RegExp; exact?: boolean }
  | { kind: "placeholder"; text: string | RegExp; exact?: boolean }
  | { kind: "alt"; text: string | RegExp; exact?: boolean }
  | { kind: "title"; text: string | RegExp; exact?: boolean }
  | { kind: "testId"; testId: string | RegExp };

export interface LocatorResolveOptions {
  /** 0-based index when multiple elements match (default: 0 = first). */
  index?: number;
  /** When true, fail if more than one element matches. */
  strict?: boolean;
}

const IMPLICIT_ROLE: Record<string, string> = {
  a: "link",
  button: "button",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  img: "img",
  input: "textbox",
  select: "combobox",
  textarea: "textbox",
};

function serializePattern(value: string | RegExp): { source: string; flags?: string } {
  if (typeof value === "string") return { source: value };
  return { source: value.source, flags: value.flags || undefined };
}

function serializeQueries(queries: LocatorQuery[]): unknown[] {
  return queries.map((q) => {
    if (q.kind === "role") {
      return { ...q, name: q.name != null ? serializePattern(q.name) : undefined };
    }
    if (q.kind === "text" || q.kind === "label" || q.kind === "placeholder" || q.kind === "alt" || q.kind === "title") {
      return { ...q, text: serializePattern(q.text) };
    }
    if (q.kind === "testId") {
      return { ...q, testId: serializePattern(q.testId) };
    }
    return q;
  });
}

const RESOLVER_HELPERS = `
function toRegex(spec) {
  if (!spec || typeof spec.source !== 'string') return null;
  return new RegExp(spec.source, spec.flags || '');
}
function textMatch(haystack, spec, exact) {
  const value = (haystack ?? '').trim();
  if (!spec) return true;
  if (typeof spec === 'string') return exact ? value === spec : value.includes(spec);
  const re = toRegex(spec);
  return re ? re.test(value) : false;
}
function accessibleName(el) {
  const labelled = el.getAttribute('aria-label')
    || (el.id ? (document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent) : null)
    || el.getAttribute('placeholder')
    || el.getAttribute('title')
    || el.getAttribute('alt')
    || el.textContent;
  return (labelled ?? '').trim();
}
function roleOf(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  }
  return cfg.implicitRole[tag] || tag;
}
function isVisible(el) {
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}
function queryAll(query) {
  if (query.kind === 'css') return [...document.querySelectorAll(query.selector)];
  if (query.kind === 'role') {
    const nodes = [...document.querySelectorAll('[role], a, button, h1, h2, h3, h4, h5, h6, img, input, select, textarea')];
    return nodes.filter((el) => {
      if (roleOf(el) !== query.role) return false;
      if (query.name == null) return true;
      return textMatch(accessibleName(el), query.name, query.exact ?? false);
    });
  }
  if (query.kind === 'text') {
    return [...document.querySelectorAll('body *')].filter((el) => textMatch(el.textContent, query.text, query.exact ?? false));
  }
  if (query.kind === 'label') {
    const labels = [...document.querySelectorAll('label')];
    const matched = labels.filter((el) => textMatch(el.textContent, query.text, query.exact ?? false));
    const out = [];
    for (const label of matched) {
      const id = label.getAttribute('for');
      if (id) {
        const target = document.getElementById(id);
        if (target) out.push(target);
      } else {
        const nested = label.querySelector('input, select, textarea, button');
        if (nested) out.push(nested);
      }
    }
    return out;
  }
  if (query.kind === 'placeholder') {
    return [...document.querySelectorAll('[placeholder]')].filter((el) =>
      textMatch(el.getAttribute('placeholder'), query.text, query.exact ?? false));
  }
  if (query.kind === 'alt') {
    return [...document.querySelectorAll('[alt]')].filter((el) =>
      textMatch(el.getAttribute('alt'), query.text, query.exact ?? false));
  }
  if (query.kind === 'title') {
    return [...document.querySelectorAll('[title]')].filter((el) =>
      textMatch(el.getAttribute('title'), query.text, query.exact ?? false));
  }
  if (query.kind === 'testId') {
    return [...document.querySelectorAll('[data-testid]')].filter((el) =>
      textMatch(el.getAttribute('data-testid'), query.testId, true));
  }
  return [];
}
function resolveNodes() {
  let nodes = queryAll(cfg.queries[0]);
  for (let i = 1; i < cfg.queries.length; i++) {
    const subset = new Set(queryAll(cfg.queries[i]));
    nodes = nodes.filter((n) => subset.has(n));
  }
  return nodes.filter(isVisible);
}
`;

function buildCfgLiteral(queries: LocatorQuery[], options: LocatorResolveOptions = {}): string {
  return JSON.stringify({
    queries: serializeQueries(queries),
    index: options.index ?? 0,
    strict: options.strict ?? false,
    implicitRole: IMPLICIT_ROLE,
  });
}

/** Build a self-contained IIFE that returns the matched element or throws. */
export function buildResolveExpression(queries: LocatorQuery[], options: LocatorResolveOptions = {}): string {
  const cfg = buildCfgLiteral(queries, options);
  return `(() => {
    const cfg = ${cfg};
    ${RESOLVER_HELPERS}
    const nodes = resolveNodes();
    if (cfg.strict && nodes.length > 1) {
      throw new Error('strict mode violation: locator resolved to ' + nodes.length + ' elements');
    }
    const idx = cfg.index < 0 ? nodes.length + cfg.index : cfg.index;
    const el = nodes[idx];
    if (!el) throw new Error('locator resolved to 0 elements');
    return el;
  })()`;
}

/** Count expression for locator.count(). */
export function buildCountExpression(queries: LocatorQuery[]): string {
  const cfg = buildCfgLiteral(queries);
  return `(() => {
    const cfg = ${cfg};
    ${RESOLVER_HELPERS}
    return resolveNodes().length;
  })()`;
}
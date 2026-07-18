/**
 * Build detailed A/B comparison markdown + JSON from two capture metas.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function setDiff(a = [], b = []) {
  const A = new Set(a);
  const B = new Set(b);
  return {
    onlyA: [...A].filter((x) => !B.has(x)).sort(),
    onlyB: [...B].filter((x) => !A.has(x)).sort(),
    both: [...A].filter((x) => B.has(x)).sort(),
  };
}

function orderLcs(a = [], b = []) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function firstHop(meta, name) {
  const hops = meta?.wireHops || [];
  return hops.find((h) => h.hop === name) || hops[0] || null;
}

function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

/**
 * @param {{ okDir: string, failDir: string, outDir: string, query: string }} opts
 */
export function buildReport(opts) {
  const ok = loadJson(join(opts.okDir, "meta.json"));
  const fail = loadJson(join(opts.failDir, "meta.json"));
  const okWire = loadJson(join(opts.okDir, "wire-summary.json")) || [];
  const failWire = loadJson(join(opts.failDir, "wire-summary.json")) || [];

  const okHop1 = firstHop(ok, "initial") || okWire.find((w) => w.hop === "initial");
  const failHop1 =
    firstHop(fail, "initial") || failWire.find((w) => w.hop === "initial");
  const okSei = firstHop(ok, "sei") || okWire.find((w) => w.hop === "sei");
  const failSei = firstHop(fail, "sei") || failWire.find((w) => w.hop === "sei");

  const cookieDiff = setDiff(okHop1?.cookieNames || [], failHop1?.cookieNames || []);
  const headerOrderOk = okHop1?.headerOrderNorm || [];
  const headerOrderFail = failHop1?.headerOrderNorm || [];
  const orderScore = orderLcs(headerOrderOk, headerOrderFail);

  const comparisons = {
    tier: { ok: ok?.tier, fail: fail?.tier },
    htmlLen: { ok: ok?.htmlLen ?? ok?.snapshot?.htmlLen, fail: fail?.htmlLen ?? fail?.snapshot?.htmlLen },
    bodyLen: {
      ok: ok?.snapshot?.bodyLen,
      fail: fail?.snapshot?.bodyLen,
    },
    finalHref: {
      ok: ok?.snapshot?.href,
      fail: fail?.snapshot?.href,
    },
    title: {
      ok: ok?.snapshot?.title,
      fail: fail?.snapshot?.title,
    },
    signals: {
      ok: ok?.snapshot?.signals,
      fail: fail?.snapshot?.signals,
    },
    markers: {
      ok: ok?.snapshot?.markers,
      fail: fail?.snapshot?.markers,
    },
    resultCount: {
      ok: ok?.snapshot?.results?.length ?? 0,
      fail: fail?.snapshot?.results?.length ?? 0,
    },
    jarBefore: {
      ok: ok?.jarBefore,
      fail: fail?.jarBefore,
    },
    wireHopCount: {
      ok: ok?.wireHopCount,
      fail: fail?.wireHopCount,
    },
    hop1CookieBytes: {
      ok: okHop1?.cookieBytes ?? 0,
      fail: failHop1?.cookieBytes ?? 0,
    },
    hop1CookieNames: cookieDiff,
    hop1HeaderOrder: {
      ok: headerOrderOk,
      fail: headerOrderFail,
      lcs: orderScore,
      same:
        JSON.stringify(headerOrderOk) === JSON.stringify(headerOrderFail),
    },
    hop1SecFetch: {
      ok: {
        site: okHop1?.secFetchSite,
        user: okHop1?.secFetchUser,
        dest: okHop1?.secFetchDest,
        mode: okHop1?.secFetchMode,
      },
      fail: {
        site: failHop1?.secFetchSite,
        user: failHop1?.secFetchUser,
        dest: failHop1?.secFetchDest,
        mode: failHop1?.secFetchMode,
      },
    },
    hop1NetworkEstimates: {
      ok: { downlink: okHop1?.downlink, rtt: okHop1?.rtt },
      fail: { downlink: failHop1?.downlink, rtt: failHop1?.rtt },
    },
    hops: {
      ok: ok?.wireHops,
      fail: fail?.wireHops,
    },
    cdpDocResponses: {
      ok: ok?.cdpDocumentResponses,
      fail: fail?.cdpDocumentResponses,
    },
    seiPresent: {
      ok: !!okSei,
      fail: !!failSei,
    },
  };

  // Hypotheses ranked
  const findings = [];
  if ((okHop1?.cookieBytes || 0) > 500 && (failHop1?.cookieBytes || 0) < 100) {
    findings.push({
      severity: "critical",
      id: "hop1_cookie_bytes",
      title: "Hop-1 Cookie header size differs drastically",
      detail: `OK=${okHop1?.cookieBytes}B names=${(okHop1?.cookieNames||[]).join(",")} | FAIL=${failHop1?.cookieBytes}B names=${(failHop1?.cookieNames||[]).join(",")}`,
    });
  }
  if (cookieDiff.onlyA.includes("SID") || cookieDiff.onlyA.includes("__Secure-1PSID")) {
    findings.push({
      severity: "critical",
      id: "session_cookies_missing_on_fail",
      title: "Mature session cookies only on OK hop-1",
      detail: `Only on OK: ${cookieDiff.onlyA.join(", ")}`,
    });
  }
  if ((ok?.htmlLen || 0) > 200_000 && (fail?.htmlLen || 0) < 100_000) {
    findings.push({
      severity: "critical",
      id: "html_tier",
      title: "Response body size indicates different server HTML tier",
      detail: `OK htmlLen=${ok?.htmlLen} (SERP-scale) vs FAIL htmlLen=${fail?.htmlLen} (bootstrap/sorry-scale)`,
    });
  }
  if (ok?.tier === "SERP" && fail?.tier === "sorry") {
    findings.push({
      severity: "critical",
      id: "tier_serp_vs_sorry",
      title: "OK lands SERP; FAIL lands /sorry",
      detail: `final href FAIL: ${(fail?.snapshot?.href || "").slice(0, 120)}`,
    });
  }
  if ((fail?.wireHopCount || 0) > (ok?.wireHopCount || 0)) {
    findings.push({
      severity: "high",
      id: "extra_hops",
      title: "FAIL path uses more search document hops",
      detail: `OK hops=${ok?.wireHopCount} FAIL hops=${fail?.wireHopCount}`,
    });
  }
  if (comparisons.hop1HeaderOrder.same) {
    findings.push({
      severity: "info",
      id: "header_order_same",
      title: "Hop-1 header *order* is essentially the same",
      detail: "Difference is not primarily Accept/Sec-Fetch ordering",
    });
  } else {
    // Cookie is inserted after Accept-Language — order delta is often only that.
    const okNoCookie = headerOrderOk.filter((n) => n !== "cookie" && n !== "host");
    const failNoCookie = headerOrderFail.filter((n) => n !== "cookie" && n !== "host");
    const sameSansCookie =
      JSON.stringify(okNoCookie) === JSON.stringify(failNoCookie);
    findings.push({
      severity: sameSansCookie ? "info" : "medium",
      id: sameSansCookie ? "header_order_only_cookie" : "header_order_diff",
      title: sameSansCookie
        ? "Hop-1 header order matches aside from Cookie presence"
        : "Hop-1 header order differs beyond Cookie",
      detail: `LCS=${orderScore}/${Math.max(headerOrderOk.length, headerOrderFail.length)}; sans-cookie identical=${sameSansCookie}`,
    });
  }
  if (
    ok?.jarBefore?.sidPresent &&
    !fail?.jarBefore?.sidPresent &&
    (fail?.jarBefore?.total || 0) === 0
  ) {
    findings.push({
      severity: "critical",
      id: "jar_empty_vs_mature",
      title: "Cookie jar before navigation: mature vs empty",
      detail: `OK jar total=${ok?.jarBefore?.total} NID=${JSON.stringify(ok?.jarBefore?.nidLens)} | FAIL jar total=${fail?.jarBefore?.total}`,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    query: opts.query,
    dirs: { ok: opts.okDir, fail: opts.failDir },
    summary: {
      okTier: ok?.tier,
      failTier: fail?.tier,
      okHtmlLen: ok?.htmlLen,
      failHtmlLen: fail?.htmlLen,
      okHop1Cookies: okHop1?.cookieBytes,
      failHop1Cookies: failHop1?.cookieBytes,
      primaryCauseHypothesis:
        findings.find((f) => f.severity === "critical")?.title ||
        "See findings",
    },
    findings,
    comparisons,
    okMeta: ok,
    failMeta: fail,
  };

  writeFileSync(join(opts.outDir, "diff.json"), JSON.stringify(report, null, 2));

  const md = [];
  md.push(`# Google Search A/B — Velora OK vs FAIL`);
  md.push("");
  md.push(`Generated: ${report.generatedAt}`);
  md.push(`Query: \`${opts.query}\``);
  md.push("");
  md.push(`| Lane | Dir | Tier | htmlLen | hop-1 Cookie B | wire hops |`);
  md.push(`|------|-----|------|---------|----------------|-----------|`);
  md.push(
    `| **OK (cookies)** | \`${opts.okDir}\` | **${ok?.tier}** | ${ok?.htmlLen} | ${okHop1?.cookieBytes ?? 0} | ${ok?.wireHopCount} |`,
  );
  md.push(
    `| **FAIL (no jar)** | \`${opts.failDir}\` | **${fail?.tier}** | ${fail?.htmlLen} | ${failHop1?.cookieBytes ?? 0} | ${fail?.wireHopCount} |`,
  );
  md.push("");

  md.push(`## Executive summary`);
  md.push("");
  md.push(
    `Same binary, same profile fingerprint, same machine/IP, same query. ` +
      `Only controlled variable: **cookie jar at process start**.`,
  );
  md.push("");
  md.push(`**Primary hypothesis:** ${report.summary.primaryCauseHypothesis}`);
  md.push("");
  for (const f of findings) {
    md.push(`- **[${f.severity}]** ${f.title} — ${f.detail}`);
  }
  md.push("");

  md.push(`## 1. Cookie jar before navigation`);
  md.push("");
  md.push(`| Field | OK | FAIL |`);
  md.push(`|-------|----|------|`);
  md.push(
    `| path | ${mdEscape(ok?.jarBefore?.path)} | ${mdEscape(fail?.jarBefore?.path)} |`,
  );
  md.push(
    `| total cookies | ${ok?.jarBefore?.total ?? "?"} | ${fail?.jarBefore?.total ?? "?"} |`,
  );
  md.push(
    `| google-related | ${ok?.jarBefore?.google ?? "?"} | ${fail?.jarBefore?.google ?? "?"} |`,
  );
  md.push(
    `| SID present | ${ok?.jarBefore?.sidPresent} | ${fail?.jarBefore?.sidPresent} |`,
  );
  md.push(
    `| __Secure-1PSID | ${ok?.jarBefore?.secure1psid} | ${fail?.jarBefore?.secure1psid} |`,
  );
  md.push(
    `| NID lengths | ${JSON.stringify(ok?.jarBefore?.nidLens)} | ${JSON.stringify(fail?.jarBefore?.nidLens)} |`,
  );
  md.push("");
  md.push(`### Cookie.loadFromFile log`);
  md.push("");
  md.push(`**OK:**`);
  md.push("```");
  md.push((ok?.cookieLoadLines || []).join("\n") || "(none)");
  md.push("```");
  md.push(`**FAIL:**`);
  md.push("```");
  md.push((fail?.cookieLoadLines || []).join("\n") || "(none)");
  md.push("```");
  md.push("");

  md.push(`## 2. Hop-1 wire Cookie header`);
  md.push("");
  md.push(`| | OK | FAIL |`);
  md.push(`|--|----|------|`);
  md.push(
    `| cookieBytes | **${okHop1?.cookieBytes ?? 0}** | **${failHop1?.cookieBytes ?? 0}** |`,
  );
  md.push(
    `| names | ${(okHop1?.cookieNames || []).join(", ") || "—"} | ${(failHop1?.cookieNames || []).join(", ") || "—"} |`,
  );
  md.push(`| only on OK | ${cookieDiff.onlyA.join(", ") || "—"} |`);
  md.push(`| only on FAIL | ${cookieDiff.onlyB.join(", ") || "—"} |`);
  md.push("");

  md.push(`## 3. Document hop path (wire)`);
  md.push("");
  md.push(`### OK hops`);
  for (const h of ok?.wireHops || []) {
    md.push(
      `- \`${h.hop}\` status=${h.status} proto=${h.protocol} cookieB=${h.cookieBytes} Sec-Fetch-Site=${h.secFetchSite} url=${(h.url || "").slice(0, 100)}`,
    );
  }
  md.push(`### FAIL hops`);
  for (const h of fail?.wireHops || []) {
    md.push(
      `- \`${h.hop}\` status=${h.status} proto=${h.protocol} cookieB=${h.cookieBytes} Sec-Fetch-Site=${h.secFetchSite} url=${(h.url || "").slice(0, 100)}`,
    );
  }
  md.push("");

  md.push(`## 4. Hop-1 header order`);
  md.push("");
  md.push(`Same order: **${comparisons.hop1HeaderOrder.same}** (LCS ${orderScore})`);
  md.push("");
  md.push(`**OK:** \`${headerOrderOk.join(" → ")}\``);
  md.push("");
  md.push(`**FAIL:** \`${headerOrderFail.join(" → ")}\``);
  md.push("");
  md.push(`### Sec-Fetch / network estimates`);
  md.push("");
  md.push("```json");
  md.push(
    JSON.stringify(
      {
        secFetch: comparisons.hop1SecFetch,
        net: comparisons.hop1NetworkEstimates,
      },
      null,
      2,
    ),
  );
  md.push("```");
  md.push("");

  md.push(`## 5. Page outcome`);
  md.push("");
  md.push(`| Field | OK | FAIL |`);
  md.push(`|-------|----|------|`);
  md.push(`| tier | ${ok?.tier} | ${fail?.tier} |`);
  md.push(`| title | ${mdEscape(ok?.snapshot?.title)} | ${mdEscape(fail?.snapshot?.title)} |`);
  md.push(
    `| href | ${mdEscape((ok?.snapshot?.href || "").slice(0, 120))} | ${mdEscape((fail?.snapshot?.href || "").slice(0, 120))} |`,
  );
  md.push(
    `| htmlLen | ${ok?.htmlLen} | ${fail?.htmlLen} |`,
  );
  md.push(
    `| bodyLen | ${ok?.snapshot?.bodyLen} | ${fail?.snapshot?.bodyLen} |`,
  );
  md.push(
    `| rso | ${ok?.snapshot?.signals?.rso} | ${fail?.snapshot?.signals?.rso} |`,
  );
  md.push(
    `| sorry | ${ok?.snapshot?.signals?.sorry} | ${fail?.snapshot?.signals?.sorry} |`,
  );
  md.push(
    `| knitsail | ${ok?.snapshot?.signals?.knitsail} | ${fail?.snapshot?.signals?.knitsail} |`,
  );
  md.push(
    `| results | ${ok?.snapshot?.results?.length ?? 0} | ${fail?.snapshot?.results?.length ?? 0} |`,
  );
  md.push("");
  md.push(`### OK results (sample)`);
  for (const r of ok?.snapshot?.results || []) {
    md.push(`- ${r.title}`);
  }
  md.push(`### FAIL body head`);
  md.push("```");
  md.push(fail?.snapshot?.bodyHead || "");
  md.push("```");
  md.push("");

  md.push(`## 6. HTML markers (bootstrap vs SERP)`);
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(comparisons.markers, null, 2));
  md.push("```");
  md.push("");

  md.push(`## 7. CDP document responses`);
  md.push("");
  md.push(`### OK`);
  md.push("```json");
  md.push(JSON.stringify(ok?.cdpDocumentResponses || [], null, 2));
  md.push("```");
  md.push(`### FAIL`);
  md.push("```json");
  md.push(JSON.stringify(fail?.cdpDocumentResponses || [], null, 2));
  md.push("```");
  md.push("");

  md.push(`## 8. Interpretation (for discussion)`);
  md.push("");
  md.push(`1. **IP is controlled out** — both lanes use the same process host/egress.`);
  md.push(
    `2. **Fingerprint / TLS / header order** are largely shared (same profile binary); hop-1 order LCS check above.`,
  );
  md.push(
    `3. **Cookie presence on hop-1** is the largest intentional delta and correlates with SERP vs bootstrap/sorry.`,
  );
  md.push(
    `4. FAIL path often continues with sei/sg_ss after a thin hop-1 body; OK path is usually 1 hop SERP when jar is mature.`,
  );
  md.push(
    `5. Related engine bug (fixed): Cookies.json restore must set \`source_secure=true\` or HTTPS requests drop all restored cookies — see knowledge/bugs/2026-07-16-cookies-json-source-secure-https-drop.md.`,
  );
  md.push("");
  md.push(`## 9. Artifact index`);
  md.push("");
  md.push(`| Artifact | OK | FAIL |`);
  md.push(`|----------|----|------|`);
  for (const f of [
    "meta.json",
    "wire.ndjson",
    "wire-summary.json",
    "network.json",
    "snapshot.json",
    "page.html",
    "velora.stderr.log",
    "cookies-jar-before.json",
  ]) {
    md.push(`| ${f} | ok/${f} | fail/${f} |`);
  }
  md.push("");
  md.push(`---`);
  md.push(`*Report generator: code-check/google-search-ab/lib/report.mjs*`);

  const mdPath = join(opts.outDir, "REPORT.md");
  writeFileSync(mdPath, md.join("\n"));
  return { report, mdPath };
}

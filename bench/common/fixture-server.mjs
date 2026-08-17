import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function mediumRows() {
  return Array.from({ length: 400 }, (_, index) => (
    `<article data-index="${index}"><h2>Row ${index}</h2><p>Deterministic payload ${(index * 104729) % 1000003}</p></article>`
  )).join("");
}

function largeHtml() {
  const rows = Array.from({ length: 4_000 }, (_, index) => (
    `<article data-index="${index}"><h2>Large row ${index}</h2><p>${(index * 2654435761) >>> 0}</p></article>`
  )).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Koko large fixture</title></head><body><main id="fixture" data-checksum="large-v1">${rows}</main></body></html>`;
}

function resourceBurstHtml(origin) {
  const script = Array.from({ length: 24 }, (_, index) =>
    `window.__kokoResourceCount = (window.__kokoResourceCount || 0) + 1; fetch(${JSON.stringify(`${origin}/resource/${index}`)}).catch(() => {});`
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Koko resource burst</title></head><body><main id="fixture" data-checksum="resource-burst-v1"></main><script>${script}</script></body></html>`;
}

function stylesheetHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><main id="fixture">stylesheet fixture</main></body></html>`;
}

function streamChunks() {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Koko stream</title></head><body>",
    "<main id=\"fixture\" data-checksum=\"stream-v1\"><h1>Streaming fixture</h1>",
    ...Array.from({ length: 8 }, (_, index) => `<p data-chunk=\"${index}\">chunk-${index}</p>`),
    "</main></body></html>",
  ];
}

export async function startFixtureServer(host = "127.0.0.1") {
  const files = {
    "/small.html": await readFile(join(fixtureDirectory, "small.html"), "utf8"),
    "/medium.html": (await readFile(join(fixtureDirectory, "medium.html"), "utf8")).replace("{{ROWS}}", mediumRows()),
    "/dynamic.html": await readFile(join(fixtureDirectory, "dynamic.html"), "utf8"),
  };
  const large = largeHtml();
  const origin = `http://${host}`;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, origin);
    const pathname = requestUrl.pathname;
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("ok");
      return;
    }
    if (pathname.startsWith("/redirect/")) {
      const remaining = Number(pathname.slice("/redirect/".length));
      if (Number.isInteger(remaining) && remaining > 0 && remaining <= 10) {
        response.writeHead(302, { location: `/redirect/${remaining - 1}`, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (remaining === 0) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(files["/small.html"]);
        return;
      }
    }
    if (pathname === "/delayed.html") {
      const delayMs = Math.min(Math.max(Number(requestUrl.searchParams.get("ms") ?? 25), 0), 2_000);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(files["/small.html"]);
      }, Number.isFinite(delayMs) ? delayMs : 25);
      return;
    }
    if (pathname === "/stream.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "transfer-encoding": "chunked" });
      const chunks = streamChunks();
      let index = 0;
      const writeNext = () => {
        if (index >= chunks.length) {
          response.end();
          return;
        }
        response.write(chunks[index++]);
        setTimeout(writeNext, 4);
      };
      writeNext();
      return;
    }
    if (pathname.startsWith("/resource/")) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(`resource-${pathname.slice("/resource/".length)}`);
      return;
    }
    if (pathname === "/fixture.css") {
      const body = "#fixture { color: rgb(12, 34, 56); } @media screen { body { margin: 0; } }";
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    const body = pathname === "/large.html" ? large : pathname === "/resource-burst.html"
      ? resourceBurstHtml(requestUrl.origin) : pathname === "/stylesheet.html" ? stylesheetHtml() : files[pathname];
    if (!body) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://${host}:${port}`,
    urls: Object.fromEntries(Object.keys(files).map((path) => [path.slice(1, -5), `http://${host}:${port}${path}`])),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

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

export async function startFixtureServer(host = "127.0.0.1") {
  const files = {
    "/small.html": await readFile(join(fixtureDirectory, "small.html"), "utf8"),
    "/medium.html": (await readFile(join(fixtureDirectory, "medium.html"), "utf8")).replace("{{ROWS}}", mediumRows()),
    "/dynamic.html": await readFile(join(fixtureDirectory, "dynamic.html"), "utf8"),
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, `http://${host}`).pathname;
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("ok");
      return;
    }
    const body = files[pathname];
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


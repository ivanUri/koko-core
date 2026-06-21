#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Browser } from "../browser/browser.js";

interface Options {
  endpoint: string;
  url?: string;
  output?: string;
  waitUntil: "none" | "commit" | "domcontentloaded" | "load" | "networkidle";
  timeout: number;
  logger: boolean;
  extract: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    endpoint: process.env.VELORA_CDP || "http://127.0.0.1:9222",
    waitUntil: "domcontentloaded",
    timeout: 30_000,
    logger: false,
    extract: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    switch (arg) {
      case "--endpoint": options.endpoint = next(); break;
      case "--output": options.output = next(); break;
      case "--wait-until": options.waitUntil = next() as Options["waitUntil"]; break;
      case "--timeout": options.timeout = Number(next()); break;
      case "--logger": options.logger = true; break;
      case "--extract": options.extract = true; break;
      case "--help": usage(0); break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        options.url = arg;
    }
  }
  if (!options.url) usage(1);
  return options;
}

function usage(exitCode: number): never {
  console.error(`Usage: velora-fetch <url> [options]

Options:
  --endpoint <url>       CDP HTTP or WebSocket endpoint (default: VELORA_CDP or http://127.0.0.1:9222)
  --wait-until <mode>    none | commit | domcontentloaded | load | networkidle (default: domcontentloaded)
  --timeout <ms>         Navigation timeout (default: 30000)
  --output <path>        Write output to file instead of stdout
  --extract              Print JSON extract payload instead of HTML
  --logger               Print protocol logs
`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const browser = await Browser.connect(options.endpoint, { logger: options.logger });
  try {
    const page = await browser.newPage();
    await page.goto(options.url!, { waitUntil: options.waitUntil, timeout: options.timeout });
    const payload = options.extract
      ? JSON.stringify(await page.extract({ timeout: options.timeout }), null, 2)
      : await page.content();
    if (options.output) await writeFile(options.output, payload);
    else process.stdout.write(payload);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
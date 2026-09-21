import { chromium } from "playwright-core";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function resolveChromeEndpoint() {
  const candidates = [
    join(homedir(), "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort"),
    join(homedir(), "Library", "Application Support", "Google", "Chrome Canary", "DevToolsActivePort"),
  ];
  for (const path of candidates) {
    try {
      const [port, browserPath] = (await readFile(path, "utf8")).trim().split(/\r?\n/);
      if (port && browserPath?.startsWith("/devtools/browser/")) return `ws://127.0.0.1:${port}${browserPath}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Chrome DevToolsActivePort was not found; enable remote debugging for this approved import");
}

const root = process.env.JEV_BROWSER_STATE_DIR || join(homedir(), ".local", "share", "pikachu", "jev-browser");
const sessionPath = join(root, "chrome-session.json");
const chromeEndpoint = process.env.JEV_CHROME_CDP_URL || await resolveChromeEndpoint();
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700).catch(() => {});

const browser = await chromium.connectOverCDP(chromeEndpoint);
const context = browser.contexts()[0];
if (!context) throw new Error("Chrome exposed no browser context");
const state = await context.storageState();
await writeFile(sessionPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
await chmod(sessionPath, 0o600);
console.log(`Imported ${state.cookies.length} cookies and ${state.origins.length} origin stores.`);
process.exit(0);

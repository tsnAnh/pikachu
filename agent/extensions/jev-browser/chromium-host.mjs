import { launchPersistentContext } from "cloakbrowser";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.JEV_BROWSER_STATE_DIR || join(homedir(), ".local", "share", "pikachu", "jev-browser");
const profile = join(root, "cloak-profile");
const sessionPath = join(root, "chrome-session.json");
const port = Number(process.env.JEV_BROWSER_CDP_PORT || "9223");
const cursorDataUrl = `data:image/png;base64,${(await readFile(new URL("./cursor-v2.png", import.meta.url))).toString("base64")}`;
await mkdir(profile, { recursive: true, mode: 0o700 });
await chmod(root, 0o700).catch(() => {});

const context = await launchPersistentContext({
  userDataDir: profile,
  headless: false,
  viewport: null,
  args: [
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--fingerprint-storage-quota=5000",
  ],
});

const installVirtualCursor = (imageUrl) => {
  const install = () => {
    if (!document.documentElement || document.getElementById("__pikachu_virtual_cursor")) return;
    const cursor = document.createElement("div");
    cursor.id = "__pikachu_virtual_cursor";
    Object.assign(cursor.style, {
      position: "fixed", left: "0px", top: "0px", width: "32px", height: "32px",
      pointerEvents: "none", zIndex: "2147483647", opacity: "0",
      transition: "left 160ms ease-out, top 160ms ease-out, transform 100ms ease, opacity 100ms ease",
      filter: "drop-shadow(0 1px 2px rgba(0,0,0,.55))",
      backgroundImage: `url(${imageUrl})`, backgroundSize: "contain", backgroundRepeat: "no-repeat",
    });
    document.documentElement.appendChild(cursor);
    window.__pikachuMoveCursor = (x, y, click = false) => {
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      cursor.style.opacity = "1";
      if (click) {
        cursor.style.transform = "scale(.72)";
        setTimeout(() => { cursor.style.transform = "scale(1)"; }, 120);
      }
    };
  };
  if (document.documentElement) install();
  else document.addEventListener("DOMContentLoaded", install, { once: true });
};
await context.addInitScript(installVirtualCursor, cursorDataUrl);
for (const page of context.pages()) await page.evaluate(installVirtualCursor, cursorDataUrl).catch(() => {});

try {
  const state = JSON.parse(await readFile(sessionPath, "utf8"));
  if (Array.isArray(state.cookies) && state.cookies.length) await context.addCookies(state.cookies);
  const stores = Object.fromEntries(
    (Array.isArray(state.origins) ? state.origins : []).map((entry) => [entry.origin, entry.localStorage || []]),
  );
  await context.addInitScript((originStores) => {
    for (const item of originStores[location.origin] || []) localStorage.setItem(item.name, item.value);
  }, stores);
} catch (error) {
  if (error?.code !== "ENOENT") console.error(`Session import skipped: ${error.message}`);
}

const shutdown = async () => {
  await context.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await new Promise(() => {});

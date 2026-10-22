// Records each demo scene on the live app with Playwright, paced to its narration (public/captions.json from tts.py).
// Usage: node video/record.mjs [base-url] [scene ids...]   Writes public/<scene>.webm and public/scenes.json (trim offsets).
import { chromium } from "playwright";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./public/", import.meta.url));
const B = process.argv[2] ?? "https://tera-orpin-three.vercel.app";
const only = process.argv.slice(3);
const captions = JSON.parse(readFileSync(join(dir, "captions.json"), "utf8"));
const manifestPath = join(dir, "scenes.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });

const scenes = {
  async intro({ page, go, at }) {
    await go("/");
    await at("Tera");
    await smoothScroll(page, 500, 3000);
    await at("prorations");
    await smoothScroll(page, 600, 4000);
  },
  async simulator({ page, go, at, mark }) {
    await go("/simulator");
    await mark(page.getByTestId("scenario-select"));
    await at("upgrades");
    await mark(page.getByTestId("timeline"));
    await at("credits");
    await mark(page.getByTestId("invoice-2-line-1"));
    await at("charges");
    await mark(page.getByTestId("invoice-2-line-2"));
    await at("bills");
    await mark(page.getByTestId("invoice-2-line-3"));
    await at("One");
    await mark(page.getByTestId("invoice-2-total"));
    await at("green");
    await mark(page.getByTestId("golden-badge"));
  },
  async edit({ page, go, at, mark }) {
    await go("/simulator");
    await at("Move");
    const date = page.getByLabel("Event 2 date");
    await mark(date);
    await date.focus();
    await page.keyboard.type("01162027", { delay: 90 });
    await at("recomputes");
    await mark(page.getByTestId("invoice-2-total"));
    await at("badge");
    await mark(page.getByTestId("locale-select").locator(".."));
    await at("Switch");
    await page.getByTestId("locale-select").selectOption("de-DE");
    await mark(page.getByTestId("invoice-2"));
  },
  async parity({ page, go, at, mark }) {
    await go("/parity");
    await mark(page.getByTestId("parity-summary"));
    await at("replayed");
    await smoothScroll(page, 500, 3000);
    await at("evidence");
    await page.getByTestId("parity-S74").scrollIntoViewIfNeeded();
    await page.getByTestId("parity-S74").getByRole("button", { expanded: false }).first().click();
    await mark(page.getByTestId("parity-S74-evidence"));
  },
  async builder({ page, go, at, mark }) {
    await go("/builder");
    await page.getByRole("button", { name: "+ Add price" }).click();
    const n = await page.locator("[data-testid^=price-row-][data-testid$=-preview]").count();
    await mark(page.getByLabel(`Price ${n} id`));
    await page.getByLabel(`Price ${n} id`).fill("");
    await page.getByLabel(`Price ${n} id`).pressSequentially("growth_m", { delay: 70 });
    await page.getByLabel(`Price ${n} amount`).fill("");
    await page.getByLabel(`Price ${n} amount`).pressSequentially("49.50", { delay: 70 });
    await at("simulate");
    await page.getByTestId("simulate-catalog").click();
    await page.getByLabel("Event 1 price").selectOption("growth_m");
    await mark(page.getByTestId("invoice-1-total"));
    await at("migration");
    await page.getByRole("link", { name: "Migration" }).click();
    await mark(page.getByTestId("mrr-delta"));
    await at("Grandfather");
    await page.getByLabel(/Grandfather existing customers/).check();
    await mark(page.getByTestId("affected"));
  },
  async agents({ page, go, at, mark }) {
    await go("/mcp-setup");
    await mark(page.getByTestId("mcp-tools"));
    await at("REST");
    await page.getByRole("link", { name: "API" }).click();
    await page.getByText("POST").first().waitFor({ timeout: 30000 });
  },
  async loop({ page, go, at, mark }) {
    await go("https://github.com/PugarHuda/tera/pull/18");
    await at("tested");
    await smoothScroll(page, 700, 3000);
    await at("caught");
    const fix = page.getByText("fix(builder): a custom catalog starts on its first licensed price", { exact: false }).first();
    await mark(fix);
    await at("fix");
    await smoothScroll(page, 500, 3000);
  },
};

const order = Object.keys(scenes).filter((s) => !only.length || only.includes(s));
for (const id of order) {
  const words = captions.find((c) => c.id === id).words;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: "dark", locale: "en-US", recordVideo: { dir, size: { width: 1280, height: 720 } } });
  const page = await ctx.newPage();
  const created = Date.now();
  let t0 = 0;
  const go = async (path) => {
    await page.goto(path.startsWith("http") ? path : B + path, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "html{scroll-behavior:smooth} .demo-mark{outline:3px solid #f6a04a!important;outline-offset:4px;border-radius:6px;transition:outline-color .3s}" });
    if (!t0) t0 = Date.now();
  };
  // Waits until the narration reaches a word (first occurrence at or after the last one used).
  let cursor = 0;
  const at = async (word) => {
    const i = words.findIndex((w, n) => n >= cursor && w.text.replace(/\W/g, "") === word);
    if (i < 0) throw new Error(`${id}: no word ${word}`);
    cursor = i + 1;
    const wait = t0 + words[i].startMs - 150 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  };
  const mark = async (loc) => {
    await page.evaluate(() => document.querySelectorAll(".demo-mark").forEach((e) => e.classList.remove("demo-mark")));
    await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
    await loc.evaluate((e) => {
      e.scrollIntoView({ block: "center", behavior: "smooth" });
      e.classList.add("demo-mark");
    });
  };
  await scenes[id]({ page, go, at, mark });
  const end = t0 + words.at(-1).endMs + 900;
  if (end > Date.now()) await page.waitForTimeout(end - Date.now());
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), join(dir, `${id}.webm`));
  manifest[id] = { ...manifest[id], trimMs: t0 - created, lengthMs: Date.now() - t0 }; // keep tts.py's audioMs
  console.log(id, manifest[id]);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
await browser.close();

async function smoothScroll(page, px, ms) {
  await page.evaluate(
    ([px, ms]) =>
      new Promise((done) => {
        const y0 = scrollY, t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / ms);
          scrollTo({ top: y0 + px * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2), behavior: "instant" });
          k < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      }),
    [px, ms],
  );
}

import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://localhost:5173/ending-repro.html", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const m = await page.evaluate(() => {
  const ending = document.querySelector(".ending");
  const epi = document.querySelector(".ending-epilogue");
  const last = document.querySelector(".ending-epilogue p:last-child");
  const cs = getComputedStyle(epi);
  const r = last.getBoundingClientRect();
  return {
    endingScrollH: ending.scrollHeight,
    endingClientH: ending.clientHeight,
    endingScrolls: ending.scrollHeight > ending.clientHeight,
    epilogueMaxHeight: cs.maxHeight,
    epilogueOverflowY: cs.overflowY,
    epilogueScrollH: epi.scrollHeight,
    epilogueClientH: epi.clientHeight,
    epilogueClipped: epi.scrollHeight > epi.clientHeight + 2,
    lastParagraphBottom: Math.round(r.bottom),
    viewportHeight: window.innerHeight,
    lastParagraphVisibleWithoutScrolling: r.bottom <= window.innerHeight,
    lastParagraphText: last.textContent.trim().slice(0, 60),
  };
});
console.log(JSON.stringify(m, null, 2));
await page.screenshot({ path: ".shots-repro/ending.png", fullPage: false });
await browser.close();

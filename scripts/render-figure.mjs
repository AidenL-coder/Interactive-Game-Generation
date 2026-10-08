#!/usr/bin/env node
// Renders a paper figure from its SVG source to a vector PDF (for LaTeX) and a
// high-resolution PNG (for slides and for looking at).
//
// The SVG is the source of truth and is meant to be edited by hand; this just makes the
// two formats a paper actually needs. The PDF stays vector — text remains text and is
// embedded as a font — so it scales cleanly to whatever width the template sets it at.
//
// Usage:
//   node scripts/render-figure.mjs docs/figures/judge2d.svg
//   node scripts/render-figure.mjs docs/figures/judge2d.svg --scale 6   # PNG density
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
const scaleArg = args.indexOf("--scale");
const scale = scaleArg === -1 ? 5 : Number(args[scaleArg + 1]);

if (!src) {
  console.error("Usage: node scripts/render-figure.mjs <figure.svg> [--scale N]");
  process.exit(1);
}

const svg = await readFile(src, "utf8");
// Size comes from the SVG itself, in points, so the PDF page is exactly the figure.
const w = Number(/width="([\d.]+)pt"/.exec(svg)?.[1]);
const h = Number(/height="([\d.]+)pt"/.exec(svg)?.[1]);
if (!w || !h) {
  console.error('the SVG must declare width="…pt" and height="…pt" on its root element');
  process.exit(1);
}

const html = `<!doctype html><html><head><style>
  @page { size: ${w}pt ${h}pt; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  svg { display: block; }
</style></head><body>${svg}</body></html>`;

const base = src.replace(/\.svg$/i, "");
const browser = await chromium.launch();

// PDF: vector, page sized to the figure.
const pdfPage = await browser.newPage();
await pdfPage.setContent(html, { waitUntil: "load" });
await pdfPage.pdf({
  path: `${base}.pdf`,
  width: `${w / 72}in`,
  height: `${h / 72}in`,
  printBackground: true,
  preferCSSPageSize: true,
  pageRanges: "1",
});

// PNG: the same drawing at `scale` device pixels per CSS pixel.
const pngPage = await browser.newPage({
  viewport: { width: Math.ceil((w * 96) / 72), height: Math.ceil((h * 96) / 72) },
  deviceScaleFactor: scale,
});
await pngPage.setContent(html, { waitUntil: "load" });
await pngPage.locator("svg").screenshot({ path: `${base}.png`, omitBackground: false });

await browser.close();
console.log(`${path.basename(src)} → ${path.basename(base)}.pdf (vector, ${w}×${h}pt) + ${path.basename(base)}.png (${scale}x)`);

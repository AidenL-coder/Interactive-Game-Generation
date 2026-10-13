// The browser every play-and-judge run uses, for both renderers.
//
// Prefers the real GPU. This machine has one (an AMD Radeon Pro 580, reachable from
// headless Chromium through ANGLE/D3D11), but every harness here used to force
// SwiftShader on a comment's say-so that "there is no GPU in this environment". For the
// 2D stage that only cost speed. For the 3D world it is disqualifying: under SwiftShader
// the scene ran at 1.6 fps, and because movement clamps each frame's step to 0.1 s,
// holding a key for one real second moved the player about a sixth as far as it should.
// A judge playing at that rate would be scoring the software renderer, not the game. On
// the GPU the same scene holds 60 fps.
//
// Falls back to software rendering when no GPU is reachable, and records which one it
// got in every play log — a score taken under SwiftShader is not comparable to one taken
// on hardware, and the log is the only place that difference would otherwise be lost.
import { chromium } from "playwright";

const GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"];
const SOFTWARE_ARGS = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"];

async function rendererOf(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
      if (!gl) return "no WebGL";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    });
  } finally {
    await page.close();
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.headed]
 * @param {boolean} [options.software] - force SwiftShader, e.g. to reproduce an old run
 * @returns {Promise<{browser: import("playwright").Browser, renderer: string, hardware: boolean}>}
 */
export async function launchBrowser({ headed = false, software = false } = {}) {
  if (!software) {
    try {
      const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
      const renderer = await rendererOf(browser);
      if (!/swiftshader|no webgl/i.test(renderer)) return { browser, renderer, hardware: true };
      await browser.close();
    } catch {
      // fall through to software
    }
  }
  const browser = await chromium.launch({ headless: !headed, args: SOFTWARE_ARGS });
  return { browser, renderer: await rendererOf(browser), hardware: false };
}

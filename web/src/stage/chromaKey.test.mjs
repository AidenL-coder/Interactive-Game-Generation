// The chroma key decides, per pixel, what is background and what is subject. It has been
// wrong twice, and both times the symptom was a subtly ruined picture rather than an
// error — a grey object half dissolved, a figure inside a translucent box. It is pure
// arithmetic, so it can and should be pinned down. Run with: npm test
import { keyAlpha, magentaness, despill } from "./chromaKey.js";

let pass = 0,
  fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

console.log("\n--- magentaness ---");
check("pure magenta is maximal", magentaness(255, 0, 255) === 255);
check("mid grey is zero", magentaness(128, 128, 128) === 0);
check("white is zero", magentaness(255, 255, 255) === 0);
check("black is zero", magentaness(0, 0, 0) === 0);
check("pure red is not magenta", magentaness(255, 0, 0) === 0);
check("pure blue is not magenta", magentaness(0, 0, 255) === 0);
check("green is strongly negative", magentaness(0, 255, 0) === -255);

console.log("\n--- keyAlpha: the background must go ---");
check("pure magenta is cut", keyAlpha(255, 0, 255) === 0);
check("slightly off magenta is cut", keyAlpha(247, 12, 250) === 0);
check("jpeg-noisy magenta is cut", keyAlpha(232, 28, 240) === 0);

console.log("\n--- keyAlpha: the subject must survive ---");
// This block is the regression. Every one of these was being partially erased by the
// old Euclidean-distance key, because grey and pale colours sit ~215-220 from magenta.
for (const [name, rgb] of [
  ["mid grey (chrome, steel)", [128, 128, 128]],
  ["pale grey (weathered paint)", [200, 200, 200]],
  ["near-white (canvas, paper)", [242, 242, 240]],
  ["black (iron, shadow)", [16, 16, 18]],
  ["skin", [222, 176, 148]],
  ["rust orange", [176, 88, 40]],
  ["olive drab", [96, 104, 66]],
  ["deep teal", [28, 84, 92]],
  ["brass", [200, 164, 78]],
  ["navy blue", [34, 44, 92]],
  ["dark plum shadow", [70, 40, 76]],
  ["desaturated lilac cloth", [168, 150, 176]],
]) {
  const a = keyAlpha(...rgb);
  check(`${name} is kept fully opaque`, a === 255, `alpha=${a}`);
}

console.log("\n--- keyAlpha: the rim ---");
{
  // Between the thresholds the alpha ramps rather than stepping, so compression fringing
  // does not leave a hard halo.
  const mid = keyAlpha(200, 112, 200); // magentaness 88, between 55 and 120
  check("a fringe pixel is partially transparent", mid > 0 && mid < 255, `alpha=${mid}`);
  const nearer = keyAlpha(200, 90, 200); // magentaness 110, closer to background
  check("a pixel closer to the key is more transparent", nearer < mid, `${nearer} vs ${mid}`);
}
{
  // A dark purple inside the subject must not be read as backdrop however magenta-ish it
  // measures, because the real background is always bright.
  check("a dark magenta-ish shadow is kept", keyAlpha(80, 0, 84) === 255);
  check("a bright magenta is still cut", keyAlpha(220, 0, 220) === 0);
}

console.log("\n--- despill ---");
{
  const [r, g, b] = despill(200, 100, 200); // heavy magenta bleed
  check("bleed is pulled toward green", r < 200 && b < 200, `${r},${g},${b}`);
  check("green is untouched", g === 100);
  check("never pulled below green", r >= g && b >= g);
}
{
  const [r, g, b] = despill(128, 128, 128);
  check("neutral grey is left alone", r === 128 && g === 128 && b === 128);
}
{
  const [r, g, b] = despill(190, 120, 70); // a warm orange, not bleed
  check("a warm subject colour is left alone", r === 190 && g === 120 && b === 70);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

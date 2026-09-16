// The chroma key decides, per pixel, what is background and what is subject. It has been
// wrong twice, and both times the symptom was a subtly ruined picture rather than an
// error — a grey object half dissolved, a figure inside a translucent box. It is pure
// arithmetic, so it can and should be pinned down. Run with: npm test
import { keyAlpha, magentaness, despill, erodeAlpha, looksLikeAFramedPicture } from "./chromaKey.js";

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

console.log("\n--- looksLikeAFramedPicture ---");
// Builds an RGBA buffer with an opaque region described by `isOpaque(x, y)`.
function image(width, height, isOpaque) {
  const d = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      d[(y * width + x) * 4 + 3] = isOpaque(x, y) ? 255 : 0;
    }
  }
  return d;
}
const W = 200,
  H = 300;
{
  // The observed failure: a fully rendered scene with a magenta border around it. The
  // border keys out, and a solid rectangle covering most of the frame survives.
  const inset = 0.05;
  const d = image(
    W,
    H,
    (x, y) => x > W * inset && x < W * (1 - inset) && y > H * inset && y < H * (1 - inset)
  );
  check("a framed illustration is rejected", looksLikeAFramedPicture(d, W, H));
}
{
  // A standing figure: roughly a tall blob with plenty of transparent space beside it.
  const d = image(W, H, (x, y) => {
    const cx = W / 2;
    const halfWidth = y < H * 0.25 ? W * 0.1 : W * 0.18;
    return y > H * 0.06 && y < H * 0.96 && Math.abs(x - cx) < halfWidth;
  });
  check("a standing figure is accepted", !looksLikeAFramedPicture(d, W, H));
}
{
  // A wide, genuinely rectangular object painted with a proper margin — a gauge board, a
  // door. Solid, but it does not cover the frame, so it must survive.
  const d = image(W, H, (x, y) => x > W * 0.2 && x < W * 0.8 && y > H * 0.35 && y < H * 0.65);
  check("a rectangular object with a margin is accepted", !looksLikeAFramedPicture(d, W, H));
}
{
  const d = image(W, H, () => false);
  check("an empty image is not called a frame", !looksLikeAFramedPicture(d, W, H));
}
{
  // A wide low object like a bench: covers a lot of width but little height.
  const d = image(W, H, (x, y) => x > W * 0.02 && x < W * 0.98 && y > H * 0.7 && y < H * 0.95);
  check("a wide low object is accepted", !looksLikeAFramedPicture(d, W, H));
}

console.log("\n--- erodeAlpha ---");
{
  // A block of subject in the middle of the frame. Erosion should eat a couple of pixels
  // off its rim — the contaminated ones — and leave the interior alone.
  const w = 60,
    h = 60;
  const d = image(w, h, (x, y) => x >= 20 && x < 40 && y >= 20 && y < 40);
  erodeAlpha(d, w, h, 2);
  const at = (x, y) => d[(y * w + x) * 4 + 3];
  check("the interior stays fully opaque", at(30, 30) === 255, String(at(30, 30)));
  check("the original rim is gone", at(20, 30) === 0, String(at(20, 30)));
  check("the pixel one in from the rim is gone too", at(21, 30) === 0, String(at(21, 30)));
  check("well outside stays clear", at(5, 5) === 0);
  // Two passes leave the opaque region at x=22..37, so x=22 is the new edge and is
  // feathered rather than being a hard jagged step. One pixel further in is interior and
  // must stay fully opaque — the softening only ever works inward from the cut.
  const edge = at(22, 30);
  check("the new edge is softened, not binary", edge > 0 && edge < 255, String(edge));
  check("just inside the new edge is still solid", at(24, 30) === 255, String(at(24, 30)));
}
{
  // The frame edge counts as background: a subject running off the edge of the image has
  // been cropped, and those pixels are just as contaminated.
  const w = 40,
    h = 40;
  const d = image(w, h, () => true);
  erodeAlpha(d, w, h, 2);
  const at = (x, y) => d[(y * w + x) * 4 + 3];
  check("a full-bleed image loses its border", at(0, 0) === 0 && at(1, 1) === 0);
  check("its middle survives", at(20, 20) === 255);
}
{
  const w = 20,
    h = 20;
  const d = image(w, h, () => false);
  erodeAlpha(d, w, h, 2);
  check("an empty mask stays empty", [...d].every((v) => v === 0));
}
{
  // A thin feature narrower than the erosion depth is consumed entirely, which is correct:
  // every pixel of it touches background, so none of its colour can be trusted.
  const w = 40,
    h = 40;
  const d = image(w, h, (x) => x >= 19 && x < 22);
  erodeAlpha(d, w, h, 2);
  check("a hairline thinner than the erosion is removed", [...d].every((v) => v === 0));
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

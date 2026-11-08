// Unit tests for the Reclub screenshot reader, using a synthetic "screenshot"
// (shapes + OCR-like words). No real screenshots or names are stored in the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseReclub, mergeReclub } = require("../pickleball/reclub-reader.js");

const GREEN = [46, 204, 113], YELLOW = [245, 190, 40], INK = [30, 30, 30], WHITE = [255, 255, 255], BLUE = [60, 90, 200];

// Build a fake screenshot at scale k (layout measured at width 505).
function makeShot({ k = 1, drop = [], reservedWord = true, header = true, height = 1200, extra = [] } = {}) {
  const shapes = []; // later shapes are on top
  const words = [];
  const S = (v) => v * k;
  const word = (t, x, y, w, color = INK, c = 95) => {
    if (drop.includes(t)) return;
    words.push({ t, c, x0: S(x), y0: S(y), x1: S(x + w), y1: S(y + 18) });
    shapes.push({ kind: "text", x: S(x), y: S(y), w: S(w), h: S(18), color });
  };
  const rect = (x, y, w, h, color) => shapes.push({ kind: "rect", x: S(x), y: S(y), w: S(w), h: S(h), color });
  const disk = (cx, cy, r, color) => shapes.push({ kind: "disk", cx: S(cx), cy: S(cy), r: S(r), color });
  const colX = (c) => c * 126 + 20;

  if (header) { word("CONFIRMED", 23, 298, 90); word("•14/14", 120, 298, 40); word("Sort:", 29, 366, 30); }
  // Row 1 (names at y=527): paid, waived, two-word name, wrapped name
  word("Alex", colX(0), 527, 40); word("Friend", colX(0), 550, 50, GREEN); rect(colX(0), 630, 60, 36, GREEN);
  word("Bea", colX(1), 527, 34); word("Friend", colX(1), 550, 50, GREEN); rect(colX(1), 630, 80, 36, YELLOW);
  word("Dee", colX(2) + 42, 525, 34); word("Cy", colX(2), 527, 24); word("NR", colX(2), 597, 20); rect(colX(2), 630, 60, 36, GREEN);
  word("Longname", colX(3), 527, 90); word("er", colX(3), 553, 14); word("NR", colX(3), 597, 20); rect(colX(3), 640, 60, 36, GREEN);
  word("Lorem", colX(3), 575, 50, GREEN); // green, non-keyword text: must not become a name
  // Row 2 (names at y=800): unpaid, reserved circle, CMTE tag, letters on a photo
  disk(colX(0) + 40, 735, 45, [120, 90, 60]); word("Eve", colX(0), 800, 34); word("NR", colX(0), 829, 20);
  disk(colX(1) + 40, 820, 47, YELLOW); if (reservedWord) word("Reserved", colX(1) + 5, 835, 70, INK);
  word("Gus", colX(2), 800, 34); word("CMTE", colX(2), 880, 40, BLUE); word("Friend", colX(2), 824, 50, GREEN); rect(colX(2), 900, 80, 36, YELLOW);
  disk(colX(3) + 40, 735, 45, GREEN); word("KR", colX(3) + 20, 725, 40, INK); word("Kim", colX(3), 800, 34); word("Friend", colX(3), 824, 50, GREEN); rect(colX(3), 893, 60, 36, GREEN);
  for (const e of extra) e({ word, rect, disk, colX });
  word("CANTGO", 23, 1100, 70);

  const W = 505 * k, H = height * k;
  const getRGB = (x, y) => {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.kind === "rect" && x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) return s.color;
      if (s.kind === "disk" && (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2) return s.color;
      if (s.kind === "text" && x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) return (x + y) % 3 === 0 ? s.color : WHITE; // letter strokes
    }
    return WHITE;
  };
  return { words, width: W, height: H, getRGB };
}

const summary = (r) => r.people.map((p) => `${p.name}=${p.status}`).join(", ");
const EXPECTED = "Alex=paid, Bea=waived, Cy Dee=paid, Longnameer=paid, Eve=unpaid, Gus=waived, Kim=paid";

test("reads names, badges, reserved slots and the confirmed count", () => {
  const r = parseReclub(makeShot());
  assert.equal(summary(r), EXPECTED);
  assert.equal(r.confirmed, 14);
  assert.equal(r.reserved, 1);
});

test("same result at different screenshot sizes", () => {
  for (const k of [1.5, 2, 3]) assert.equal(summary(parseReclub(makeShot({ k }))), EXPECTED, `scale ${k}`);
});

test("ignores letters on profile photos, green labels and blue tags", () => {
  const names = parseReclub(makeShot()).people.map((p) => p.name);
  for (const junk of ["KR", "Lorem", "Friend", "CMTE"]) assert.ok(!names.some((n) => n.includes(junk)), junk);
});

test("joins words on one line left to right, and wrapped names", () => {
  const names = parseReclub(makeShot()).people.map((p) => p.name);
  assert.ok(names.includes("Cy Dee"), "two words in x order even if OCR lists them out of order");
  assert.ok(names.includes("Longnameer"), "wrapped onto a second line");
});

test("finds a reserved slot from the yellow circle when the word isn't read", () => {
  const r = parseReclub(makeShot({ reservedWord: false }));
  assert.equal(r.reserved, 1);
  assert.equal(summary(r), EXPECTED);
});

test("Fee Waived pills are not mistaken for reserved circles", () => {
  const r = parseReclub(makeShot({ reservedWord: false, extra: [] }));
  assert.equal(r.reserved, 1, "two yellow pills + one circle = 1 reserved");
});

test("works on a scrolled screenshot without the CONFIRMED header", () => {
  const r = parseReclub(makeShot({ header: false }));
  assert.equal(r.confirmed, null);
  assert.equal(summary(r), EXPECTED);
});

test("a name cut off at the bottom edge is marked 'check', not 'not paid'", () => {
  const r = parseReclub(makeShot({ height: 960, extra: [({ word }) => word("Zed", 20, 900, 34)], drop: ["CANTGO"] }));
  const zed = r.people.find((p) => p.name === "Zed");
  assert.equal(zed && zed.status, "check");
});

test("low-confidence words are not names", () => {
  const shot = makeShot();
  shot.words.find((w) => w.t === "Eve").c = 40;
  assert.ok(!parseReclub(shot).people.some((p) => p.name === "Eve"));
});

test("merging screenshots: no duplicates, clearest status wins, counts kept", () => {
  const a = { confirmed: 14, reserved: 0, people: [{ name: "Alex", status: "paid" }, { name: "Bill", status: "check" }] };
  const b = { confirmed: null, reserved: 1, people: [{ name: "alex", status: "unpaid" }, { name: "Bill", status: "unpaid" }, { name: "Cy", status: "waived" }, { name: "", status: "paid" }] };
  const m = mergeReclub([a, b]);
  assert.deepEqual(m.people, [{ name: "Alex", status: "paid" }, { name: "Bill", status: "unpaid" }, { name: "Cy", status: "waived" }]);
  assert.equal(m.confirmed, 14);
  assert.equal(m.reserved, 1);
});

test("empty or broken input does not crash", () => {
  assert.deepEqual(parseReclub({ words: [], width: 505, height: 100, getRGB: () => WHITE }), { confirmed: null, reserved: 0, people: [] });
  assert.deepEqual(mergeReclub([null, undefined]), { confirmed: null, reserved: 0, people: [] });
});

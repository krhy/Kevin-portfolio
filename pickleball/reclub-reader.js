/*
 * Reclub screenshot reader for the Pickleball Committee Fund.
 *
 * Reads the CONFIRMED section of a Reclub "Participants" screenshot:
 *   - the confirmed count ("CONFIRMED • 14/14")
 *   - each confirmed person's name and badge colour:
 *       green pill = paid, yellow pill = fee waived, no pill = not paid
 *   - "Reserved" slots (no name)
 *
 * Text comes from OCR (Tesseract, run in the browser); the badge is decided
 * from pixel colours, because the small white "Paid" text is hard to OCR.
 * Nothing leaves the phone.
 *
 * Pure functions, so they can be unit tested in Node:
 *   parseReclub({ words, width, height, getRGB }) -> result
 *   mergeReclub([result, ...]) -> result   (several screenshots of one game)
 *
 * words: [{ t: text, c: confidence 0-100, x0, y0, x1, y1 }] in image pixels.
 */
(function (root) {
  "use strict";

  const BASE_WIDTH = 505; // layout constants below were measured at this width
  const COLUMNS = 4; // Reclub shows 4 people per row
  const MIN_CONF = 75;
  const KEYWORDS = new Set(["friend", "friends", "nr", "cmte", "fee", "waived", "paid", "reserved", "confirmed", "organizers", "show", "sort", "last"]);
  const NAME_RE = /^[\p{L}][\p{L}\p{N}.'\-]*$/u;
  const STAT_RE = /^(friend|nr|\d[.,]\d{2,3})$/i;

  const isGreen = (r, g, b) => g > 170 && r < 140 && g - r > 70 && b < 200;
  const isYellow = (r, g, b) => r > 220 && g > 140 && g < 220 && b < 110;

  // "CONFIRMED • 14/14": the first number is how many are confirmed.
  // Text recognition sometimes misreads the slash ("14714", "14I14", "1414").
  function readCount(text) {
    const t = String(text || "");
    let m = t.match(/(\d{1,3})\s*[\/\\|]\s*(\d{1,3})/);
    if (m) return Number(m[1]);
    m = t.match(/(\d{1,3})\s*[Il]\s*(\d{1,3})/);
    if (m && m[1] === m[2]) return Number(m[1]);
    const digits = (t.match(/\d{2,7}/) || [""])[0];
    const n = digits.length;
    if (n >= 2 && n % 2 === 0 && digits.slice(0, n / 2) === digits.slice(n / 2)) return Number(digits.slice(0, n / 2));
    if (n >= 3 && n % 2 === 1) {
      const k = (n - 1) / 2;
      if (digits.slice(0, k) === digits.slice(k + 1) && "71".includes(digits[k])) return Number(digits.slice(0, k));
    }
    return null;
  }

  function letters(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z]/g, "");
  }

  function parseReclub({ words, width, height, getRGB }) {
    const u = width / BASE_WIDTH;
    const colW = width / COLUMNS;
    const W = (words || []).filter((w) => w && typeof w.t === "string" && w.t.trim());

    // Section bounds: below the CONFIRMED header (and its Sort/Show bar), above CAN'T GO.
    const header = W.find((w) => letters(w.t).startsWith("CONFIRMED") && w.x0 < width * 0.4);
    let top = header ? header.y0 : 0;
    let confirmed = null;
    if (header) {
      const lineText = W.filter((w) => Math.abs(w.y0 - header.y0) <= 15 * u && w !== header)
        .sort((a, b) => a.x0 - b.x0).map((w) => w.t).join(" ");
      confirmed = readCount(lineText);
      const sortBar = W.find((w) => /^sort/i.test(w.t) && w.y0 > header.y0 && w.y0 < header.y0 + 120 * u);
      top = sortBar ? sortBar.y1 + 5 * u : header.y1 + 5 * u;
    }
    const cantGo = W.find((w) => ["CANTGO", "CANT"].includes(letters(w.t)) && w.y0 > top);
    const bottom = cantGo ? cantGo.y0 : height;

    const col = (w) => Math.min(COLUMNS - 1, Math.max(0, Math.floor((w.x0 + w.x1) / 2 / colW)));
    const inSection = (w) => w.y0 > top && w.y1 < bottom;

    // Real names are dark text on the white page. This rejects letters on
    // profile photos (e.g. "KR"), green "Friend" labels and blue "CMTE" tags.
    function looksLikeName(w) {
      const pad = Math.max(2, Math.round(3 * u));
      const xa = Math.max(0, Math.floor(w.x0 - pad)), xb = Math.min(width - 1, Math.ceil(w.x1 + pad));
      const ya = Math.max(0, Math.floor(w.y0 - pad)), yb = Math.min(height - 1, Math.ceil(w.y1 + pad));
      const white = (x, y) => { const [r, g, b] = getRGB(x, y); return r > 225 && g > 225 && b > 225; };
      let ring = 0, ringWhite = 0;
      for (let x = xa; x <= xb; x++) { ring += 2; ringWhite += white(x, ya) + white(x, yb); }
      for (let y = ya; y <= yb; y++) { ring += 2; ringWhite += white(xa, y) + white(xb, y); }
      if (ringWhite / ring < 0.75) return false;
      let area = 0, ink = 0;
      for (let y = Math.floor(w.y0); y <= Math.min(height - 1, Math.ceil(w.y1)); y++) {
        for (let x = Math.floor(w.x0); x <= Math.min(width - 1, Math.ceil(w.x1)); x++) {
          const [r, g, b] = getRGB(x, y);
          const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
          area++;
          if (hi < 120 && hi - lo < 45) ink++;
        }
      }
      return area > 0 && ink / area >= 0.04;
    }

    // Name candidates -> lines per column -> people (joining wrapped names).
    const fuzzyKeyword = (t) => /rien|iend|frie|waiv|cmte/i.test(t);
    const cand = W.filter((w) => inSection(w) && w.c >= MIN_CONF && NAME_RE.test(w.t) &&
      !KEYWORDS.has(w.t.toLowerCase()) && !fuzzyKeyword(w.t) && looksLikeName(w));
    cand.sort((a, b) => col(a) - col(b) || a.y0 - b.y0 || a.x0 - b.x0);
    const lines = [];
    for (const w of cand) {
      const last = lines[lines.length - 1];
      if (last && last.col === col(w) && Math.abs(last.y - w.y0) < 8 * u) {
        last.parts.push(w);
        last.y1 = Math.max(last.y1, w.y1);
        continue;
      }
      lines.push({ col: col(w), y: w.y0, y1: w.y1, parts: [w] });
    }
    for (const ln of lines) ln.t = ln.parts.sort((a, b) => a.x0 - b.x0).map((w) => w.t).join(" "); // left to right
    const people = [];
    for (const ln of lines) {
      const p = people[people.length - 1];
      if (p && p.col === ln.col && ln.y - p.yLast > 0 && ln.y - p.yLast < 35 * u && ln.t.length <= 3 && !ln.t.includes(" ")) {
        p.name += ln.t; // e.g. "bryanalipa" + "r"
        p.yLast = ln.y;
        p.yBottom = ln.y1;
        continue;
      }
      if (ln.t.length < 2) continue; // stray letters from profile photos
      people.push({ col: ln.col, y: ln.y, yLast: ln.y, yBottom: ln.y1, name: ln.t });
    }

    // Badge colour below each name.
    function badge(p) {
      const xa = Math.floor(p.col * colW + 5 * u);
      const xb = Math.floor((p.col + 1) * colW - 5 * u);
      const nextY = Math.min(...people.filter((q) => q.col === p.col && q.y > p.y).map((q) => q.y), bottom + 100 * u);
      const ya = Math.floor(p.yBottom + 5 * u);
      const yWant = Math.floor(p.y + 140 * u);
      const yb = Math.min(yWant, Math.floor(nextY - 100 * u), Math.floor(bottom), height);
      const minRun = 35 * u;
      let green = 0, yellow = 0;
      for (let y = ya; y < yb; y++) {
        let rg = 0, ry = 0, bg = 0, by = 0;
        for (let x = xa; x < xb; x++) {
          const [r, g, b] = getRGB(x, y);
          rg = isGreen(r, g, b) ? rg + 1 : 0;
          ry = isYellow(r, g, b) ? ry + 1 : 0;
          if (rg > bg) bg = rg;
          if (ry > by) by = ry;
        }
        if (bg >= minRun) green++;
        if (by >= minRun) yellow++;
      }
      const minRows = 10 * u;
      if (yellow >= minRows) return "waived";
      if (green >= minRows) return "paid";
      // Picture cut off before the badge area: we cannot tell.
      if (yWant > height && yb >= height) return "check";
      return "unpaid";
    }

    // Keep only real people: a name followed by a badge, a "Friend" label or a rating.
    const result = [];
    for (const p of people) {
      const status = badge(p);
      const supported = status === "paid" || status === "waived" || W.some((w) =>
        col(w) === p.col && w.y0 > p.yLast && w.y0 - p.yLast < 70 * u && STAT_RE.test(w.t.trim()));
      if (!supported && status !== "check") continue;
      result.push({ name: p.name.trim().slice(0, 40), status, _col: p.col, _y: p.y });
    }
    const row = (p) => Math.round(p._y / (60 * u)); // same row despite small offsets
    result.sort((a, b) => row(a) - row(b) || a._col - b._col);

    // Reserved slots: count the word, and also look for the big yellow circle
    // (much taller than a "Fee Waived" pill) in case the word is not read.
    const reservedWords = W.filter((w) => inSection(w) && /^reserv/i.test(w.t)).length;
    // A row "is yellow" when it has enough yellow pixels in total, so the
    // dark "Reserved" text and lock icon inside the circle don't split it.
    // Measured: circles ~95 units tall, "Fee Waived" pills ~43.
    let reservedCircles = 0;
    for (let c = 0; c < COLUMNS; c++) {
      const xa = Math.floor(c * colW), xb = Math.floor((c + 1) * colW);
      let streak = 0, gap = 0;
      const finish = () => { if (streak >= 68 * u) reservedCircles++; streak = 0; gap = 0; };
      for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.floor(bottom)); y++) {
        let count = 0;
        for (let x = xa; x < xb; x++) {
          const [r, g, b] = getRGB(x, y);
          if (isYellow(r, g, b)) count++;
        }
        if (count >= 30 * u) { streak += 1 + gap; gap = 0; }
        else if (streak && gap < 4 * u) gap++;
        else finish();
      }
      finish();
    }
    const reserved = Math.max(reservedWords, reservedCircles);

    return {
      confirmed,
      reserved,
      people: result.map(({ name, status }) => ({ name, status })),
    };
  }

  const nameKey = (n) => String(n || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const RANK = { paid: 3, waived: 3, unpaid: 2, check: 1 };

  // Combine several screenshots of the same game (scrolled lists overlap).
  function mergeReclub(results) {
    const out = { confirmed: null, reserved: 0, people: [] };
    const byKey = new Map();
    for (const r of results || []) {
      if (!r) continue;
      if (out.confirmed == null && r.confirmed != null) out.confirmed = r.confirmed;
      out.reserved = Math.max(out.reserved, r.reserved || 0);
      for (const p of r.people || []) {
        const k = nameKey(p.name);
        if (!k) continue;
        const had = byKey.get(k);
        if (!had) {
          const copy = { name: p.name, status: p.status };
          byKey.set(k, copy);
          out.people.push(copy);
        } else if ((RANK[p.status] || 0) > (RANK[had.status] || 0)) {
          had.status = p.status;
        }
      }
    }
    return out;
  }

  const api = { parseReclub, mergeReclub, readCount, BASE_WIDTH };
  root.ReclubReader = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "/Users/syslab/.gemini/config/skills/anatomy/kit/iso-kit.mjs";
import { kitScript } from "/Users/syslab/.gemini/config/skills/anatomy/scripts/inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";

const WIDTH = 660;
const HEIGHT = 410;

// Surface plate & metrology bench dimensions
const PLATE = { x: -146, y: -74, w: 292, d: 148, r: 8 };
const PLATE_H = 12;
const FOOT_H = 5;
const BED_TOP = 5;

// 5 Progressive Transfer Stations along X (y = 0 centerline)
// S0: Source Agent Feed (-100) -> S1: NoiseGate Sieve (-52) -> S2: AST Skeleton Press (-4)
// -> S3: Log/Data Calender & Dial (+44) -> S4: Target Agent Baton Dock (+92)
const STATIONS = [
  {
    id: 0,
    x: -100,
    code: "S0 SOURCE FEED",
    name: "Source Agent Hopper",
    tokens: "42.8k",
    saving: "raw",
    w: 24,
    d: 18,
    h: 20,
  },
  {
    id: 1,
    x: -52,
    code: "S1 NOISEGATE",
    name: "S1 NoiseGate Sieve",
    tokens: "14.6k",
    saving: "-65.9%",
    w: 21,
    d: 16.5,
    h: 15,
  },
  {
    id: 2,
    x: -4,
    code: "S2 AST PRESS",
    name: "S2 AST Skeleton Press",
    tokens: "4.85k",
    saving: "-88.7%",
    w: 18.5,
    d: 15,
    h: 10,
  },
  {
    id: 3,
    x: 44,
    code: "S3 SLIM GAUGE",
    name: "S3 Log & Data Calender",
    tokens: "2.64k",
    saving: "-93.8%",
    w: 16,
    d: 13,
    h: 7,
  },
  {
    id: 4,
    x: 92,
    code: "S4 BATON RELAY",
    name: "S4 Target Agent Dock",
    tokens: "1.92k",
    saving: "-95.5%",
    w: 14,
    d: 11.5,
    h: 5,
  },
];

const STOPS = STATIONS.map((s) => s.x);
const REACH = [STOPS[0], STOPS[STOPS.length - 1]];

// Front-left Rehydration Ledger Indexing Drum (.vicem/ledger.json) — completely open foreground bay!
const LEDGER_BASE = { x: -118, y: 24, w: 48, d: 32, r: 3 };
const LEDGER_BASE_H = 12;
const DRUM = [-94, 40];
const DRUM_R = 11.5;
const DRUM_Z = LEDGER_BASE_H;
const DRUM_H = 10;
const DRUM_TOP = DRUM_Z + DRUM_H;

// Station 3 Micrometer Dial Comparator (mounted on Station 3 bridge at x = 44)
const DIAL = [44, 0];
const DIAL_R = 18;
const DIAL_Z = 72;
const DIAL_H = 9.5;
const DIAL_TOP = DIAL_Z + DIAL_H;
const PER_TURN = 20;

// Back-right Target Agent Receiver Terminal (Codex / Claude / Gemini Handoff Unit)
const RECEIVER = { x: 74, y: -64, w: 54, d: 34, r: 3 };
const RECEIVER_H = 15;
const BEACON = [101, -47];
const BEACON_R = 8;
const BEACON_TOP = RECEIVER_H + 6;

const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    [-52, 0, 90],
    [DIAL[0] + DIAL_R, 0, DIAL_TOP + 4],
    [118, 28, 52],
  ],
  WIDTH,
  HEIGHT,
  { pad: 26, azimuth: 41, elevation: 30 },
);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const W = (from, to, style) => k.wireSvg(from, to, style);
const byDepth = (points) =>
  [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

// 1. Heavy Metrology Surface Plate, Feet, Vernier Ruler & Spec Plate
function surfacePlate() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(PLATE, 22))) {
    out.push(S(k.cylinder(x, y, 7.2, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 5.5, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));

  const screws = k.corners(PLATE, 10);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.3, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.52 }));

  // Engraved nameplate on back-left deck (clear of all gantries)
  const badge = { x: -124, y: -60, w: 50, d: 18, r: 1.5 };
  out.push(S(k.slabOf(badge, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
  out.push(
    D(
      [
        at([badge.x + 2.5, badge.y + 2.5, 0.8]),
        at([badge.x + badge.w - 2.5, badge.y + 2.5, 0.8]),
        at([badge.x + 2.5, badge.y + badge.d - 2.5, 0.8]),
        at([badge.x + badge.w - 2.5, badge.y + badge.d - 2.5, 0.8]),
      ],
      { size: 0.36, tone: "mid" },
    ),
  );
  out.push(
    L(k.lineOnTop([badge.x + 5, badge.y + 5.5], [badge.x + badge.w - 7, badge.y + 5.5], 0.8, P), {
      tone: "mid",
      free: true,
    }),
  );
  out.push(
    L(k.lineOnTop([badge.x + 5, badge.y + 9.0], [badge.x + badge.w - 14, badge.y + 9.0], 0.8, P), {
      tone: "lo",
      free: true,
    }),
  );
  out.push(
    L(k.lineOnTop([badge.x + 5, badge.y + 12.5], [badge.x + badge.w - 10, badge.y + 12.5], 0.8, P), {
      tone: "lo",
      free: true,
    }),
  );

  // Front vernier calibration ruler strip (right side of front deck, clear of front-left Ledger Drum)
  const strip = { x: -58, y: PLATE.y + PLATE.d - 16, w: 184, d: 7.5, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.7, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 4, 5, strip.y + 0.8, 0.7, [2.1, 3.8], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(
    D([at([strip.x + 2.2, strip.y + 3.8, 0.7]), at([strip.x + strip.w - 2.2, strip.y + 3.8, 0.7])], {
      size: 0.45,
    }),
  );
  return out.join("");
}

// 2. Back-side structures (y <= -20): drawn BEFORE the transfer bed and moving workpiece
function backStations() {
  const out = [];

  // 2A. Back-right Target Agent Receiver Terminal (Codex / Claude / Gemini Handoff Unit)
  out.push(S(k.slabOf(RECEIVER, 0, 9, P, 5, 0.8), { tone: "mid" }));
  out.push(
    S(k.slabOf(k.insetPlan(RECEIVER, 1.4), 9, RECEIVER_H - 9, P, 5, 0.6), {
      tone: "hi",
      crease: "lo",
    }),
  );
  out.push(L(k.planOutline(k.insetPlan(RECEIVER, 3.6), RECEIVER_H, P), { tone: "faint" }));
  out.push(
    D(
      [
        at([RECEIVER.x + 4.5, RECEIVER.y + 4.5, RECEIVER_H]),
        at([RECEIVER.x + RECEIVER.w - 4.5, RECEIVER.y + 4.5, RECEIVER_H]),
        at([RECEIVER.x + 4.5, RECEIVER.y + RECEIVER.d - 4.5, RECEIVER_H]),
        at([RECEIVER.x + RECEIVER.w - 4.5, RECEIVER.y + RECEIVER.d - 4.5, RECEIVER_H]),
      ],
      { size: 0.42, tone: "lo" },
    ),
  );
  // Target Agent Turret Dial on Receiver top
  out.push(S(k.cylinder(BEACON[0], BEACON[1], BEACON_R, RECEIVER_H, 6, P, 36, 0.5), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(BEACON[0], BEACON[1], BEACON_R, BEACON_TOP - 2.4, BEACON_TOP, 32, P, 0.3), { tone: "lo" }));
  out.push(L(k.sideArc(BEACON[0], BEACON[1], BEACON_R, BEACON_TOP - 2.4, P, 24), { tone: "faint" }));
  out.push(L(k.ring(BEACON[0], BEACON[1], BEACON_R - 1.5, BEACON_TOP, P, 24), { tone: "lo" }));
  const rxTicks = k.radialTicks(BEACON[0], BEACON[1], BEACON_R - 1.8, 16, 4, BEACON_TOP, [0.9, 1.7], P);
  out.push(L(rxTicks.minor, { tone: "lo" }), L(rxTicks.major, { tone: "mid" }));
  out.push(D([at([BEACON[0], BEACON[1], BEACON_TOP])], { size: 0.55, tone: "hi" }));

  // 3 Safety Guard Pillar pins (SkeletonWrite, SecretCommit, InstructionDrift)
  for (const dx of [-15, -9.5, -4]) {
    out.push(L(k.ring(RECEIVER.x + 23 + dx, RECEIVER.y + 11, 1.8, RECEIVER_H, P, 14), { tone: "lo" }));
    out.push(D([at([RECEIVER.x + 23 + dx, RECEIVER.y + 11, RECEIVER_H])], { size: 0.48, tone: "hi" }));
  }

  // 2B. Back Columns for Stations 1, 2, 3 at y = -20 (outside transferBed y = -14..+14!)
  // Station 1 Back Post (NoiseGate Gantry)
  out.push(S(k.cylinder(-52, -20, 4.2, 0, 3, P, 24), { tone: "lo" }));
  out.push(S(k.cylinder(-52, -20, 2.8, 3, 43, P, 24), { tone: "mid", crease: "none" }));
  out.push(L([18, 34].map((z) => k.sideArc(-52, -20, 2.8, z, P, 14)).join(""), { tone: "faint" }));

  // Station 2 Back Column (AST Skeletonizer Hydraulic Press)
  out.push(S(k.cylinder(-4, -20, 4.5, 0, 3.5, P, 24), { tone: "lo" }));
  out.push(S(k.cylinder(-4, -20, 3.1, 3.5, 50.5, P, 24), { tone: "mid", crease: "none" }));
  out.push(L([20, 38].map((z) => k.sideArc(-4, -20, 3.1, z, P, 14)).join(""), { tone: "faint" }));

  // Station 3 Back Column (Comparator Pillar)
  out.push(S(k.cylinder(44, -20, 4.8, 0, 4, P, 24), { tone: "lo" }));
  out.push(S(k.cylinder(44, -20, 3.2, 4, 82, P, 24), { tone: "mid", crease: "none" }));
  out.push(L([26, 48, 70].map((z) => k.sideArc(44, -20, 3.2, z, P, 14)).join(""), { tone: "faint" }));
  out.push(S(k.cylinder(44, -20, 3.8, 86, 2.2, P, 24), { tone: "mid" }));

  return out.join("");
}

// 3. Linear Transfer Bed, Source Hopper Magazine (S0), and Target Agent Dock Cradle (S4)
function transferBed() {
  const out = [];

  // Main transfer ways (y = -12 and y = +8)
  for (const y of [-12, 8]) {
    out.push(
      S(k.slabOf({ x: -116, y, w: 228, d: 4.5, r: 1 }, 0, 3.2, P, 3, 0.4), {
        tone: "mid",
      }),
    );
    out.push(
      D([-108, -60, -12, 36, 84, 106].map((x) => at([x, y + 2.25, 3.2])), {
        size: 0.38,
      }),
    );
  }

  // Center precision platen bed (z = 0..BED_TOP)
  const bed = { x: -118, y: -14, w: 232, d: 28, r: 2.5 };
  out.push(S(k.slabOf(bed, 0, BED_TOP, P, 4, 0.6), { tone: "mid" }));
  out.push(L(k.lineOnTop([-112, -9.5], [108, -9.5], BED_TOP, P), { tone: "faint" }));
  out.push(L(k.lineOnTop([-112, 9.5], [108, 9.5], BED_TOP, P), { tone: "faint" }));

  // 5 Station calibration anvil pads inset along the transfer bed
  STATIONS.forEach((st) => {
    const pad = { x: st.x - st.w / 2 - 1.5, y: -st.d / 2 - 1.5, w: st.w + 3, d: st.d + 3, r: 1.2 };
    out.push(L(k.planOutline(pad, BED_TOP, P, 3), { tone: "lo" }));
    out.push(
      D(
        [
          at([pad.x + 2, pad.y + 2, BED_TOP]),
          at([pad.x + pad.w - 2, pad.y + pad.d - 2, BED_TOP]),
        ],
        { size: 0.35, tone: "lo" },
      ),
    );
  });

  // Left End-Stop: Source Agent Feed Hopper Magazine & Pusher Block (x = -132..-118)
  const hopper = { x: -132, y: -15, w: 14, d: 30, r: 2 };
  out.push(S(k.slabOf(hopper, 0, 18, P, 4, 0.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(hopper, 2.2), 18, P, 3), { tone: "lo" }));
  out.push(D([at([-125, -10, 18]), at([-125, 10, 18])], { size: 0.45 }));

  // Right End-Stop: Target Agent Receiver Dock Backstop & Latch Post (x = +114)
  out.push(S(k.slabOf({ x: 114, y: -15, w: 7, d: 30, r: 1.2 }, 0, 13, P, 3, 0.5), { tone: "hi", crease: "lo" }));
  out.push(D([at([117.5, -10, 13]), at([117.5, 10, 13])], { size: 0.45 }));

  // Telemetry conduit from S4 Dock Backstop to Target Agent Receiver Terminal
  const dockPort = at([117.5, -6, 13]);
  const via1 = at([117.5, -28, 15]);
  const via2 = at([108, -40, RECEIVER_H + 1]);
  const rxPort = at([RECEIVER.x + 12, RECEIVER.y + 20, RECEIVER_H]);
  out.push(
    `<g class="relay-wire">${W(dockPort, rxPort, { via: [via1, via2], tone: "mid", ends: "both", size: 1.15 })}</g>`,
  );

  return out.join("");
}

// Helper to build the live morphing Context Workpiece + Traveling Shuttle Carrier at (cx, w, d, h)
function buildWorkpieceSvg(cx, w, d, h, P) {
  const shoe = { x: cx - w / 2 - 2.2, y: -d / 2 - 1.5, w: w + 4.4, d: d + 3, r: 2 };
  const plan = { x: cx - w / 2, y: -d / 2, w, d, r: 1.8 };
  const z0 = BED_TOP;
  const zShoe = z0 + 1.8;
  const zTop = zShoe + h;
  const out = [];
  // Precision shuttle carrier shoe riding on the bed
  out.push(S(k.slabOf(shoe, z0, 1.8, P, 4, 0.4), { tone: "mid" }));
  // Lit Context Ingot / Baton block
  out.push(S(k.slabOf(plan, zShoe, h, P, 4, 0.65), { tone: "hi", crease: "lo", lit: true }));
  out.push(L(k.planOutline(k.insetPlan(plan, 2.1), zTop, P, 3), { tone: "lo" }));
  const bossR = Math.min(w, d) * 0.24;
  out.push(L(k.ring(cx, 0, bossR, zTop, P, 20), { tone: "mid" }));
  out.push(D([at([cx, 0, zTop])], { size: 0.5, tone: "hi" }));
  return out.join("");
}

// 4. Overhead Bridges, Actuators, Front Posts & Front-Left Ledger Drum (drawn AFTER the moving workpiece)
function overheadAndFrontStations() {
  const out = [];

  // --- STATION 1 (x = -52): NoiseGate Sieve Gantry ---
  out.push(S(k.cylinder(-52, 20, 4.2, 0, 3, P, 24), { tone: "lo" }));
  out.push(S(k.cylinder(-52, 20, 2.8, 3, 43, P, 24), { tone: "mid", crease: "none" }));
  out.push(L([18, 34].map((z) => k.sideArc(-52, 20, 2.8, z, P, 14)).join(""), { tone: "faint" }));

  // Moving Sieve Gate Blade (strokes down onto workpiece when at Station 1)
  const gatePlan = { x: -57, y: -13, w: 10, d: 26, r: 1.2 };
  out.push(
    `<g data-part="gate1">${
      S(k.slabOf(gatePlan, 26, 6.5, P, 3, 0.5), { tone: "hi", crease: "lo" }) +
      S(k.cylinder(-52, 0, 1.8, 32.5, 14, P, 16), { tone: "mid", crease: "none" }) +
      D([at([-52, -7, 32.5]), at([-52, 0, 32.5]), at([-52, 7, 32.5])], { size: 0.42, tone: "lo" })
    }</g>`,
  );

  // Station 1 Overhead Crossbeam (z = 46..51)
  const beam1 = { x: -58, y: -24, w: 12, d: 48, r: 2 };
  out.push(S(k.slabOf(beam1, 46, 5, P, 4, 0.6), { tone: "mid" }));
  out.push(L(k.ring(-52, 0, 2.6, 51, P, 16), { tone: "lo" }));
  out.push(D([at([-52, -20, 51]), at([-52, 0, 51]), at([-52, 20, 51])], { size: 0.48 }));

  // --- STATION 2 (x = -4): AST Skeletonizer Hydraulic Press ---
  out.push(S(k.cylinder(-4, 20, 4.5, 0, 3.5, P, 24), { tone: "lo" }));
  out.push(S(k.cylinder(-4, 20, 3.1, 3.5, 50.5, P, 24), { tone: "mid", crease: "none" }));
  out.push(L([20, 38].map((z) => k.sideArc(-4, 20, 3.1, z, P, 14)).join(""), { tone: "faint" }));

  // Moving Hydraulic Press Platen + Piston Rod
  const pressPlan = { x: -12, y: -12, w: 16, d: 24, r: 1.5 };
  out.push(
    `<g data-part="ram2">${
      S(k.slabOf(pressPlan, 24, 5.5, P, 3, 0.5), { tone: "hi", crease: "lo" }) +
      L(k.planOutline(k.insetPlan(pressPlan, 2), 29.5, P, 3), { tone: "faint" }) +
      S(k.cylinder(-4, 0, 2.4, 29.5, 25, P, 20), { tone: "mid", crease: "none" })
    }</g>`,
  );

  // Coil spring rings around the hydraulic piston rod
  const springRings = Array.from({ length: 5 }, (_, i) => k.ring(-4, 0, 4.2, 33 + i * 4.0, P, 20)).join("");
  out.push(`<path data-part="spring2" class="iso-line" data-tone="lo" d="${springRings}"/>`);

  // Station 2 Overhead Press Crown (z = 54..60) + Knurled Pressure Wheel
  const beam2 = { x: -11, y: -24, w: 14, d: 48, r: 2.2 };
  out.push(S(k.slabOf(beam2, 54, 6, P, 4, 0.7), { tone: "mid" }));
  out.push(D([at([-4, -20, 60]), at([-4, 20, 60])], { size: 0.48 }));
  out.push(S(k.cylinder(-4, 0, 6.5, 60, 4.5, P, 32, 0.5), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(-4, 0, 6.5, 60, 64.5, 36, P, 0.3), { tone: "lo" }));
  out.push(D([at([-4, 0, 64.5])], { size: 0.5, tone: "hi" }));

  // --- STATION 3 (x = +44): Log/Data Calender & Micrometer Dial Comparator ---
  // Reference Anvil & Calender Plunger Shoe at Station 3 (grounds the plunger at all times!)
  const anvil3 = { x: 38, y: -16, w: 12, d: 4, r: 1 };
  out.push(S(k.slabOf(anvil3, 0, 14, P, 3, 0.4), { tone: "mid" }));
  const feelerBar = { x: 38, y: -15, w: 12, d: 24, r: 1 };
  out.push(
    `<g data-part="plunger" transform="${k.translateAlong(P, [0, 0, 14])}">${
      S(k.slabOf(feelerBar, 0, 2.2, P, 3, 0.35), { tone: "hi", crease: "lo", lit: true }) +
      S(k.cylinder(DIAL[0], DIAL[1], 1.5, 2.2, 46, P, 16), { tone: "hi", crease: "none", lit: true })
    }</g>`,
  );

  // Comparator Clamp & Cross-Arm from Back Column (y = -20) to Dial (y = 0)
  const clamp3 = { x: 44 - 6.5, y: -20 - 6.5, w: 13, d: 13, r: 2 };
  out.push(S(k.slabOf(clamp3, 74, 10, P, 4, 0.5), { tone: "mid" }));
  const arm3 = { x: 44 - 3, y: -20, w: 6, d: 20, r: 1.5 };
  out.push(S(k.slabOf(arm3, 76, 4.5, P, 3, 0.5), { tone: "mid" }));
  out.push(D([at([44, -15, 80.5]), at([44, -4, 80.5])], { size: 0.45 }));

  // Dial Gauge Housing
  out.push(S(k.cylinder(DIAL[0], DIAL[1], 2.8, 48, DIAL_Z - 48, P, 20), { tone: "mid" }));
  out.push(L(k.sideArc(DIAL[0], DIAL[1], 2.8, 54, P, 12), { tone: "lo" }));
  out.push(S(k.cylinder(DIAL[0], DIAL[1], DIAL_R, DIAL_Z, DIAL_H, P, 64, 0.8), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(DIAL[0], DIAL[1], DIAL_R, DIAL_TOP - 3.2, DIAL_TOP, 80, P, 0.3), { tone: "lo" }));
  out.push(L(k.sideArc(DIAL[0], DIAL[1], DIAL_R, DIAL_TOP - 3.2, P, 40), { tone: "faint" }));
  out.push(L(k.ring(DIAL[0], DIAL[1], DIAL_R - 2.1, DIAL_TOP, P, 64), { tone: "lo" }));
  const dialTicks = k.radialTicks(DIAL[0], DIAL[1], DIAL_R - 2.8, 50, 5, DIAL_TOP, [1.2, 2.6], P);
  out.push(L(dialTicks.minor, { tone: "lo" }), L(dialTicks.major, { tone: "mid" }));
  out.push(L(k.ring(DIAL[0], DIAL[1], 1.5, DIAL_TOP, P, 16), { tone: "mid" }));
  out.push(
    k.faceTextSvg(k.topMatrix([DIAL[0], DIAL[1] + 8.2], DIAL_TOP, P, "x"), "TOK", {
      size: 2.2,
      tone: "lo",
      anchor: "middle",
    }),
  );

  // --- STATION 4 (x = +92): Target Agent Dock Locking Clamp ---
  out.push(S(k.slabOf({ x: 86, y: 15, w: 12, d: 6, r: 1.5 }, 0, 14, P, 3, 0.5), { tone: "mid" }));
  out.push(D([at([89, 18, 14]), at([95, 18, 14])], { size: 0.42 }));
  out.push(S(k.cylinder(92, 23, 3.2, 3, 5.5, P, 20), { tone: "mid" }));
  out.push(L(k.knurl(92, 23, 3.2, 3, 8.5, 18, P, 0.3), { tone: "lo" }));

  // --- FRONT-LEFT: Rehydration Ledger Indexing Drum (.vicem/ledger.json) ---
  out.push(S(k.slabOf(LEDGER_BASE, 0, 7, P, 5, 0.7), { tone: "mid" }));
  out.push(
    S(k.slabOf(k.insetPlan(LEDGER_BASE, 1.2), 7, LEDGER_BASE_H - 7, P, 5, 0.6), {
      tone: "mid",
    }),
  );
  out.push(L(k.planOutline(k.insetPlan(LEDGER_BASE, 3.2), LEDGER_BASE_H, P), { tone: "faint" }));
  out.push(
    D(
      [
        at([LEDGER_BASE.x + 4.5, LEDGER_BASE.y + 4.5, LEDGER_BASE_H]),
        at([LEDGER_BASE.x + LEDGER_BASE.w - 4.5, LEDGER_BASE.y + 4.5, LEDGER_BASE_H]),
        at([LEDGER_BASE.x + 4.5, LEDGER_BASE.y + LEDGER_BASE.d - 4.5, LEDGER_BASE_H]),
        at([LEDGER_BASE.x + LEDGER_BASE.w - 4.5, LEDGER_BASE.y + LEDGER_BASE.d - 4.5, LEDGER_BASE_H]),
      ],
      { size: 0.42 },
    ),
  );
  // Rotary Ledger Drum (.vicem/ledger.json symbol store)
  out.push(S(k.cylinder(DRUM[0], DRUM[1], DRUM_R, DRUM_Z, DRUM_H, P, 48, 0.6), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(DRUM[0], DRUM[1], DRUM_R, DRUM_TOP - 3.0, DRUM_TOP, 48, P, 0.3), { tone: "lo" }));
  out.push(L(k.sideArc(DRUM[0], DRUM[1], DRUM_R, DRUM_TOP - 3.0, P, 32), { tone: "faint" }));
  out.push(L(k.ring(DRUM[0], DRUM[1], DRUM_R - 1.8, DRUM_TOP, P, 36), { tone: "lo" }));
  const drumTicks = k.radialTicks(DRUM[0], DRUM[1], DRUM_R - 2.2, 24, 4, DRUM_TOP, [1.1, 2.2], P);
  out.push(L(drumTicks.minor, { tone: "lo" }), L(drumTicks.major, { tone: "mid" }));
  out.push(L(k.ring(DRUM[0], DRUM[1], 1.4, DRUM_TOP, P, 16), { tone: "mid" }));

  // Braided AST Extraction Conduit from Station 2 Front Column Base to Front-Left Ledger Drum
  const pressFrontPort = at([-4, 20, 6]);
  const pipeVia1 = at([-28, 34, 4]);
  const pipeVia2 = at([-62, 38, DRUM_Z]);
  const drumIn = at([LEDGER_BASE.x + LEDGER_BASE.w - 4.5, LEDGER_BASE.y + 12, LEDGER_BASE_H]);
  out.push(
    `<g class="ledger-wire">${W(pressFrontPort, drumIn, { via: [pipeVia1, pipeVia2], tone: "mid", ends: "both", size: 1.1 })}</g>`,
  );

  return out.join("");
}

const dialNeedleAt = (turn) => {
  const angle = turn * Math.PI * 2;
  const [x, y] = DIAL;
  return k.lineOnTop(
    [x - Math.sin(angle) * 3.2, y + Math.cos(angle) * 3.2],
    [x + Math.sin(angle) * (DIAL_R - 3.6), y - Math.cos(angle) * (DIAL_R - 3.6)],
    DIAL_TOP + 0.2,
    P,
  );
};

const drumNeedleAt = (turn) => {
  const angle = turn * Math.PI * 2;
  const [x, y] = DRUM;
  return k.lineOnTop(
    [x - Math.sin(angle) * 2.2, y + Math.cos(angle) * 2.2],
    [x + Math.sin(angle) * (DRUM_R - 2.8), y - Math.cos(angle) * (DRUM_R - 2.8)],
    DRUM_TOP + 0.2,
    P,
  );
};

const initSt = STATIONS[0];
const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "An isometric 4-stage progressive rolling mill and baton relay line explaining Vicem. A raw context block (42.8k tokens) enters on the left from the Source Agent Hopper and travels right through Station 1 (NoiseGate Sieve, 14.6k tokens), Station 2 (AST Skeletonizer Hydraulic Press connected to the .vicem/ledger.json Indexing Drum, 4.85k tokens), Station 3 (Log/Data Calender & Micrometer Dial Gauge, 2.64k tokens), and docks at Station 4 as a compacted 1.92k-token Baton wired to the Target Agent Receiver Terminal.",
  body: [
    surfacePlate(),
    backStations(),
    transferBed(),
    `<g data-part="workpiece">${buildWorkpieceSvg(initSt.x, initSt.w, initSt.d, initSt.h, P)}</g>`,
    overheadAndFrontStations(),
    `<path data-part="drum-needle" class="iso-line" data-tone="hi" data-free="both" d="${drumNeedleAt(0.1)}" style="stroke-width:1.05"/>`,
    `<path data-part="dial-needle" class="iso-line" data-tone="lit" data-free="both" d="${dialNeedleAt(initSt.h / PER_TURN)}" style="stroke-width:1.15"/>`,
  ],
});

const EXTRA_CSS = `
.iso-stage[data-docked="1"] .relay-wire .iso-line { stroke: var(--anatomy-lit); stroke-width: 1.3; }
.iso-stage[data-ast="1"] .ledger-wire .iso-line { stroke: var(--anatomy-lit); stroke-width: 1.25; }
`;

const live = `
const P = ${JSON.stringify(P)};
const STATIONS = ${JSON.stringify(STATIONS)};
const STOPS = ${JSON.stringify(STOPS)};
const REACH = ${JSON.stringify(REACH)};
const DIAL = ${JSON.stringify(DIAL)};
const DRUM = ${JSON.stringify(DRUM)};
const DIAL_R = ${DIAL_R}, DIAL_TOP = ${DIAL_TOP}, DRUM_R = ${DRUM_R}, DRUM_TOP = ${DRUM_TOP}, PER_TURN = ${PER_TURN}, BED_TOP = ${BED_TOP};
const stage = document.querySelector(".iso-stage");
const svg = stage.querySelector("svg");
const workpieceEl = svg.querySelector('[data-part="workpiece"]');
const gate1El = svg.querySelector('[data-part="gate1"]');
const ram2El = svg.querySelector('[data-part="ram2"]');
const plungerEl = svg.querySelector('[data-part="plunger"]');
const dialNeedleEl = svg.querySelector('[data-part="dial-needle"]');
const drumNeedleEl = svg.querySelector('[data-part="drum-needle"]');
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const dialNeedleAt = ${dialNeedleAt.toString().replace("k.lineOnTop", "lineOnTop")};
const drumNeedleAt = ${drumNeedleAt.toString().replace("k.lineOnTop", "lineOnTop")};

function profileAt(cx) {
  const x = clamp(cx, REACH[0], REACH[1]);
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = STATIONS[i], b = STATIONS[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      const s = t * t * (3 - 2 * t);
      return {
        w: a.w + (b.w - a.w) * s,
        d: a.d + (b.d - a.d) * s,
        h: a.h + (b.h - a.h) * s,
        progress: (i + s) / (STATIONS.length - 1),
      };
    }
  }
  const last = STATIONS[STATIONS.length - 1];
  return { w: last.w, d: last.d, h: last.h, progress: 1 };
}

function nearestStation(cx) {
  let best = 0;
  for (let i = 1; i < STATIONS.length; i++) {
    if (Math.abs(STATIONS[i].x - cx) < Math.abs(STATIONS[best].x - cx)) best = i;
  }
  return STATIONS[best];
}

function renderWorkpiece(cx, w, d, h) {
  const shoe = { x: cx - w / 2 - 2.2, y: -d / 2 - 1.5, w: w + 4.4, d: d + 3, r: 2 };
  const plan = { x: cx - w / 2, y: -d / 2, w, d, r: 1.8 };
  const z0 = BED_TOP, zShoe = z0 + 1.8, zTop = zShoe + h;
  const bossR = Math.min(w, d) * 0.24;
  return (
    solidSvg(slabOf(shoe, z0, 1.8, P, 4, 0.4), { tone: "mid" }) +
    solidSvg(slabOf(plan, zShoe, h, P, 4, 0.65), { tone: "hi", crease: "lo", lit: true }) +
    lineSvg(planOutline(insetPlan(plan, 2.1), zTop, P, 3), { tone: "lo" }) +
    lineSvg(ring(cx, 0, bossR, zTop, P, 20), { tone: "mid" }) +
    dotsSvg([iso([cx, 0, zTop], P)], { size: 0.5, tone: "hi" })
  );
}

let x = STOPS[0], target = STOPS[0];
let tip = { at: BED_TOP + STATIONS[0].h, rate: 0 };
let frame = 0, last = 0, clock = 0, touring = true, visible = false, idleTimer = 0;
const tourAt = (t) => STOPS[Math.floor(t / 2.0) % STOPS.length];

function draw() {
  const prof = profileAt(x);
  workpieceEl.innerHTML = renderWorkpiece(x, prof.w, prof.d, prof.h);

  // Station 1 Sieve Gate strokes down onto workpiece top when near x = -52
  const dist1 = Math.abs(x - (-52));
  const stroke1 = dist1 < 22 ? Math.cos((dist1 / 22) * Math.PI * 0.5) * -4.2 : 0;
  gate1El.setAttribute("transform", translateAlong(P, [0, 0, stroke1]));

  // Station 2 Hydraulic Press Ram strokes down onto workpiece top when near x = -4
  const dist2 = Math.abs(x - (-4));
  const stroke2 = dist2 < 24 ? Math.cos((dist2 / 24) * Math.PI * 0.5) * -7.2 : 0;
  ram2El.setAttribute("transform", translateAlong(P, [0, 0, stroke2]));

  // Station 3 Plunger rests on the reference anvil (z = 14) and lifts when the workpiece passes under S3 (x = 44)
  const dist3 = Math.abs(x - 44);
  const plungerZ = dist3 < 20 ? 14 + Math.cos((dist3 / 20) * Math.PI * 0.5) * 2.2 : 14;
  plungerEl.setAttribute("transform", translateAlong(P, [0, 0, plungerZ]));

  // Micrometer Dial Needle tracks live compressed workpiece height across all 5 stations
  dialNeedleEl.setAttribute("d", dialNeedleAt((tip.at - BED_TOP) / PER_TURN));

  // Rehydration Ledger Drum Needle rotates as AST symbols are indexed
  const drumTurn = 0.08 + prof.progress * 0.72;
  drumNeedleEl.setAttribute("d", drumNeedleAt(drumTurn));

  // Highlight Ledger Conduit at Station 2 and Relay Conduit at Station 4
  if (dist2 < 18) stage.setAttribute("data-ast", "1");
  else stage.removeAttribute("data-ast");

  if (x >= 76) stage.setAttribute("data-docked", "1");
  else stage.removeAttribute("data-docked");

  const st = nearestStation(x);
  const text = st.code + " · " + st.tokens + " tok (" + st.saving + ")";
  if (readout.textContent !== text) readout.textContent = text;
  stage.setAttribute("aria-valuenow", String(Math.round(prof.h)));
  stage.setAttribute("aria-valuetext", text);
}

function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  const calm = still.matches;
  if (touring) { clock += dt; target = tourAt(clock); }
  x = calm ? target : x + (target - x) * (1 - Math.exp(-dt / 0.24));
  if (Math.abs(target - x) < 0.02) x = target;

  const prof = profileAt(x);
  const want = BED_TOP + prof.h;
  const stiff = 420, drag = calm ? 2 * Math.sqrt(420) : 26;
  for (let i = 0; i < 4; i++) {
    tip.rate += ((want - tip.at) * stiff - tip.rate * drag) * dt / 4;
    tip.at += tip.rate * dt / 4;
  }
  if (Math.abs(want - tip.at) < 0.005 && Math.abs(tip.rate) < 0.005) { tip.at = want; tip.rate = 0; }

  draw();
  const settled = !touring && x === target && tip.rate === 0 && tip.at === want;
  frame = visible && !settled ? requestAnimationFrame(tick) : 0;
}

const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
const steer = (next) => {
  touring = false;
  target = clamp(next, REACH[0], REACH[1]);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { touring = !still.matches; clock = 0; run(); }, 4000);
  run();
};

new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  if (visible) run();
}, { rootMargin: "120px 0px" }).observe(stage);

if (still.matches) touring = false;

stage.addEventListener("pointermove", (event) => {
  const box = svg.getBoundingClientRect();
  const share = clamp(((event.clientX - box.left) / box.width - 0.14) / 0.72, 0, 1);
  steer(REACH[0] + share * (REACH[1] - REACH[0]));
});
stage.addEventListener("pointerleave", () => steer(target));
stage.addEventListener("keydown", (event) => {
  const here = STOPS.reduce((best, stop, idx) => (Math.abs(stop - target) < Math.abs(STOPS[best] - target) ? idx : best), 0);
  let to = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") to = Math.min(STOPS.length - 1, here + 1);
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") to = Math.max(0, here - 1);
  if (event.key === "0") to = 0;
  if (event.key === "1") to = 1;
  if (event.key === "2") to = 2;
  if (event.key === "3") to = 3;
  if (event.key === "4") to = 4;
  if (event.key === "Home") to = 0;
  if (event.key === "End") to = STOPS.length - 1;
  if (to === null) return;
  event.preventDefault();
  steer(STOPS[to]);
});
window.addEventListener("message", (ev) => {
  if (!ev.data || typeof ev.data !== "object") return;
  if (typeof ev.data.station === "number") {
    const idx = clamp(ev.data.station, 0, STOPS.length - 1);
    steer(STOPS[idx]);
  }
  if (ev.data.tokens && Array.isArray(ev.data.tokens) && ev.data.tokens.length === 5) {
    for (let i = 0; i < 5; i++) {
      if (ev.data.tokens[i].tokens) STATIONS[i].tokens = ev.data.tokens[i].tokens;
      if (ev.data.tokens[i].saving) STATIONS[i].saving = ev.data.tokens[i].saving;
    }
    draw();
  }
});
draw();
`;

const body = k.plateHtml({
  fig: "Fig 1",
  title: "Vicem Progressive Context Mill & Baton Relay Line",
  hint: "Hover or press 0–4 / ← → to drive the baton relay",
  readout: `${STATIONS[0].code} · ${STATIONS[0].tokens} tok (${STATIONS[0].saving})`,
  keys: [
    { mark: "lit", label: "Live Context Ingot → Baton: shrinks from 42.8k raw tokens (20 mm) down to a 1.92k-token Baton (5 mm) as it travels from Source Hopper to Target Agent Dock" },
    { mark: "raised", label: "S1 NoiseGate Sieve · S2 AST Hydraulic Press + Ledger Drum · S3 Micrometer Comparator · S4 Guarded Relay Terminal" },
  ],
  caption:
    "A progressive rolling mill and relay transfer line. A bulky 42.8k-token raw context block enters at left (S0) and slides along twin ways: S1 (NoiseGate Sieve) shears lockfiles and build noise to 14.6k tokens (-65.9%); S2 (AST Hydraulic Press) stamps function bodies >=12 lines into the front-left Rehydration Ledger Drum (.vicem/ledger.json) at 4.85k tokens (-88.7%); S3 (Micrometer Comparator) gauges log/data slimming at 2.64k tokens (-93.8%); and S4 docks the 1.92k-token (-95.5%) Baton into the Target Agent Receiver Terminal.",
  body: `<style>${EXTRA_CSS}</style><div class="iso-stage" tabindex="0" role="slider" aria-label="Vicem Progressive Context Mill: move pointer or press keys 0 to 4 to compress the context block and hand off the baton" aria-valuemin="5" aria-valuemax="20" aria-valuenow="20">${svg}</div>`,
});

const outFile = theme === "light" ? "vicem-anatomy-light.html" : "vicem-anatomy.html";
writeFileSync(
  join(HERE, outFile),
  k.pageHtml({
    title: "Vicem Progressive Context Mill & Baton Relay Line",
    theme,
    body,
    script: kitScript() + live,
    width: 680,
  }),
);
console.log("wrote", join(HERE, outFile));

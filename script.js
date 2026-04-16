let audioUnlocked = false;

// Shared AudioContext – created once, reused by all Audio elements via the
// browser's internal audio graph.  We keep a reference so we can call
// .resume() on the first user gesture (required by Chrome autoplay policy).
let _sharedAudioCtx = null;
const getAudioCtx = () => {
  if (!_sharedAudioCtx) {
    try {
      _sharedAudioCtx = new (
        window.AudioContext || window.webkitAudioContext
      )();
    } catch (e) {
      // AudioContext not available (very old browser) – ignore
    }
  }
  return _sharedAudioCtx;
};

const unlockAudio = () => {
  if (audioUnlocked) return;
  audioUnlocked = true;

  // 1. Resume the shared AudioContext (handles Chrome's autoplay policy)
  const ctx = getAudioCtx();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  // 2. Play a silent, correctly-formed WAV through a real Audio element so
  //    the browser marks the page as having "had media interaction".
  //    NOTE: the original code had "base64;" (semicolon) which is invalid –
  //    the correct separator is a comma: "base64,".
  try {
    const a = new Audio();
    // Minimal valid 1-sample silent WAV, base64-encoded (comma, not semicolon)
    a.src =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    a.volume = 0;
    a.play().catch(() => {});
  } catch (e) {
    // Ignore – the AudioContext resume above is the important part
  }

  console.log("🔊 Audio unlocked");
};

// Unlock on first user interaction (mouse or touch)
document.addEventListener("mousedown", unlockAudio, { once: true });
document.addEventListener("touchstart", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });

// ─────────────────────────────────────────────────────────────
//  SOUND SYNTHESIZER  (sfxr-style, procedural WAV generator)
// ─────────────────────────────────────────────────────────────
(() => {
  class SoundParams {
    /**
     * Load 24 numeric parameters from an array (a–x mapped to indices 0–23).
     * Ensures minimum values so the synthesiser never divides by zero.
     */
    load(params) {
      const letters = "abcdefghijklmnopqrstuvwx";
      letters.split("").forEach((ch, i) => {
        this[ch] = params[i] ?? 0;
      });
      if (this.c < 0.01) this.c = 0.01;
      let sum = this.b + this.c + this.e;
      if (sum < 0.18) {
        const scale = 0.18 / sum;
        this.b *= scale;
        this.c *= scale;
        this.e *= scale;
      }
    }
  }

  const synth = new (class {
    constructor() {
      this.params = new SoundParams();
    }

    /** Returns total sample count for the current envelope. */
    _calcSampleCount() {
      this._reset();
      const { b, c, e } = this.params;
      this._attack = 1e5 * b * b;
      this._sustain = 1e5 * c * c;
      this._release = 1e5 * e * e + 12;
      return 3 * (((this._attack + this._sustain + this._release) / 3) | 0);
    }

    _reset() {
      const p = this.params;
      this._freqSlide = 100 / (p.f * p.f + 0.001);
      this._freqLimit = 100 / (p.g * p.g + 0.001);
      this._slideDecay = 1 - 0.01 * p.h ** 3;
      this._slideAccel = -1e-6 * p.i ** 3;
      if (!p.a) {
        this._dutyCycle = 0.5 - p.n / 2;
        this._dutySweep = -5e-5 * p.o;
      }
      this._repeatSpeed = 1 + p.l ** 2 * (p.l > 0 ? -0.9 : 10);
      this._repeatTimer = 0;
      this._repeatPeriod = p.m === 1 ? 0 : 2e4 * (1 - p.m) ** 2 + 32;
    }

    /** Fills `buffer` with `length` PCM samples; returns samples written. */
    _generate(buffer, length) {
      this._reset();
      const p = this.params;

      const hasFilter = p.s !== 1 || p.v;
      let filterMult = 0.1 * p.v * p.v;
      const filterGrow = 1 + 3e-4 * p.w;
      let filterPos = 0.1 * p.s ** 3;
      const filterPosG = 1 + 1e-4 * p.t;
      const doFilter = p.s !== 1;
      const vibratoAmt = p.x * p.x;
      const freqLimitRef = p.g;
      const doPhaser = !!(p.q || p.r);
      let phaserSweep = 0.2 * p.r ** 3;
      let phaserPos = p.q ** 2 * (p.q < 0 ? -1020 : 1020);
      const repPeriod = p.p ? ((2e4 * (1 - p.p) ** 2) | 0) + 32 : 0;
      const envShape = p.d;
      const vibratoFreq = p.j / 2;
      let vibratoPhase = 0;
      const vibratoDepth = 0.01 * p.k * p.k;
      const waveType = p.a;

      // Envelope state
      let attack = this._attack;
      let sustain = this._sustain;
      let release = this._release;
      let envPhase = 0,
        envStep = 0,
        envVol = 0;
      let repeatTimer = 0;
      let freqSlide = this._freqSlide;
      let freq = freqSlide;

      // Filter state
      let filterLow = 0,
        filterBand = 0,
        filterHigh = 0;

      // Phaser buffer
      const phaserBuf = new Array(1024).fill(0);
      const noiseBuf = Array.from({ length: 32 }, () => Math.random() * 2 - 1);
      let phaserIdx = 0;

      // Oscillator state
      let phase = 0,
        oscPhase = 0;
      let repeatCount = 0;
      let done = false;

      // Low-pass filter blend (1 = sharp, 0 = off)
      let lpBlend = 0.8;
      {
        const raw = 1 - (5 / (1 + 20 * p.u * p.u)) * (0.01 + filterPos);
        lpBlend = Math.min(raw, 0.8);
      }

      // Counts per envelope phase
      let phaseLen = attack;
      let envStage = 0;

      for (let i = 0; i < length; i++) {
        if (done) return i;

        // Repeat
        if (repPeriod && ++repeatTimer >= repPeriod) {
          repeatTimer = 0;
          this._reset();
          freqSlide = this._freqSlide;
          freq = freqSlide;
        }

        // Slide
        freqSlide += this._slideAccel;
        freqSlide *= this._slideDecay;
        freq *= freqSlide;
        if (freq > this._freqLimit) {
          freq = this._freqLimit;
          if (freqLimitRef > 0) done = true;
        }

        // Vibrato
        let curFreq = freq;
        if (vibratoFreq > 0) {
          vibratoPhase += vibratoDepth;
          curFreq *= 1 + Math.sin(vibratoPhase) * vibratoFreq;
        }
        curFreq = Math.max(8, curFreq | 0);

        // Duty cycle sweep
        if (!waveType) {
          this._dutyCycle += this._dutySweep;
          this._dutyCycle = Math.max(0, Math.min(0.5, this._dutyCycle));
        }

        // Envelope
        if (++envStep > phaseLen) {
          envStep = 0;
          envStage++;
          switch (envStage) {
            case 1:
              phaseLen = sustain;
              break;
            case 2:
              phaseLen = release;
              break;
          }
        }
        switch (envStage) {
          case 0:
            envVol = envStep / attack;
            break;
          case 1:
            envVol = 1 + 2 * (1 - envStep / sustain) * envShape;
            break;
          case 2:
            envVol = 1 - envStep / release;
            break;
          case 3:
            envVol = 0;
            done = true;
            break;
        }

        // Phaser update
        if (doPhaser) {
          phaserPos += phaserSweep;
          const pi = Math.abs(phaserPos | 0);
          phaserPos = pi > 1023 ? (pi === phaserPos ? 1023 : -1023) : phaserPos;
        }

        // Filter update
        if (hasFilter && filterGrow) {
          filterMult *= filterGrow;
          filterMult = Math.max(1e-5, Math.min(0.1, filterMult));
        }

        // 8× oversampling
        let sample = 0;
        for (let s = 0; s < 8; s++) {
          oscPhase++;
          if (oscPhase >= curFreq) {
            oscPhase %= curFreq;
            if (waveType === 3) {
              for (let n = 0; n < 32; n++) noiseBuf[n] = Math.random() * 2 - 1;
            }
          }

          // Waveform
          let wave;
          const t = oscPhase / curFreq;
          switch (waveType) {
            case 0:
              wave = t < this._dutyCycle ? 0.5 : -0.5;
              break;
            case 1:
              wave = 1 - 2 * t;
              break;
            case 2: {
              const s2 = 6.28318531 * (t < 0.5 ? t : t - 1);
              const s3 =
                1.27323954 * s2 + 0.405284735 * s2 * s2 * (s2 < 0 ? 1 : -1);
              wave = 0.225 * ((s3 < 0 ? -1 : 1) * s3 * s3 - s3) + s3;
              break;
            }
            case 3:
              wave = noiseBuf[Math.abs(((32 * oscPhase) / curFreq) | 0)];
              break;
            default:
              wave = 0;
          }

          // Low-pass / band-pass / high-pass filter
          if (hasFilter) {
            const prev = filterLow;
            filterPos = Math.max(
              0,
              Math.min(0.1, doFilter ? filterPos * filterPosG : filterPos),
            );
            filterBand += (wave - filterLow) * filterPos;
            filterBand *= lpBlend;
            filterLow += filterBand;
            filterHigh = filterLow;
            wave = filterHigh *= 1 - filterMult;
          }

          // Phaser
          if (doPhaser) {
            phaserBuf[phaserIdx % 1024] = wave;
            wave +=
              phaserBuf[(phaserIdx - Math.abs(phaserPos | 0) + 1024) % 1024];
            phaserIdx++;
          }

          sample += wave;
        }

        sample *= 0.125 * envVol * vibratoAmt;
        buffer[i] =
          sample >= 1 ? 32767 : sample <= -1 ? -32768 : (32767 * sample) | 0;
      }

      return length;
    }
  })();

  /**
   * Exposed global: takes a 24-element parameter array, synthesises a sound,
   * and returns a base64 WAV data URL.
   */
  window.SOUND = (params) => {
    synth.params.load(params);
    const sampleCount = synth._calcSampleCount();
    const wavBytes = new Uint8Array(4 * (((sampleCount + 1) / 2) | 0) + 44);
    const pcmSamples =
      synth._generate(new Uint16Array(wavBytes.buffer, 44), sampleCount) * 2;

    // Write WAV header
    const header = new Uint32Array(wavBytes.buffer, 0, 44);
    header[0] = 0x46464952; // 'RIFF'
    header[1] = pcmSamples + 36;
    header[2] = 0x45564157; // 'WAVE'
    header[3] = 0x20746d66; // 'fmt '
    header[4] = 16;
    header[5] = 0x00010001; // PCM mono
    header[6] = 44100;
    header[7] = 88200;
    header[8] = 0x00100002;
    header[9] = 0x61746164; // 'data'
    header[10] = pcmSamples;

    // Base64 encode
    const B64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = "data:audio/wav;base64,";
    const total = pcmSamples + 44;
    for (let i = 0; i < total; i += 3) {
      const n = (wavBytes[i] << 16) | (wavBytes[i + 1] << 8) | wavBytes[i + 2];
      result +=
        B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    return result;
  };
})();

// ─────────────────────────────────────────────────────────────
//  GAME
// ─────────────────────────────────────────────────────────────
(() => {
  // ── Constants & canvas setup ──────────────────────────────
  const CANVAS_W = 960;
  const CANVAS_H = 540;
  const ASPECT = 16 / 9;
  const GRAVITY = 0.6;
  const ATTRACT = 0.1; // merge attraction strength
  const ITERATIONS = 40; // verlet solver iterations per frame
  const FRICTION = 0.9; // velocity damping on floor bounce
  const DRAG_EASE = 0.24; // how quickly dragged vertex follows cursor
  const AUTO_SPAWN_MS = 4000; // ms between automatic tile drops (independent of merges)

  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);

  const container = document.getElementById("container");
  const backCanvas = document.getElementById("backcanvas");
  const frontCanvas = document.getElementById("canvas");
  const backCtx = backCanvas.getContext("2d");
  const frontCtx = frontCanvas.getContext("2d");
  const loadScreen = document.getElementById("load");
  const homeScreen = document.getElementById("home");
  const endScreen = document.getElementById("end");
  const startBtn = document.getElementById("start");
  const resetBtn = document.getElementById("reset");

  // Resolve vendor-prefixed transform
  const TRANSFORM_PROP =
    "transform" in container.style ? "transform" : "webkitTransform";

  backCanvas.width = frontCanvas.width = CANVAS_W;
  backCanvas.height = frontCanvas.height = CANVAS_H;

  frontCtx.lineWidth = 2;
  frontCtx.textAlign = "center";
  frontCtx.textBaseline = "middle";

  // Tile colours matching original 2048 palette
  const TILE_COLORS = new Map([
    [2, "#eee4da"],
    [4, "#ede0c8"],
    [8, "#f2b179"],
    [16, "#f59563"],
    [32, "#f67c5f"],
    [64, "#f65e3b"],
    [128, "#edcf72"],
    [256, "#edcc61"],
    [512, "#edc850"],
    [1024, "#edc53f"],
    [2048, "#edc22e"],
  ]);

  // ── Pointer state ─────────────────────────────────────────
  const pointer = { dragging: false, x: 0, y: 0 };
  let dragVertex = null; // currently dragged Vertex

  // ── Physics world state ───────────────────────────────────
  let bodies = []; // all RigidBody instances
  let vertices = []; // all Vertex instances
  let constraints = []; // all Constraint instances
  let tileCount = {}; // { value: count }
  let autoSpawnTimer = null; // setInterval handle for timed drops

  // ── Vec2 class ────────────────────────────────────────────
  class Vec2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }

    set(x, y) {
      this.x = x;
      this.y = y;
      return this;
    }
    copyFrom(v) {
      this.x = v.x;
      this.y = v.y;
      return this;
    }
    add(v) {
      this.x += v.x;
      this.y += v.y;
      return this;
    }
    sub(v) {
      this.x -= v.x;
      this.y -= v.y;
      return this;
    }
    scale(s) {
      this.x *= s;
      this.y *= s;
      return this;
    }
    dot(v) {
      return this.x * v.x + this.y * v.y;
    }
    length() {
      return Math.sqrt(this.x ** 2 + this.y ** 2);
    }
    distance(v) {
      return Math.sqrt((this.x - v.x) ** 2 + (this.y - v.y) ** 2);
    }

    /** this = a − b */
    setDiff(a, b) {
      this.x = a.x - b.x;
      this.y = a.y - b.y;
      return this;
    }

    /** this = v * s */
    setScaled(v, s) {
      this.x = v.x * s;
      this.y = v.y * s;
      return this;
    }

    /** this = unit normal of edge (a→b) */
    setNormal(a, b) {
      const nx = a.y - b.y;
      const ny = b.x - a.x;
      const len = Math.sqrt(nx * nx + ny * ny);
      if (len < Number.MIN_VALUE) {
        this.x = nx;
        this.y = ny;
        return this;
      }
      this.x = nx / len;
      this.y = ny / len;
      return this;
    }
  }

  // Shared temp vectors (avoid allocation in hot path)
  const tmpA = new Vec2();
  const tmpB = new Vec2();

  // ── Vertex (Verlet point) ─────────────────────────────────
  class Vertex {
    constructor(body, x, y) {
      this.body = body;
      this.position = new Vec2(x, y);
      this.oldPosition = new Vec2(x, y);
      body.vertices.push(this);
      body.positions.push(this.position);
      vertices.push(this);
    }

    integrate() {
      const { position: p, oldPosition: o } = this;
      const vx = p.x - o.x;
      const vy = p.y - o.y;
      o.set(p.x, p.y);

      p.x += vx;
      p.y += vy + GRAVITY;

      // Floor bounce
      if (p.y >= frontCanvas.height + 250) {
        p.x -= vx * FRICTION;
        p.y = frontCanvas.height - 1;
      }
      // Ceiling clamp
      if (p.y < -100) p.y = -100;
      // Side walls
      if (p.x < 0) p.x = 0;
      else if (p.x >= frontCanvas.width) p.x = frontCanvas.width - 1;
    }
  }

  // ── Fixed vertex (anchor point, doesn't move) ────────────
  class AnchorVertex extends Vertex {
    constructor(body, x, y) {
      super(body, x, y);
      this.ax = x;
      this.ay = y;
    }
    integrate() {
      this.position.set(this.ax, this.ay);
      this.oldPosition.set(this.ax, this.ay);
    }
  }

  // ── Constraint (spring between two vertices) ─────────────
  class Constraint {
    constructor(body, v0, v1, stiffness, isBoundary = false) {
      this.body = body;
      this.v0 = v0;
      this.v1 = v1;
      this.p0 = v0.position;
      this.p1 = v1.position;
      this.restLength = this.p0.distance(this.p1);
      this.stiffness = stiffness;
      this.isBoundary = isBoundary;
      body.constraints.push(this);
      if (isBoundary) body.boundaries.push(this);
      constraints.push(this);
    }

    solve() {
      tmpA.setDiff(this.p0, this.p1);
      const len = tmpA.length();
      if (!len) return;
      tmpA.scale((this.stiffness * (this.restLength - len)) / len);
      this.p0.add(tmpA);
      this.p1.sub(tmpA);
    }
  }

  // ── RigidBody base class ──────────────────────────────────
  class RigidBody {
    constructor(mass = 1) {
      this.mass = mass;
      this.vertices = [];
      this.positions = [];
      this.constraints = [];
      this.boundaries = [];
      this.center = new Vec2();
      this.halfExtents = new Vec2();
      this._min = 0;
      this._max = 0;
    }

    /** Compute AABB and centre. */
    updateBounds() {
      let minX = 99999,
        minY = 99999,
        maxX = -99999,
        maxY = -99999;
      for (const p of this.positions) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      this.center.set(0.5 * (minX + maxX), 0.5 * (minY + maxY));
      this.halfExtents.set(0.5 * (maxX - minX), 0.5 * (maxY - minY));
    }

    /** Project body onto axis; stores _min / _max. */
    project(axis) {
      this._min = 99999;
      this._max = -99999;
      for (const p of this.positions) {
        const d = p.dot(axis);
        if (d < this._min) this._min = d;
        if (d > this._max) this._max = d;
      }
    }

    /** Pick nearest vertex to pointer and begin drag if hovering. */
    tryDrag() {
      if (!pointer.dragging || dragVertex) return;
      if (!frontCtx.isPointInPath(pointer.x, pointer.y)) return;

      let best = 99999;
      for (const v of this.vertices) {
        const d = v.position.distance(pointer);
        if (d < best) {
          best = d;
          dragVertex = v;
        }
      }
    }
  }

  // ── Rounded platform / ramp ───────────────────────────────
  const CHAMFER = 10;

  class Platform extends RigidBody {
    constructor(x, y, w, h, addToWorld = true) {
      super(250);

      const a0 = (this.handle0 = new AnchorVertex(this, x, y + CHAMFER));
      const a1 = new AnchorVertex(this, x + CHAMFER, y);
      const a2 = new AnchorVertex(this, x + w - CHAMFER, y);
      const a3 = (this.handle1 = new AnchorVertex(this, x + w, y + CHAMFER));
      const a4 = new AnchorVertex(this, x + w, y + h);
      const a5 = new AnchorVertex(this, x, y + h);

      // Boundary edges (outer hull)
      new Constraint(this, a0, a1, 0.1, true);
      new Constraint(this, a1, a2, 0.1, true);
      new Constraint(this, a2, a3, 0.1, true);
      new Constraint(this, a3, a4, 0.1, true);
      new Constraint(this, a4, a5, 0.1, true);
      new Constraint(this, a5, a0, 0.1, true);

      // Internal braces
      new Constraint(this, a0, a3, 0.1);
      new Constraint(this, a0, a4, 0.1);
      new Constraint(this, a1, a4, 0.1);
      new Constraint(this, a1, a5, 0.1);
      new Constraint(this, a2, a4, 0.1);
      new Constraint(this, a2, a5, 0.1);
      new Constraint(this, a3, a5, 0.1);

      if (addToWorld) bodies.push(this);
    }

    /** High quality: full sofa — seat, backrest, armrests, cushion details. */
    paint(ctx, color = "#00B0FF") {
      const ps = this.positions;
      // vertex order: a0=left-top-chamfer, a1=left-top, a2=right-top,
      //               a3=right-top-chamfer, a4=bottom-right, a5=bottom-left
      const x0 = ps[5].x; // left edge
      const x1 = ps[4].x; // right edge
      const yTop = ps[1].y; // seat surface
      const yBot = ps[4].y; // seat bottom
      const W = x1 - x0;
      const H = yBot - yTop;
      const R = 8; // universal corner radius

      // helper: filled rounded rect
      const rr = (rx, ry, rw, rh, rad, fill, stroke) => {
        ctx.beginPath();
        ctx.moveTo(rx + rad, ry);
        ctx.lineTo(rx + rw - rad, ry);
        ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rad);
        ctx.lineTo(rx + rw, ry + rh - rad);
        ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rad, ry + rh);
        ctx.lineTo(rx + rad, ry + rh);
        ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rad);
        ctx.lineTo(rx, ry + rad);
        ctx.quadraticCurveTo(rx, ry, rx + rad, ry);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      };

      // ── colour palette derived from the passed colour ─────
      // We ignore `color` for the main sofa and use a fixed blue palette
      // so each layer reads clearly. The side platforms still pass their own
      // semi-transparent colour and get the simple seat only.
      const isMainSofa = W > 200;

      if (!isMainSofa) {
        // Side platforms: simple rounded rect (leg / armrest block)
        const g = ctx.createLinearGradient(x0, yTop, x0, yBot);
        g.addColorStop(0, "rgba(79,195,247,0.55)");
        g.addColorStop(1, "rgba(2,136,209,0.55)");
        ctx.beginPath();
        const [p0, p1] = ps;
        ctx.moveTo(0.5 * (p0.x + p1.x), 0.5 * (p0.y + p1.y));
        for (let i = 1; i <= 6; i++) {
          const cur = ps[i % 6];
          const next = ps[(i + 1) % 6];
          if (i === 4 || i === 5) ctx.lineTo(cur.x, cur.y);
          else
            ctx.quadraticCurveTo(
              cur.x,
              cur.y,
              0.5 * (cur.x + next.x),
              0.5 * (cur.y + next.y),
            );
        }
        ctx.fillStyle = g;
        ctx.fill();
        return;
      }

      // ════════════════════════════════════════════════════════
      //  MAIN SOFA
      // ════════════════════════════════════════════════════════

      // Palette
      const cBase = "#1565C0"; // deep blue body
      const cMid = "#1976D2";
      const cLight = "#42A5F5"; // highlight face
      const cDark = "#0D47A1"; // shadow face
      const cAccent = "#29B6F6"; // cushion lighter
      const cSeam = "rgba(0,0,0,0.18)";
      const cShine = "rgba(255,255,255,0.18)";

      // ── 1. BACKREST (behind seat, drawn first) ─────────────
      const brW = W * 0.82;
      const brH = H * 1.8; // tall backrest
      const brX = x0 + (W - brW) * 0.5;
      const brY = yTop - brH;

      // back face (darker, gives 3-D depth)
      const gBr = ctx.createLinearGradient(brX, brY, brX, yTop);
      gBr.addColorStop(0, cMid);
      gBr.addColorStop(1, cDark);
      rr(brX, brY, brW, brH + 4, R, gBr, null);

      // top highlight strip on backrest
      ctx.fillStyle = cShine;
      rr(brX + 6, brY + 5, brW - 12, 8, 4, cShine, null);

      // cushion line on backrest (horizontal seam near top-third)
      const seamY = brY + brH * 0.38;
      ctx.fillStyle = cSeam;
      ctx.fillRect(brX + 12, seamY, brW - 24, 3);

      // ── 2. ARMRESTS (left & right, drawn before seat) ──────
      const armW = 46;
      const armH = H + brH * 0.55; // armrest top sits at backrest mid-height
      const armY = yTop - armH + H; // bottom flush with seat bottom
      const armLX = x0 - 4;
      const armRX = x1 - armW + 4;

      for (const [ax, isLeft] of [
        [armLX, true],
        [armRX, false],
      ]) {
        // side shadow face (gives thickness illusion)
        const sideX = isLeft ? ax - 6 : ax + armW;
        ctx.fillStyle = cDark;
        ctx.beginPath();
        ctx.moveTo(sideX, armY + R);
        ctx.lineTo(sideX, armY + armH);
        ctx.lineTo(sideX + (isLeft ? 6 : -6), armY + armH);
        ctx.lineTo(sideX + (isLeft ? 6 : -6), armY + R);
        ctx.fill();

        const gArm = ctx.createLinearGradient(ax, armY, ax, armY + armH);
        gArm.addColorStop(0, cLight);
        gArm.addColorStop(0.4, cMid);
        gArm.addColorStop(1, cDark);
        rr(ax, armY, armW, armH, R, gArm, null);

        // armrest top shine
        ctx.fillStyle = cShine;
        rr(ax + 5, armY + 4, armW - 10, 7, 3, cShine, null);
      }

      // ── 3. SEAT CUSHION ────────────────────────────────────
      const seatGrad = ctx.createLinearGradient(x0, yTop, x0, yBot);
      seatGrad.addColorStop(0, cAccent);
      seatGrad.addColorStop(0.6, cMid);
      seatGrad.addColorStop(1, cDark);

      // main seat shape (original Verlet polygon, curved top)
      ctx.beginPath();
      const [p0, p1] = ps;
      ctx.moveTo(0.5 * (p0.x + p1.x), 0.5 * (p0.y + p1.y));
      for (let i = 1; i <= 6; i++) {
        const cur = ps[i % 6];
        const next = ps[(i + 1) % 6];
        if (i === 4 || i === 5) ctx.lineTo(cur.x, cur.y);
        else
          ctx.quadraticCurveTo(
            cur.x,
            cur.y,
            0.5 * (cur.x + next.x),
            0.5 * (cur.y + next.y),
          );
      }
      ctx.fillStyle = seatGrad;
      ctx.fill();

      // ── 4. CUSHION DETAILS ─────────────────────────────────
      // Two cushions side by side with a seam gap
      const gap = 8;
      const cushW = (W - armW * 2 - gap * 3) * 0.5;
      const cushH = H - 8;
      const cushY = yTop + 4;
      const cush1X = x0 + armW + gap;
      const cush2X = cush1X + cushW + gap;

      const gCush = ctx.createLinearGradient(0, cushY, 0, cushY + cushH);
      gCush.addColorStop(0, "rgba(255,255,255,0.22)");
      gCush.addColorStop(1, "rgba(0,0,0,0)");

      for (const cx of [cush1X, cush2X]) {
        rr(cx, cushY, cushW, cushH, 5, gCush, null);
        // button dimple
        ctx.beginPath();
        ctx.arc(cx + cushW * 0.5, cushY + cushH * 0.52, 3, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.2)";
        ctx.fill();
      }

      // seam between cushions
      ctx.fillStyle = cSeam;
      ctx.fillRect(cush1X + cushW + gap * 0.5 - 1, cushY + 4, 2, cushH - 8);

      // ── 5. SEAT FRONT FACE (3-D thickness) ────────────────
      ctx.fillStyle = cDark;
      ctx.fillRect(x0 + armW, yBot - 10, W - armW * 2, 10);

      // ── 6. SEAT HIGHLIGHT (top sheen) ─────────────────────
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(x0 + armW + gap, yTop + 3, W - armW * 2 - gap * 2, 5);

      // ── 7. LEGS (small rectangles below seat) ─────────────
      const legW = 12;
      const legH = 14;
      const legY = yBot;
      const legGrad = ctx.createLinearGradient(0, legY, 0, legY + legH);
      legGrad.addColorStop(0, "#1A237E");
      legGrad.addColorStop(1, "#0D1642");

      for (const lx of [x0 + armW + 10, x1 - armW - 10 - legW]) {
        rr(lx, legY, legW, legH, 2, legGrad, null);
      }
    }

    /** Low quality: simple polygon + backrest rect. */
    paintLow(ctx, color = "#00B0FF") {
      const ps = this.positions;
      const x0 = ps[5].x;
      const x1 = ps[4].x;
      const yTop = ps[1].y;
      const yBot = ps[4].y;
      const W = x1 - x0;
      const H = yBot - yTop;

      ctx.beginPath();
      for (const p of ps) ctx.lineTo(p.x, p.y);
      ctx.fillStyle = color;
      ctx.fill();

      if (W > 200) {
        // backrest
        ctx.fillRect(x0 + W * 0.09, yTop - H * 1.8, W * 0.82, H * 1.8);
        // armrests
        ctx.fillRect(x0 - 4, yTop - H * 0.9, 46, H * 1.9);
        ctx.fillRect(x1 - 42, yTop - H * 0.9, 46, H * 1.9);
      }
    }
  }

  // ── Number of polygon vertices from radius ─────────────────
  const polyVertexCount = (r) => Math.min(((0.04 * Math.PI * r) | 0) << 1, 16);

  // ── Tile (the numbered circles) ───────────────────────────
  class Tile extends RigidBody {
    constructor(x, y = -40, value = 2, addToWorld = true) {
      super(1 + 0.2 * Math.log10(value));

      tileCount[value] = (tileCount[value] ?? 0) + 1;
      this.value = value;
      this.r = 40 + 4 * (Math.log2(value) - 1);
      this.font = `bold ${0.1 * this.r + 28}px 'Segoe UI','Helvetica Neue',sans-serif`;

      const count = polyVertexCount(this.r);
      const step = (2 * Math.PI) / count;

      for (let i = 0; i < count; i++) {
        const angle = i * step;
        new Vertex(
          this,
          x + this.r * Math.cos(angle),
          y + this.r * Math.sin(angle),
        );
      }

      // Constraints: all pairs of adjacent + diagonal vertices
      for (let i = 0; i < count - 1; i++) {
        for (let j = i + 1; j < count; j++) {
          new Constraint(
            this,
            this.vertices[i],
            this.vertices[j],
            0.005,
            j === i + 1,
          );
        }
      }

      if (addToWorld) {
        this.updateBounds();
        bodies.push(this);
      }
    }

    /** High-quality smooth circle. */
    paint(ctx) {
      ctx.beginPath();
      let p0 = this.positions[0];
      let p1 = this.positions[1];
      ctx.moveTo(0.5 * (p0.x + p1.x), 0.5 * (p0.y + p1.y));
      for (let i = 1; i <= this.positions.length; i++) {
        p0 = this.positions[i % this.positions.length];
        p1 = this.positions[(i + 1) % this.positions.length];
        ctx.quadraticCurveTo(
          p0.x,
          p0.y,
          0.5 * (p0.x + p1.x),
          0.5 * (p0.y + p1.y),
        );
      }

      ctx.fillStyle = TILE_COLORS.get(this.value) ?? "#edc22e";
      ctx.fill();

      ctx.save();
      ctx.translate(this.center.x, this.center.y);
      ctx.rotate(Math.atan2(p0.y - this.center.y, p0.x - this.center.x));
      ctx.font = this.font;
      ctx.fillStyle = this.value > 4 ? "#f9f6f2" : "#776e65";
      ctx.fillText(String(this.value), 0, 0);
      ctx.restore();

      this.tryDrag();
    }

    /** Low-quality polygon. */
    paintLow(ctx) {
      ctx.beginPath();
      const start = this.boundaries[0].p0;
      ctx.moveTo(start.x, start.y);
      for (const c of this.boundaries) ctx.lineTo(c.p1.x, c.p1.y);

      ctx.fillStyle = TILE_COLORS.get(this.value) ?? "#edc22e";
      ctx.fill();

      ctx.save();
      ctx.translate(this.center.x, this.center.y);
      ctx.rotate(Math.atan2(start.y - this.center.y, start.x - this.center.x));
      ctx.font = this.font;
      ctx.fillStyle = this.value > 4 ? "#f9f6f2" : "#776e65";
      ctx.fillText(String(this.value), 0, 0);
      ctx.restore();

      this.tryDrag();
    }
  }

  // ── SAT Collision detection & resolution ──────────────────
  function checkAndResolve(bodyA, bodyB) {
    // Broad phase AABB
    if (
      Math.abs(bodyB.center.x - bodyA.center.x) -
        (bodyA.halfExtents.x + bodyB.halfExtents.x) >=
        0 ||
      Math.abs(bodyB.center.y - bodyA.center.y) -
        (bodyA.halfExtents.y + bodyB.halfExtents.y) >=
        0
    )
      return;

    // Narrow phase SAT
    let minOverlap = 99999;
    let collisionNormal = new Vec2();
    let collisionEdge = null;

    for (const body of [bodyA, bodyB]) {
      for (const edge of body.boundaries) {
        const axis = tmpA.setNormal(edge.p0, edge.p1);
        bodyA.project(axis);
        bodyB.project(axis);

        const gap =
          bodyA._min < bodyB._min
            ? bodyB._min - bodyA._max
            : bodyA._min - bodyB._max;
        if (gap > 0) return;

        const overlap = -gap;
        if (overlap < minOverlap) {
          minOverlap = overlap;
          collisionNormal.copyFrom(axis);
          collisionEdge = edge;
        }
      }
    }

    if (!collisionEdge) return;

    // Ensure reference body = bodyB
    if (collisionEdge.body !== bodyB) {
      [bodyA, bodyB] = [bodyB, bodyA];
    }

    // Find deepest penetrating vertex of bodyA
    tmpA.setDiff(bodyA.center, bodyB.center);
    if (tmpA.dot(collisionNormal) < 0) collisionNormal.scale(-1);

    let deepestDist = 99999;
    let deepestVertex = null;
    for (const v of bodyA.vertices) {
      tmpA.setDiff(v.position, bodyB.center);
      const d = collisionNormal.dot(tmpA);
      if (d < deepestDist) {
        deepestDist = d;
        deepestVertex = v;
      }
    }
    if (!deepestVertex) return;

    // Resolve penetration
    const { p0: ep0, p1: ep1, v0: ev0, v1: ev1 } = collisionEdge;
    const cp = deepestVertex.position;
    const cop = deepestVertex.oldPosition;
    const eop0 = ev0.oldPosition;
    const eop1 = ev1.oldPosition;

    const lambda =
      Math.abs(ep0.x - ep1.x) > Math.abs(ep0.y - ep1.y)
        ? (cp.x - collisionNormal.x * minOverlap - ep0.x) / (ep1.x - ep0.x)
        : (cp.y - collisionNormal.y * minOverlap - ep0.y) / (ep1.y - ep0.y);

    const invMassScale = 1 / (lambda ** 2 + (1 - lambda) ** 2);
    const mA = bodyA.mass;
    const mB = bodyB.mass;
    const mTotal = mA + mB;
    const impulseA = mA / (2 * mTotal);
    const impulseB = mB / mTotal;
    const edgeW0 = (1 - lambda) * invMassScale * impulseA;
    const edgeW1 = lambda * invMassScale * impulseA;

    const nx = collisionNormal.x * minOverlap;
    const ny = collisionNormal.y * minOverlap;

    ep0.x -= nx * edgeW0;
    ep0.y -= ny * edgeW0;
    ep1.x -= nx * edgeW1;
    ep1.y -= ny * edgeW1;
    cp.x += nx * impulseB;
    cp.y += ny * impulseB;

    // Friction
    tmpA.set(
      cp.x - cop.x - 0.5 * (ep0.x + ep1.x - eop0.x - eop1.x),
      cp.y - cop.y - 0.5 * (ep0.y + ep1.y - eop0.y - eop1.y),
    );
    tmpB.set(-collisionNormal.y, collisionNormal.x);
    tmpA.setScaled(tmpB, tmpA.dot(tmpB));

    const K = 0.9; // friction coefficient
    eop0.x -= tmpA.x * K * edgeW0;
    eop0.y -= tmpA.y * K * edgeW0;
    eop1.x -= tmpA.x * K * edgeW1;
    eop1.y -= tmpA.y * K * edgeW1;
    cop.x += tmpA.x * K * impulseB;
    cop.y += tmpA.y * K * impulseB;
  }

  // ── Sound ─────────────────────────────────────────────────
  class SoundPool {
    constructor() {
      this.on = true;
      this.sounds = {};
    }

    /** Pre-generate `count` Audio clones from a SOUND() parameter array. */
    add(name, count, params) {
      const src = window.SOUND(params);
      this.sounds[name] = {
        tick: 0,
        count,
        pool: Array.from({ length: count }, () => {
          const a = new Audio();
          a.src = src;
          return a;
        }),
      };
    }

    play(name) {
      if (!this.on || !audioUnlocked) return;

      const s = this.sounds[name];
      if (!s) return;

      // Resume AudioContext if the browser suspended it (e.g. after tab switch)
      const ctx = getAudioCtx();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      const audio = s.pool[s.tick];
      audio.currentTime = 0;
      audio.play().catch(() => {});

      if (++s.tick >= s.count) s.tick = 0;
    }
  }

  const sfx = new SoundPool();

  if (!isMobile) {
    sfx.add("bip", 9, [
      1,
      ,
      0.1241,
      ,
      0.1855,
      0.5336,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      1,
      ,
      ,
      0.1,
      ,
      0.64,
    ]);
    sfx.add("die", 4, [
      1,
      0.0013,
      0.3576,
      0.0681,
      0.8007,
      0.5117,
      ,
      -0.3453,
      0.0049,
      0.148,
      -0.2563,
      -0.2717,
      0.2608,
      ,
      -0.3543,
      -0.1884,
      -0.0106,
      -0.0281,
      0.9971,
      -0.6629,
      -0.7531,
      0.0097,
      -0.0086,
      0.5,
    ]);
    sfx.add("new", 2, [
      1,
      ,
      0.2548,
      ,
      0.1007,
      0.7539,
      0.0996,
      -0.5302,
      ,
      ,
      ,
      ,
      ,
      0.7769,
      -0.4436,
      ,
      ,
      ,
      0.1,
      ,
      ,
      ,
      ,
      0.5,
    ]);
    sfx.add("win", 1, [
      1,
      0.0309,
      0.5597,
      0.0464,
      0.7472,
      0.369,
      ,
      -0.1366,
      ,
      -0.3111,
      ,
      -0.1581,
      -0.8665,
      ,
      -0.0414,
      0.2802,
      0.0258,
      -0.1198,
      0.9955,
      0.1759,
      ,
      ,
      -5e-4,
      0.64,
    ]);
    // "drop" — soft plop sound for timed auto-drops
    sfx.add("drop", 3, [
      3, // noise wave
      0.02,
      0.18,
      0.05,
      0.22,
      0.28,
      ,
      0.12,
      ,
      ,
      ,
      ,
      ,
      0.5,
      ,
      ,
      ,
      ,
      0.6,
      0.3,
      ,
      ,
      ,
      0.4,
    ]);
  }

  // ── Music (SoundBox tracker) ──────────────────────────────
  const SONG_DATA = {
    songLen: 37,
    rowLen: 5513,
    endPattern: 9,
    songData: [
      {
        osc1_oct: 7,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 0,
        osc1_vol: 192,
        osc1_waveform: 3,
        osc2_oct: 7,
        osc2_det: 0,
        osc2_detune: 7,
        osc2_xenv: 0,
        osc2_vol: 201,
        osc2_waveform: 3,
        noise_fader: 0,
        env_attack: 789,
        env_sustain: 1234,
        env_release: 13636,
        env_master: 191,
        fx_filter: 2,
        fx_freq: 5839,
        fx_resonance: 254,
        fx_delay_time: 6,
        fx_delay_amt: 121,
        fx_pan_freq: 6,
        fx_pan_amt: 147,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 1,
        lfo_freq: 6,
        lfo_amt: 195,
        lfo_waveform: 0,
        p: [
          1, 2, 0, 0, 1, 2, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              154, 0, 154, 0, 152, 0, 147, 0, 0, 0, 0, 0, 0, 0, 0, 0, 154, 0,
              154, 0, 152, 0, 157, 0, 0, 0, 156, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              154, 0, 154, 0, 152, 0, 147, 0, 0, 0, 0, 0, 0, 0, 0, 0, 154, 0,
              154, 0, 152, 0, 157, 0, 0, 0, 159, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
      {
        osc1_oct: 7,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 0,
        osc1_vol: 192,
        osc1_waveform: 1,
        osc2_oct: 6,
        osc2_det: 0,
        osc2_detune: 9,
        osc2_xenv: 0,
        osc2_vol: 192,
        osc2_waveform: 1,
        noise_fader: 0,
        env_attack: 137,
        env_sustain: 2000,
        env_release: 4611,
        env_master: 192,
        fx_filter: 1,
        fx_freq: 982,
        fx_resonance: 89,
        fx_delay_time: 6,
        fx_delay_amt: 25,
        fx_pan_freq: 6,
        fx_pan_amt: 77,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 1,
        lfo_freq: 3,
        lfo_amt: 69,
        lfo_waveform: 0,
        p: [
          1, 2, 1, 3, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              130, 0, 130, 0, 142, 0, 130, 130, 0, 142, 130, 0, 142, 0, 130, 0,
              130, 0, 130, 0, 142, 0, 130, 130, 0, 142, 130, 0, 142, 0, 130, 0,
            ],
          },
          {
            n: [
              123, 0, 123, 0, 135, 0, 123, 123, 0, 135, 123, 0, 135, 0, 123, 0,
              123, 0, 123, 0, 135, 0, 123, 123, 0, 135, 123, 0, 135, 0, 123, 0,
            ],
          },
          {
            n: [
              135, 0, 135, 0, 147, 0, 135, 135, 0, 147, 135, 0, 147, 0, 135, 0,
              135, 0, 135, 0, 147, 0, 135, 135, 0, 147, 135, 0, 147, 0, 135, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
      {
        osc1_oct: 7,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 0,
        osc1_vol: 255,
        osc1_waveform: 3,
        osc2_oct: 8,
        osc2_det: 0,
        osc2_detune: 0,
        osc2_xenv: 0,
        osc2_vol: 255,
        osc2_waveform: 0,
        noise_fader: 127,
        env_attack: 22,
        env_sustain: 88,
        env_release: 3997,
        env_master: 255,
        fx_filter: 3,
        fx_freq: 4067,
        fx_resonance: 234,
        fx_delay_time: 4,
        fx_delay_amt: 33,
        fx_pan_freq: 2,
        fx_pan_amt: 84,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 1,
        lfo_freq: 3,
        lfo_amt: 28,
        lfo_waveform: 0,
        p: [
          0, 0, 1, 2, 1, 2, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              0, 0, 142, 0, 154, 0, 0, 0, 142, 0, 0, 0, 154, 0, 0, 0, 0, 0, 142,
              0, 154, 0, 0, 0, 142, 0, 0, 0, 154, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 147, 0, 154, 0, 0, 0, 147, 0, 0, 0, 154, 0, 0, 0, 0, 0, 147,
              0, 154, 0, 147, 0, 0, 0, 154, 0, 0, 0, 154, 0,
            ],
          },
          {
            n: [
              0, 0, 147, 0, 154, 0, 0, 0, 147, 0, 0, 0, 154, 0, 0, 0, 0, 0, 147,
              0, 154, 0, 0, 0, 147, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
      {
        osc1_oct: 8,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 0,
        osc1_vol: 0,
        osc1_waveform: 0,
        osc2_oct: 8,
        osc2_det: 0,
        osc2_detune: 0,
        osc2_xenv: 0,
        osc2_vol: 0,
        osc2_waveform: 0,
        noise_fader: 255,
        env_attack: 140347,
        env_sustain: 9216,
        env_release: 133417,
        env_master: 208,
        fx_filter: 2,
        fx_freq: 2500,
        fx_resonance: 16,
        fx_delay_time: 2,
        fx_delay_amt: 157,
        fx_pan_freq: 8,
        fx_pan_amt: 207,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 1,
        lfo_freq: 2,
        lfo_amt: 51,
        lfo_waveform: 0,
        p: [
          0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              147, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
      {
        osc1_oct: 7,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 0,
        osc1_vol: 255,
        osc1_waveform: 2,
        osc2_oct: 8,
        osc2_det: 0,
        osc2_detune: 18,
        osc2_xenv: 1,
        osc2_vol: 191,
        osc2_waveform: 2,
        noise_fader: 0,
        env_attack: 3997,
        env_sustain: 56363,
        env_release: 100000,
        env_master: 255,
        fx_filter: 2,
        fx_freq: 392,
        fx_resonance: 255,
        fx_delay_time: 8,
        fx_delay_amt: 69,
        fx_pan_freq: 5,
        fx_pan_amt: 67,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 1,
        lfo_freq: 4,
        lfo_amt: 57,
        lfo_waveform: 3,
        p: [
          1, 2, 1, 2, 1, 2, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              130, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              123, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
      {
        osc1_oct: 8,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 0,
        osc1_vol: 0,
        osc1_waveform: 0,
        osc2_oct: 8,
        osc2_det: 0,
        osc2_detune: 0,
        osc2_xenv: 0,
        osc2_vol: 0,
        osc2_waveform: 0,
        noise_fader: 60,
        env_attack: 50,
        env_sustain: 419,
        env_release: 4607,
        env_master: 130,
        fx_filter: 1,
        fx_freq: 10332,
        fx_resonance: 120,
        fx_delay_time: 4,
        fx_delay_amt: 16,
        fx_pan_freq: 5,
        fx_pan_amt: 108,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 0,
        lfo_freq: 5,
        lfo_amt: 187,
        lfo_waveform: 0,
        p: [
          0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              0, 0, 147, 0, 0, 0, 147, 147, 0, 0, 147, 0, 0, 147, 0, 147, 0, 0,
              147, 0, 0, 0, 147, 147, 0, 0, 147, 0, 0, 147, 0, 147,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
      {
        osc1_oct: 7,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 1,
        osc1_vol: 255,
        osc1_waveform: 0,
        osc2_oct: 7,
        osc2_det: 0,
        osc2_detune: 0,
        osc2_xenv: 1,
        osc2_vol: 255,
        osc2_waveform: 0,
        noise_fader: 0,
        env_attack: 50,
        env_sustain: 150,
        env_release: 4800,
        env_master: 200,
        fx_filter: 2,
        fx_freq: 600,
        fx_resonance: 254,
        fx_delay_time: 0,
        fx_delay_amt: 0,
        fx_pan_freq: 0,
        fx_pan_amt: 0,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 0,
        lfo_freq: 0,
        lfo_amt: 0,
        lfo_waveform: 0,
        p: [
          1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              147, 0, 0, 0, 0, 0, 0, 0, 147, 0, 0, 0, 0, 0, 0, 0, 147, 0, 0, 0,
              0, 0, 0, 0, 147, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
      {
        osc1_oct: 7,
        osc1_det: 0,
        osc1_detune: 0,
        osc1_xenv: 0,
        osc1_vol: 255,
        osc1_waveform: 2,
        osc2_oct: 7,
        osc2_det: 0,
        osc2_detune: 9,
        osc2_xenv: 0,
        osc2_vol: 154,
        osc2_waveform: 2,
        noise_fader: 0,
        env_attack: 2418,
        env_sustain: 1075,
        env_release: 10614,
        env_master: 240,
        fx_filter: 3,
        fx_freq: 2962,
        fx_resonance: 255,
        fx_delay_time: 6,
        fx_delay_amt: 117,
        fx_pan_freq: 3,
        fx_pan_amt: 73,
        lfo_osc1_freq: 0,
        lfo_fx_freq: 1,
        lfo_freq: 5,
        lfo_amt: 124,
        lfo_waveform: 0,
        p: [
          0, 0, 0, 0, 1, 2, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0,
        ],
        c: [
          {
            n: [
              154, 0, 154, 0, 152, 0, 147, 0, 0, 0, 0, 0, 0, 0, 0, 0, 154, 0,
              154, 0, 152, 0, 157, 0, 0, 0, 156, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              154, 0, 154, 0, 152, 0, 147, 0, 0, 0, 0, 0, 0, 0, 0, 0, 154, 0,
              147, 0, 152, 0, 157, 0, 0, 0, 159, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
          {
            n: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          },
        ],
      },
    ],
  };

  // SoundBox tracker player
  class Tracker {
    constructor() {
      const sin = (t) => Math.sin(6.283184 * t);
      const sqr = (t) => (sin(t) < 0 ? -1 : 1);
      const saw = (t) => (t % 1) - 0.5;
      const tri = (t) => {
        const v = (t % 1) * 4;
        return v < 2 ? v - 1 : 3 - v;
      };
      const note = (n) => 0.00390625 * Math.pow(1.059463094, n - 128);

      this._waves = [sin, sqr, saw, tri];
      this._note = note;

      const sampleRate = 44100;
      const channels = 2;
      const totalSamples = sampleRate * SONG_DATA.songLen;

      const size = Math.ceil(Math.sqrt((totalSamples * channels) / 2));
      const offscreen = document.createElement("canvas").getContext("2d");
      this._mix = offscreen.createImageData(size, size).data;
      const zeros = offscreen.createImageData(size, size).data;
      for (let i = zeros.length - 2; i >= 0; i -= 2) {
        zeros[i] = 0;
        zeros[i + 1] = 128;
      }
      this._sum = zeros;
      this.lps = sampleRate / SONG_DATA.rowLen;
    }

    generate(track) {
      const { _waves: wf, _note: note, _mix: mix, _sum: sum } = this;
      const song = SONG_DATA.songData[track];
      const rowLen = SONG_DATA.rowLen;
      const sampleRate = 44100;
      const totalSamples = sampleRate * SONG_DATA.songLen;
      const totalBytes = totalSamples * 2 * 2;

      for (let i = 0; i < totalBytes; i += 2) {
        mix[i] = 0;
        mix[i + 1] = 128;
      }

      const lfoWave = wf[song.lfo_waveform];
      const osc1Wave = wf[song.osc1_waveform];
      const osc2Wave = wf[song.osc2_waveform];
      const lfoFreq = Math.pow(2, song.lfo_freq - 8) / rowLen;
      const panFreq = Math.pow(2, song.fx_pan_freq - 8) / rowLen;
      const attack = song.env_attack;
      const sustain = song.env_sustain;
      const release = song.env_release;

      let rowOffset = 0;

      for (let pattern = 0; pattern < SONG_DATA.endPattern - 1; pattern++) {
        const patternIdx = song.p[pattern];
        for (let noteIdx = 0; noteIdx < 32; noteIdx++) {
          if (patternIdx && song.c[patternIdx - 1].n[noteIdx]) {
            const n = song.c[patternIdx - 1].n[noteIdx];
            const f1 =
              note(n + 12 * (song.osc1_oct - 8) + song.osc1_det) *
              (1 + 8e-4 * song.osc1_detune);
            const f2 =
              note(n + 12 * (song.osc2_oct - 8) + song.osc2_det) *
              (1 + 8e-4 * song.osc2_detune);
            const fRes = song.fx_resonance / 255;
            let osc1Phase = 0,
              osc2Phase = 0,
              lpLow = 0,
              lpBand = 0;

            for (let i = attack + sustain + release - 1; i >= 0; i--) {
              const t = i + rowOffset;
              const lfo = (lfoWave(t * lfoFreq) * song.lfo_amt) / 512 + 0.5;
              let env = 1;
              if (i < attack) env = i / attack;
              else if (i >= attack + sustain)
                env = 1 - (i - attack - sustain) / release;

              let freq1 = f1;
              if (song.lfo_osc1_freq) freq1 += lfo;
              if (song.osc1_xenv) freq1 *= env * env;
              osc1Phase += freq1;
              let s = osc1Wave(osc1Phase) * song.osc1_vol;

              let freq2 = f2;
              if (song.osc2_xenv) freq2 *= env * env;
              osc2Phase += freq2;
              s += osc2Wave(osc2Phase) * song.osc2_vol;

              if (song.noise_fader)
                s += (2 * Math.random() - 1) * song.noise_fader * env;
              s *= env / 255;

              let fFreq = song.fx_freq;
              if (song.lfo_fx_freq) fFreq *= lfo;
              fFreq = 1.5 * Math.sin((Math.PI * fFreq) / 44100);
              lpBand += fFreq * lpLow;
              const hi = fRes * (s - lpLow) - lpBand;
              lpLow += fFreq * hi;
              switch (song.fx_filter) {
                case 1:
                  s = hi;
                  break;
                case 2:
                  s = lpBand;
                  break;
                case 3:
                  s = lpLow;
                  break;
                case 4:
                  s = lpBand + hi;
                  break;
              }

              const pan =
                (Math.sin(6.28318 * t * panFreq) * song.fx_pan_amt) / 512 + 0.5;
              s *= 39 * song.env_master;
              const idx = t << 2;
              let L = mix[idx] + (mix[idx + 1] << 8) + s * (1 - pan);
              mix[idx] = L & 255;
              mix[idx + 1] = (L >> 8) & 255;
              let R = mix[idx + 2] + (mix[idx + 3] << 8) + s * pan;
              mix[idx + 2] = R & 255;
              mix[idx + 3] = (R >> 8) & 255;
            }
          }
          rowOffset += rowLen;
        }
      }

      // Delay effect
      const delay = (song.fx_delay_time * rowLen) >> 1;
      const delayAmt = song.fx_delay_amt / 255;
      for (let v = 0; v < totalSamples - delay; v++) {
        const u = 4 * v,
          h = 4 * (v + delay);
        let L =
          mix[h] +
          (mix[h + 1] << 8) +
          (mix[u + 2] + (mix[u + 3] << 8) - 32768) * delayAmt;
        mix[h] = L & 255;
        mix[h + 1] = (L >> 8) & 255;
        let R =
          mix[h + 2] +
          (mix[h + 3] << 8) +
          (mix[u] + (mix[u + 1] << 8) - 32768) * delayAmt;
        mix[h + 2] = R & 255;
        mix[h + 3] = (R >> 8) & 255;
      }

      // Mix down
      for (let i = 0; i < totalBytes; i += 2) {
        let v = sum[i] + (sum[i + 1] << 8) + mix[i] + (mix[i + 1] << 8) - 32768;
        sum[i] = v & 255;
        sum[i + 1] = (v >> 8) & 255;
      }
    }

    createAudio() {
      const data = this._sum;
      const totalBytes = data.length;
      const pcmBytes = totalBytes - 8;
      const dataChunk = pcmBytes - 36;

      let wav = String.fromCharCode(
        82,
        73,
        70,
        70,
        255 & pcmBytes,
        (pcmBytes >> 8) & 255,
        (pcmBytes >> 16) & 255,
        (pcmBytes >> 24) & 255,
        87,
        65,
        86,
        69,
        102,
        109,
        116,
        32,
        16,
        0,
        0,
        0,
        1,
        0,
        2,
        0,
        68,
        172,
        0,
        0,
        16,
        177,
        2,
        0,
        4,
        0,
        16,
        0,
        100,
        97,
        116,
        97,
        255 & dataChunk,
        (dataChunk >> 8) & 255,
        (dataChunk >> 16) & 255,
        (dataChunk >> 24) & 255,
      );

      for (let i = 0; i < totalBytes; ) {
        let chunk = "";
        for (let j = 0; j < 256 && i < totalBytes; j++, i += 2) {
          let s = 4 * (data[i] + (data[i + 1] << 8) - 32768);
          s = Math.max(-32768, Math.min(32767, s));
          chunk += String.fromCharCode(s & 255, (s >> 8) & 255);
        }
        wav += chunk;
      }

      const src = `data:audio/wav;base64,${btoa(wav)}`;
      this._sum = null;
      return new Audio(src);
    }
  }

  // ── Debounce helper ───────────────────────────────────────
  const debounce = (fn, delay) => {
    let timer = null;
    let last = 0;
    return () => {
      const run = () => {
        const elapsed = Date.now() - last;
        if (elapsed < delay) {
          timer = setTimeout(run, delay - elapsed);
        } else {
          timer = null;
          fn();
        }
      };
      last = Date.now();
      if (!timer) timer = setTimeout(run, delay);
    };
  };

  // ── Layout / resize ───────────────────────────────────────
  let pixelScale = 1; // world units per CSS pixel

  const resize = () => {
    let w = window.innerWidth;
    let h = window.innerHeight;
    if (w / h > ASPECT) w = h * ASPECT;
    else h = w / ASPECT;

    pixelScale = CANVAS_W / w;

    container.style.width = `${w}px`;
    container.style.height = `${h}px`;
    container.style.left = `${0.5 * (window.innerWidth - w)}px`;
    container.style.top = `${0.5 * (window.innerHeight - h)}px`;

    const s = (0.5 * w) / CANVAS_W;
    const transform = `scale3d(${s},${s},1)`;
    homeScreen.style[TRANSFORM_PROP] = transform;
    endScreen.style[TRANSFORM_PROP] = transform;
  };

  // ── Background / static platforms ─────────────────────────
  let platformMain, platformLeft, platformRight;

  const paintBackground = () => {
    backCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    backCtx.save();
    backCtx.shadowColor = "rgba(0,0,0,0.4)";
    backCtx.shadowBlur = 25;
    platformMain.paint(backCtx, "#0091EA");
    backCtx.shadowColor = "#000";
    backCtx.translate(0, 1);
    platformLeft.paint(backCtx, "rgba(55,71,79,0.4)");
    platformRight.paint(backCtx, "rgba(55,71,79,0.4)");
    platformMain.paint(backCtx, "rgba(55,71,79,0.4)");
    backCtx.restore();
  };

  // ── Spawn helper ───────────────────────────────────────────
  const randomX = () => (0.3 * Math.random() + 0.35) * CANVAS_W;

  /** Debounced new-tile spawner — decides what to drop based on game state. */
  const spawnTile = debounce(() => {
    const has256 = tileCount[256] || tileCount[512] || tileCount[1024];
    const has2 = tileCount[2];
    const has4 = tileCount[4];
    const has8 = tileCount[8];

    if (has2) {
      new Tile(randomX());
    } else if (has4) {
      new Tile(randomX(), -44, 4);
    } else if (has256) {
      if (has8) {
        new Tile(randomX(), -48, 8);
      } else {
        new Tile(0.35 * CANVAS_W, -44, 4);
        new Tile(0.65 * CANVAS_W, -44, 4);
      }
    } else {
      new Tile(0.35 * CANVAS_W);
      new Tile(0.65 * CANVAS_W);
    }

    sfx.play("new");
  }, 300);

  /** Automatic timed drop — runs every AUTO_SPAWN_MS regardless of merges. */
  const autoSpawnTile = () => {
    const has256 = tileCount[256] || tileCount[512] || tileCount[1024];
    const has8 = tileCount[8];

    if (has256 && has8) {
      new Tile(randomX(), -48, 8);
    } else if (tileCount[4]) {
      new Tile(randomX(), -44, 4);
    } else {
      new Tile(randomX());
    }

    sfx.play("drop");
  };

  /** Start the auto-drop interval (called when game begins / resets). */
  const startAutoSpawn = () => {
    if (autoSpawnTimer) clearInterval(autoSpawnTimer);
    autoSpawnTimer = setInterval(autoSpawnTile, AUTO_SPAWN_MS);
  };

  /** Stop the auto-drop interval. */
  const stopAutoSpawn = () => {
    if (autoSpawnTimer) {
      clearInterval(autoSpawnTimer);
      autoSpawnTimer = null;
    }
  };

  // ── Win screen ────────────────────────────────────────────
  const showWin = () => {
    endScreen.style.display = "block";
    sfx.play("win");
    stopAutoSpawn();
  };

  // ── Reset game ────────────────────────────────────────────
  const resetGame = () => {
    endScreen.style.display = "none";
    stopAutoSpawn();
    // Resume music on "Play Again" gesture if it had been paused
    const musicToggle = document.getElementById("m");
    if (musicAudio && musicToggle?.checked) {
      musicAudio.play().catch(() => {});
    }
    sfx.play("new");

    bodies = [];
    vertices = [];
    constraints = [];
    tileCount = {};
    dragVertex = null;
    pointer.dragging = false;

    initWorld();
  };

  // ── Initialise world ──────────────────────────────────────
  const initWorld = () => {
    for (let v = 2; v <= 2048; v *= 2) tileCount[v] = 0;

    platformMain = new Platform(280, 480, 400, 60);
    platformLeft = new Platform(220, 420, 60, 120);
    platformRight = new Platform(680, 420, 60, 120);

    // Connect platforms to main with constraints
    new Constraint(
      platformMain,
      platformMain.handle0,
      platformLeft.handle0,
      0.1,
    );
    new Constraint(
      platformMain,
      platformMain.handle1,
      platformRight.handle1,
      0.1,
    );

    const midY = 0.5 * CANVAS_H;
    new Tile(0.35 * CANVAS_W, midY);
    new Tile(0.65 * CANVAS_W, midY);

    startAutoSpawn();
  };

  // ── Main loop ─────────────────────────────────────────────
  const loop = () => {
    frontCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Integrate vertices
    for (const v of vertices) v.integrate();

    // Merge tiles with matching values
    let merged = false;
    for (let i = 3; i < bodies.length - 1; i++) {
      const a = bodies[i];
      if (!(a instanceof Tile)) continue;

      const mergeRange = 2.5 * a.r;
      let bestDist = 99999;
      let bestTile = null;
      let bestIdx = -1;

      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (!(b instanceof Tile) || a.value !== b.value) continue;
        const dist = a.center.distance(b.center);
        if (dist < mergeRange && dist < bestDist) {
          bestDist = dist;
          bestTile = b;
          bestIdx = j;
        }
      }

      if (!bestTile) continue;

      const mx = 0.5 * (a.center.x + bestTile.center.x);
      const my = 0.5 * (a.center.y + bestTile.center.y);

      if (bestDist > 2 * a.r) {
        // Attract towards midpoint
        for (const p of a.positions) {
          p.x += (mx - p.x) * ATTRACT;
          p.y += (my - p.y) * ATTRACT;
        }
        for (const p of bestTile.positions) {
          p.x += (mx - p.x) * ATTRACT;
          p.y += (my - p.y) * ATTRACT;
        }
      } else {
        // Merge!
        constraints = constraints.filter(
          (c) => c.body !== a && c.body !== bestTile,
        );
        vertices = vertices.filter((v) => v.body !== a && v.body !== bestTile);
        if (dragVertex?.body === a || dragVertex?.body === bestTile) {
          dragVertex = null;
          pointer.dragging = false;
        }
        bodies.splice(bestIdx, 1);

        tileCount[a.value] -= 2;
        const newTile = new Tile(mx, my, a.value << 1, false);
        newTile.updateBounds();
        bodies[i] = newTile;

        sfx.play("bip");
        merged = true;

        if (a.value === 1024) showWin();
      }
    }

    if (merged) spawnTile();

    // Move dragged vertex towards pointer
    if (dragVertex) {
      dragVertex.position.x += (pointer.x - dragVertex.position.x) * DRAG_EASE;
      dragVertex.position.y += (pointer.y - dragVertex.position.y) * DRAG_EASE;
    }

    // Solve constraints + AABB + collisions
    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (const c of constraints) c.solve();
      for (const b of bodies) b.updateBounds();
      for (let i = 0; i < bodies.length - 1; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          checkAndResolve(bodies[i], bodies[j]);
        }
      }
    }

    // Paint all bodies
    for (const b of bodies) b.paint(frontCtx);

    // Debug drag line
    if (dragVertex) {
      frontCtx.beginPath();
      frontCtx.moveTo(dragVertex.position.x, dragVertex.position.y);
      frontCtx.lineTo(pointer.x, pointer.y);
      frontCtx.strokeStyle = "#FFD600";
      frontCtx.stroke();
    }

    // Remove tiles that fell off the bottom
    for (let i = bodies.length - 1; i >= 3; i--) {
      const b = bodies[i];
      if (!(b instanceof Tile)) continue;
      if (b.center.y >= CANVAS_H + b.r) {
        constraints = constraints.filter((c) => c.body !== b);
        vertices = vertices.filter((v) => v.body !== b);
        if (dragVertex?.body === b) {
          dragVertex = null;
          pointer.dragging = false;
        }
        bodies.splice(i, 1);
        tileCount[b.value]--;
        sfx.play("die");
      }
    }

    requestAnimationFrame(loop);
  };

  // ── Pointer update helper ─────────────────────────────────
  const updatePointer = ({ clientX, clientY }) => {
    pointer.x = (clientX - container.offsetLeft) * pixelScale;
    pointer.y = (clientY - container.offsetTop) * pixelScale;
  };

  // ── Block default touch behaviour on game canvas ──────────
  const blockDefault = (e) => {
    if (e.target.tagName !== "INPUT" && e.target.tagName !== "LABEL") {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ── Start game (dismiss home screen) ─────────────────────
  // Must be triggered by a direct user gesture so the browser
  // autoplay policy permits audio.
  let musicAudio = null;

  const startGame = () => {
    if (homeScreen.parentNode) container.removeChild(homeScreen);

    const musicToggle = document.getElementById("m");

    // 🔥 crea audio SOLO dopo click
    if (!musicAudio && !isMobile) {
      try {
        const tracker = new Tracker();
        for (let t = 0; t < 8; t++) tracker.generate(t);

        musicAudio = tracker.createAudio();
        musicAudio.loop = true;
        musicAudio.volume = 0.9;

        console.log("🎵 audio creato");
      } catch (e) {
        console.warn("Errore creazione audio", e);
      }
    }

    // ▶️ play sicuro
    if (musicAudio && musicToggle?.checked) {
      musicAudio.currentTime = 0;

      // Ensure AudioContext is running before play() (Chrome autoplay policy)
      const ctx = getAudioCtx();
      const doPlay = () =>
        musicAudio
          .play()
          .then(() => console.log("🎵 musica partita"))
          .catch((err) => console.warn("❌ play bloccato", err));

      if (ctx && ctx.state === "suspended") {
        ctx.resume().then(doPlay).catch(doPlay);
      } else {
        doPlay();
      }
    }

    sfx.play("new");

    if (isMobile || pixelScale > 1) {
      document.body.requestFullscreen?.();
    }
  };
  // ── Settings UI ───────────────────────────────────────────
  const initUI = () => {
    if (isMobile) document.body.className = "mobile";

    const musicToggle = document.getElementById("m");
    const sfxToggle = document.getElementById("s");
    const qualityToggle = document.getElementById("q");

    // Polyfills no longer needed for modern targets, kept for safety
    Element.prototype.requestFullscreen ??=
      Element.prototype.mozRequestFullScreen ||
      Element.prototype.msRequestFullscreen ||
      Element.prototype.webkitRequestFullscreen;

    const paintHQ = Platform.prototype.paint;
    const paintLQ = Platform.prototype.paintLow;
    const tilePaintHQ = Tile.prototype.paint;
    const tilePaintLQ = Tile.prototype.paintLow;

    if (isMobile) {
      qualityToggle.checked = false;
      Platform.prototype.paint = paintLQ;
      Tile.prototype.paint = tilePaintLQ;
    }

    musicToggle.addEventListener("change", () => {
      if (!musicAudio) return;
      if (musicToggle.checked) {
        musicAudio.currentTime = 0;
        musicAudio.play().catch(() => {});
      } else {
        musicAudio.pause();
      }
    });

    sfxToggle.addEventListener("change", () => {
      sfx.on = sfxToggle.checked;
    });

    qualityToggle.addEventListener("change", () => {
      Platform.prototype.paint = qualityToggle.checked ? paintHQ : paintLQ;
      Tile.prototype.paint = qualityToggle.checked ? tilePaintHQ : tilePaintLQ;
      paintBackground();
    });

    // Rimuovi la schermata di caricamento: mostra #home
    if (loadScreen.parentNode) container.removeChild(loadScreen);
  };

  // ── Event listeners ───────────────────────────────────────
  addEventListener("mousedown", (e) => {
    e.preventDefault();
    pointer.dragging = true;
    updatePointer(e);
  });
  addEventListener("mousemove", (e) => {
    e.preventDefault();
    updatePointer(e);
  });
  addEventListener("mouseup", (e) => {
    e.preventDefault();
    pointer.dragging = false;
    dragVertex = null;
  });

  document.addEventListener("touchstart", (e) => {
    blockDefault(e);
    pointer.dragging = true;
    updatePointer(e.targetTouches[0]);
  });
  document.addEventListener("touchmove", (e) => {
    e.preventDefault();
    updatePointer(e.targetTouches[0]);
  });
  document.addEventListener("touchend", () => {
    pointer.dragging = false;
    dragVertex = null;
  });
  document.addEventListener("touchcancel", () => {
    pointer.dragging = false;
    dragVertex = null;
  });

  frontCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

  homeScreen.addEventListener("mousedown", blockDefault);
  homeScreen.addEventListener("touchstart", blockDefault);
  endScreen.addEventListener("mousedown", blockDefault);
  endScreen.addEventListener("touchstart", blockDefault);

  startBtn.addEventListener("mousedown", startGame);
  startBtn.addEventListener("touchstart", startGame);
  resetBtn.addEventListener("mousedown", resetGame);
  resetBtn.addEventListener("touchstart", resetGame);

  window.addEventListener("resize", debounce(resize, 200));
  window.addEventListener("orientationchange", debounce(resize, 200));

  // ── Bootstrap ─────────────────────────────────────────────

  resize();
  initUI();
  initWorld();
  requestAnimationFrame(loop);
  paintBackground();
})();

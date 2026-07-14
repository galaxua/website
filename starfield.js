/*
 * Starfield — seamless looping star rain, rendered entirely in code.
 *
 * The source is a 224-column pixel grid. Stars fall straight down at a fixed
 * speed (7 source-pixels per frame at 60fps) and twinkle on/off. This plays a
 * short, perfectly seamless loop (300 frames = 5s) whose last frame flows into
 * the first with no visible cut: the field is built as a scrolling world whose
 * height equals exactly one loop of travel, so position and twinkle both repeat
 * with the same period. Data is a compact set of per-frame arrays — no video.
 *
 * Coordinate model
 * ----------------
 *   cols        : logical grid width (224 cells)
 *   rowsQ       : logical grid height in quarter-cells
 *   x[]         : star x centre, in half-cells   (divide by xScale -> cells)
 *   y[]         : star y centre, in quarter-cells (divide by yScale -> cells)
 *   t[]         : shape type   0 = full 1x1 square, 1 = 1x½ (half-height)
 *   p[]         : palette index into pal[]
 *   cnt[]       : number of stars in each frame (walks the flat x/y/t/p arrays)
 *
 * The grid is drawn at whatever cell size fills the viewport HEIGHT, then
 * horizontally centred — so the top and bottom always touch the screen edges
 * and the left/right remain pure black (matching the video's framing on mobile).
 */

(function (global) {
  'use strict';

  function Starfield(canvas, data, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.data = data;
    this.opts = opts || {};

    // Precompute a flat index: frameStart[f] = offset into x/y/t/p for frame f.
    var cnt = data.cnt, n = cnt.length;
    var starts = new Int32Array(n);
    var acc = 0;
    for (var i = 0; i < n; i++) { starts[i] = acc; acc += cnt[i]; }
    this.frameStart = starts;
    this.nframes = n;

    this.cols = data.cols;               // 224
    this.rowsQ = data.rowsQ;             // grid height in quarter-cells
    this.rows = this.rowsQ / data.yScale;
    this.xScale = data.xScale;           // 2  (half-cell)
    this.yScale = data.yScale;           // 4  (quarter-cell)
    this.pal = data.pal;
    this.fps = data.fps || 60;

    this.frame = 0;
    this.acc = 0;                        // time accumulator (ms)
    this.last = 0;
    this.running = false;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);

    this._computeLayout();
    window.addEventListener('resize', this._resize);
  }

  // Work out cell size + horizontal offset so the grid fills the height and
  // is centred horizontally (black bars left/right).
  Starfield.prototype._computeLayout = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = this.canvas.clientWidth;
    var cssH = this.canvas.clientHeight;

    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    // cell size chosen so the full logical height fits the viewport height
    var cell = cssH / this.rows;
    var gridW = cell * this.cols;

    this.cell = cell * dpr;
    this.offsetX = Math.round((cssW - gridW) / 2 * dpr);
    this.offsetY = 0;
    this.viewW = this.canvas.width;
    this.viewH = this.canvas.height;
  };

  Starfield.prototype._resize = function () {
    this._computeLayout();
    this._draw(); // repaint immediately so resize never shows a blank frame
  };

  Starfield.prototype._draw = function () {
    var ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    var f = this.frame;
    var start = this.frameStart[f];
    var count = this.data.cnt[f];
    var X = this.data.x, Y = this.data.y, T = this.data.t, P = this.data.p;
    var pal = this.pal, cell = this.cell;
    var offX = this.offsetX, offY = this.offsetY;
    var xS = this.xScale, yS = this.yScale;

    for (var k = 0; k < count; k++) {
      var idx = start + k;
      var cx = X[idx] / xS;            // centre, in cells
      var cy = Y[idx] / yS;
      var half = T[idx] === 1;

      var w = cell;                    // 1 cell wide
      var h = half ? cell * 0.5 : cell;

      var px = offX + (cx * cell) - w / 2;
      var py = offY + (cy * cell) - h / 2;

      ctx.fillStyle = pal[P[idx]];
      // round to whole device pixels for crisp, 4-sided squares
      var rx = px | 0, ry = py | 0;
      var rw = Math.max(1, (px + w | 0) - rx);
      var rh = Math.max(1, (py + h | 0) - ry);
      ctx.fillRect(rx, ry, rw, rh);
    }
  };

  Starfield.prototype._tick = function (now) {
    if (!this.running) return;
    if (!this.last) this.last = now;
    var dt = now - this.last;
    this.last = now;

    // advance frames at exactly the source fps (60), independent of display refresh
    this.acc += dt;
    var step = 1000 / this.fps;
    var advanced = false;
    while (this.acc >= step) {
      this.acc -= step;
      this.frame = (this.frame + 1) % this.nframes;
      advanced = true;
    }
    if (advanced) this._draw();
    requestAnimationFrame(this._tick);
  };

  Starfield.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this._draw();
    requestAnimationFrame(this._tick);
  };

  Starfield.prototype.stop = function () {
    this.running = false;
  };

  // Load JSON data then construct. Returns a Promise<Starfield>.
  // Works two ways, tried in order:
  //   1. Embedded data  — if window.STARFIELD_DATA_B64 exists (gzip+base64),
  //      it's decompressed in-browser. This needs NO server and works from
  //      file://, USB, email, anywhere.
  //   2. fetch(url)     — falls back to loading starfield_data.json over http.
  Starfield.load = function (canvas, url, opts) {
    if (global.STARFIELD_DATA_B64) {
      return inflateB64(global.STARFIELD_DATA_B64).then(function (data) {
        return new Starfield(canvas, data, opts);
      });
    }
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('Failed to load starfield data: ' + r.status);
        return r.json();
      })
      .then(function (data) {
        return new Starfield(canvas, data, opts);
      });
  };

  // Decode base64 -> gunzip -> JSON.parse. Uses native DecompressionStream
  // when available (all current browsers); otherwise a tiny inline inflate.
  function inflateB64(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('gzip');
      var stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Response(stream).text().then(function (txt) {
        return JSON.parse(txt);
      });
    }
    // Fallback: pako-style inflate isn't bundled; surface a clear message.
    return Promise.reject(new Error(
      'This browser lacks DecompressionStream. Use a current browser, ' +
      'or serve starfield_data.json over http.'));
  }

  global.Starfield = Starfield;
})(window);

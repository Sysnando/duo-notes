/* Duo Notes — canvas core: model, geometry, sketch paths, SVG rendering, export.
 *
 * Pure functions plus element rendering. Knows nothing about pointers, tools or
 * the DOM outside the SVG it builds; canvas.js owns interaction, canvas-ui.js
 * owns the chrome. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const Core = (App.CanvasCore = {});

  const NS = 'http://www.w3.org/2000/svg';
  Core.NS = NS;

  function svg(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    if (attrs) {
      for (const key in attrs) {
        const value = attrs[key];
        if (value !== null && value !== undefined) node.setAttribute(key, value);
      }
    }
    return node;
  }
  Core.svg = svg;

  // ---------- constants ----------

  Core.SHAPE_KINDS = ['rect', 'ellipse', 'diamond', 'triangle', 'cylinder', 'sticky', 'frame', 'umlClass'];
  Core.BOXY = ['rect', 'sticky', 'frame', 'umlClass', 'icon', 'text', 'cylinder', 'triangle'];

  Core.HEADS = [
    { id: 'none', name: 'None' },
    { id: 'arrow', name: 'Arrow' },
    { id: 'triangle', name: 'Triangle (filled)' },
    { id: 'triangleHollow', name: 'Triangle (hollow) — UML inheritance' },
    { id: 'diamond', name: 'Diamond (filled) — UML composition' },
    { id: 'diamondHollow', name: 'Diamond (hollow) — UML aggregation' },
    { id: 'circle', name: 'Circle' }
  ];

  Core.STROKES = ['#2b2620', '#c05b3c', '#2f6f4f', '#2b5c8a', '#7a4fa3', '#a8891f'];
  Core.FILLS = ['transparent', '#f3ddd4', '#dfeee4', '#dbe7f3', '#ece0f5', '#faf0cd', '#fffdf8'];
  Core.STICKY_FILLS = ['#fbeaa0', '#f9cfc4', '#cfe8d4', '#cfe0f2', '#e6d7f5'];

  Core.DEFAULT_STYLE = {
    stroke: '#2b2620',
    fill: 'transparent',
    strokeWidth: 2,
    dash: false,
    opacity: 1,
    fontSize: 18
  };

  const HOLLOW = '#fffdf8';   // paper colour behind hollow UML heads
  const BIND_GAP = 6;

  Core.SKETCH_FONT = '"Architects Daughter", "Newsreader", cursive';
  Core.CRISP_FONT = '"Newsreader", Georgia, serif';

  // ---------- model ----------

  Core.makeBlock = function (id) {
    return {
      id,
      type: 'canvas',
      sketch: true,
      bg: 'grid',
      elements: [],
      assets: {}   // assetId -> { name, viewBox, body } for imported SVGs
    };
  };

  // Older/partial payloads (or a hand-edited row) shouldn't crash the renderer.
  Core.normalize = function (block) {
    if (!block) return null;
    if (typeof block.sketch !== 'boolean') block.sketch = true;
    if (!block.bg) block.bg = 'grid';
    if (!Array.isArray(block.elements)) block.elements = [];
    if (!block.assets || typeof block.assets !== 'object') block.assets = {};
    block.elements = block.elements.filter((el) => el && el.id && el.kind);
    return block;
  };

  Core.indexById = function (elements) {
    const map = Object.create(null);
    for (const el of elements) map[el.id] = el;
    return map;
  };

  const round = (n) => Math.round(n * 10) / 10;
  Core.round = round;

  // ---------- text measurement ----------

  let measureCtx = null;

  function measureText(str, fontSize, font) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${fontSize}px ${font}`;
    return measureCtx.measureText(str).width;
  }
  Core.measureText = measureText;

  const wrapCache = new Map();

  // Line breaks are measured with canvas metrics. Before the webfont arrives those
  // metrics are the fallback font's, so the cache has to be dropped once it loads.
  Core.clearWrapCache = () => wrapCache.clear();

  // Greedy word wrap; falls back to hard character splits for unbroken runs.
  Core.wrapText = function (text, maxWidth, fontSize, font) {
    const key = `${font}|${fontSize}|${Math.round(maxWidth)}|${text}`;
    const cached = wrapCache.get(key);
    if (cached) return cached;

    const lines = [];
    for (const paragraph of String(text == null ? '' : text).split('\n')) {
      if (!paragraph) { lines.push(''); continue; }
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        const candidate = line ? line + ' ' + word : word;
        if (measureText(candidate, fontSize, font) <= maxWidth || !line) {
          if (measureText(candidate, fontSize, font) > maxWidth && !line && word.length > 1) {
            // A single word wider than the box: break it up.
            let chunk = '';
            for (const ch of word) {
              if (measureText(chunk + ch, fontSize, font) > maxWidth && chunk) {
                lines.push(chunk);
                chunk = ch;
              } else chunk += ch;
            }
            line = chunk;
          } else line = candidate;
        } else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    if (wrapCache.size > 4000) wrapCache.clear();
    wrapCache.set(key, lines);
    return lines;
  };

  Core.lineHeight = (fontSize) => Math.round(fontSize * 1.35);

  Core.textHeight = function (el, font) {
    const lines = Core.wrapText(el.text, Math.max(20, (el.w || 200) - 8), el.fontSize || 18, font);
    return lines.length * Core.lineHeight(el.fontSize || 18) + 8;
  };

  // ---------- sketch geometry ----------

  // Deterministic per element: the same id always wobbles the same way, so
  // shapes don't shimmer when they re-render.
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  Core.hashSeed = hashSeed;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Core.mulberry32 = mulberry32;

  function wobble(rnd, amount) {
    return (rnd() - 0.5) * 2 * amount;
  }

  // A slightly bowed line: quadratic through a perturbed midpoint.
  function sketchSeg(x1, y1, x2, y2, rnd, strength) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const amp = Math.min(3.2, len * 0.035) * strength;
    const nx = -dy / len;
    const ny = dx / len;
    const off = wobble(rnd, amp);
    const mx = (x1 + x2) / 2 + nx * off + wobble(rnd, amp * 0.4);
    const my = (y1 + y2) / 2 + ny * off + wobble(rnd, amp * 0.4);
    const jx = () => wobble(rnd, amp * 0.35);
    return `M ${round(x1 + jx())} ${round(y1 + jx())} Q ${round(mx)} ${round(my)} ${round(x2 + jx())} ${round(y2 + jx())}`;
  }
  Core.sketchSeg = sketchSeg;

  function sketchPolyLoop(points, rnd, strength, close) {
    let d = '';
    const n = points.length;
    const last = close ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      d += (d ? ' ' : '') + sketchSeg(a[0], a[1], b[0], b[1], rnd, strength);
    }
    return d;
  }
  Core.sketchPolyLoop = sketchPolyLoop;

  function ellipsePoints(cx, cy, rx, ry, steps, rnd, jitter) {
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const j = jitter ? 1 + wobble(rnd, 0.04) : 1;
      pts.push([cx + Math.cos(t) * rx * j, cy + Math.sin(t) * ry * j]);
    }
    return pts;
  }

  // Closed smooth path through points (Catmull-Rom converted to cubics).
  function closedSpline(pts) {
    const n = pts.length;
    if (n < 3) return '';
    let d = `M ${round(pts[0][0])} ${round(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(p2[0])} ${round(p2[1])}`;
    }
    return d + ' Z';
  }
  Core.closedSpline = closedSpline;

  // Open smooth path (freehand strokes).
  Core.openSpline = function (pts) {
    const n = pts.length;
    if (n === 0) return '';
    if (n === 1) return `M ${round(pts[0][0])} ${round(pts[0][1])} l 0.1 0`;
    if (n === 2) return `M ${round(pts[0][0])} ${round(pts[0][1])} L ${round(pts[1][0])} ${round(pts[1][1])}`;
    let d = `M ${round(pts[0][0])} ${round(pts[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(p2[0])} ${round(p2[1])}`;
    }
    return d;
  };

  // Ramer–Douglas–Peucker, to keep freehand JSON small enough to sync.
  Core.simplify = function (pts, epsilon) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let maxDist = -1;
      let index = -1;
      const [ax, ay] = pts[first];
      const [bx, by] = pts[last];
      for (let i = first + 1; i < last; i++) {
        const d = pointSegDistance(pts[i][0], pts[i][1], ax, ay, bx, by);
        if (d > maxDist) { maxDist = d; index = i; }
      }
      if (maxDist > epsilon && index > 0) {
        keep[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push([round(pts[i][0]), round(pts[i][1])]);
    return out;
  };

  function pointSegDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  Core.pointSegDistance = pointSegDistance;

  // ---------- bounds, hit testing, anchors ----------

  function normRect(el) {
    const w = el.w || 0;
    const h = el.h || 0;
    return {
      x: w < 0 ? el.x + w : el.x,
      y: h < 0 ? el.y + h : el.y,
      w: Math.abs(w),
      h: Math.abs(h)
    };
  }
  Core.normRect = normRect;

  Core.bbox = function (el, byId) {
    if (el.kind === 'draw') {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of el.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
      const pad = (el.strokeWidth || 2) / 2;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    if (el.kind === 'arrow' || el.kind === 'line') {
      const { a, b } = Core.resolveArrow(el, byId || {});
      return {
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
        w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1])
      };
    }
    return normRect(el);
  };

  Core.bboxOfAll = function (elements, byId) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      const b = Core.bbox(el, byId);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };

  Core.center = function (el, byId) {
    const b = Core.bbox(el, byId);
    return [b.x + b.w / 2, b.y + b.h / 2];
  };

  Core.hitTest = function (el, px, py, tol, byId) {
    const t = tol || 6;
    if (el.kind === 'draw') {
      const reach = (el.strokeWidth || 2) / 2 + t;
      for (let i = 0; i < el.points.length - 1; i++) {
        const [ax, ay] = el.points[i];
        const [bx, by] = el.points[i + 1];
        if (pointSegDistance(px, py, ax, ay, bx, by) <= reach) return true;
      }
      if (el.points.length === 1) return Math.hypot(px - el.points[0][0], py - el.points[0][1]) <= reach;
      return false;
    }
    if (el.kind === 'arrow' || el.kind === 'line') {
      const { a, b } = Core.resolveArrow(el, byId || {});
      return pointSegDistance(px, py, a[0], a[1], b[0], b[1]) <= (el.strokeWidth || 2) / 2 + t;
    }
    const r = normRect(el);
    if (el.kind === 'ellipse') {
      const rx = r.w / 2 || 1;
      const ry = r.h / 2 || 1;
      const nx = (px - (r.x + rx)) / (rx + t);
      const ny = (py - (r.y + ry)) / (ry + t);
      return nx * nx + ny * ny <= 1;
    }
    if (el.kind === 'diamond') {
      const rx = r.w / 2 || 1;
      const ry = r.h / 2 || 1;
      const nx = Math.abs(px - (r.x + rx)) / (rx + t);
      const ny = Math.abs(py - (r.y + ry)) / (ry + t);
      return nx + ny <= 1;
    }
    if (el.kind === 'frame') {
      // Frames are grabbed by their border or title, so you can still work inside them.
      const inside = px >= r.x - t && px <= r.x + r.w + t && py >= r.y - t && py <= r.y + r.h + t;
      if (!inside) return false;
      const innerGap = px > r.x + t && px < r.x + r.w - t && py > r.y + t && py < r.y + r.h - t;
      const onTitle = py < r.y && py > r.y - 24;
      return !innerGap || onTitle;
    }
    return px >= r.x - t && px <= r.x + r.w + t && py >= r.y - t && py <= r.y + r.h + t;
  };

  // Where an arrow should meet this element, given the direction it comes from.
  Core.anchorPoint = function (el, anchor, towardX, towardY, byId) {
    const r = Core.bbox(el, byId);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (anchor === 'n') return [cx, r.y];
    if (anchor === 's') return [cx, r.y + r.h];
    if (anchor === 'w') return [r.x, cy];
    if (anchor === 'e') return [r.x + r.w, cy];

    let dx = towardX - cx;
    let dy = towardY - cy;
    const len = Math.hypot(dx, dy);
    if (!len) return [cx, cy];
    dx /= len;
    dy /= len;

    const rx = r.w / 2 || 1;
    const ry = r.h / 2 || 1;

    if (el.kind === 'ellipse') {
      const k = 1 / Math.hypot(dx / rx, dy / ry);
      return [cx + dx * k, cy + dy * k];
    }
    if (el.kind === 'diamond') {
      const k = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
      return [cx + dx * k, cy + dy * k];
    }
    const k = Math.min(Math.abs(rx / (dx || 1e-6)), Math.abs(ry / (dy || 1e-6)));
    return [cx + dx * k, cy + dy * k];
  };

  // Bindings are the source of truth: endpoints are derived, never stored.
  Core.resolveArrow = function (el, byId) {
    const pts = el.points && el.points.length >= 2 ? el.points : [[0, 0], [0, 0]];
    let a = [pts[0][0], pts[0][1]];
    let b = [pts[pts.length - 1][0], pts[pts.length - 1][1]];

    const startEl = el.bindStart && byId ? byId[el.bindStart.id] : null;
    const endEl = el.bindEnd && byId ? byId[el.bindEnd.id] : null;

    if (startEl && endEl) {
      const ca = Core.center(startEl, byId);
      const cb = Core.center(endEl, byId);
      a = Core.anchorPoint(startEl, el.bindStart.anchor, cb[0], cb[1], byId);
      b = Core.anchorPoint(endEl, el.bindEnd.anchor, ca[0], ca[1], byId);
    } else if (startEl) {
      a = Core.anchorPoint(startEl, el.bindStart.anchor, b[0], b[1], byId);
    } else if (endEl) {
      b = Core.anchorPoint(endEl, el.bindEnd.anchor, a[0], a[1], byId);
    }

    if (startEl || endEl) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len > BIND_GAP * 2.5) {
        const ux = dx / len;
        const uy = dy / len;
        if (startEl) { a = [a[0] + ux * BIND_GAP, a[1] + uy * BIND_GAP]; }
        if (endEl) { b = [b[0] - ux * BIND_GAP, b[1] - uy * BIND_GAP]; }
      }
    }
    return { a, b };
  };

  // ---------- rendering ----------

  function dashArray(el) {
    if (!el.dash) return null;
    const w = el.strokeWidth || 2;
    return `${w * 4} ${w * 3}`;
  }

  function strokeAttrs(el, sketch) {
    return {
      stroke: el.stroke || Core.DEFAULT_STYLE.stroke,
      'stroke-width': el.strokeWidth || 2,
      'stroke-dasharray': dashArray(el),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      fill: 'none',
      'vector-effect': sketch ? null : null
    };
  }

  function loopPaths(el, sketch, rnd) {
    // Returns [outlinePathD, secondPassD|null] in world coordinates.
    const r = normRect(el);
    const kind = el.kind;
    const corners = [
      [r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]
    ];

    if (kind === 'ellipse') {
      if (!sketch) return [null, null];
      const steps = Math.max(10, Math.min(18, Math.round((r.w + r.h) / 24)));
      const p1 = ellipsePoints(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, steps, rnd, true);
      const p2 = ellipsePoints(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, steps, rnd, true);
      return [closedSpline(p1), closedSpline(p2)];
    }
    if (kind === 'diamond') {
      const pts = [
        [r.x + r.w / 2, r.y], [r.x + r.w, r.y + r.h / 2],
        [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h / 2]
      ];
      if (!sketch) return [polyD(pts, true), null];
      return [sketchPolyLoop(pts, rnd, 1, true), sketchPolyLoop(pts, rnd, 0.7, true)];
    }
    if (kind === 'triangle') {
      const pts = [[r.x + r.w / 2, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      if (!sketch) return [polyD(pts, true), null];
      return [sketchPolyLoop(pts, rnd, 1, true), sketchPolyLoop(pts, rnd, 0.7, true)];
    }
    if (kind === 'cylinder') {
      const ry = Math.min(14, r.h * 0.16);
      const d = [
        `M ${round(r.x)} ${round(r.y + ry)}`,
        `A ${round(r.w / 2)} ${round(ry)} 0 0 1 ${round(r.x + r.w)} ${round(r.y + ry)}`,
        `L ${round(r.x + r.w)} ${round(r.y + r.h - ry)}`,
        `A ${round(r.w / 2)} ${round(ry)} 0 0 1 ${round(r.x)} ${round(r.y + r.h - ry)}`,
        'Z'
      ].join(' ');
      return [d, null];
    }
    // rect, sticky, frame, umlClass, and anything else box-shaped
    if (!sketch || kind === 'sticky' || kind === 'frame') return [polyD(corners, true), null];
    return [sketchPolyLoop(corners, rnd, 1, true), sketchPolyLoop(corners, rnd, 0.65, true)];
  }

  function polyD(pts, close) {
    let d = `M ${round(pts[0][0])} ${round(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${round(pts[i][0])} ${round(pts[i][1])}`;
    return close ? d + ' Z' : d;
  }
  Core.polyD = polyD;

  function appendText(group, el, block, opts) {
    const text = el.kind === 'umlClass' ? el.text : el.text;
    if (!text) return;
    const font = block.sketch ? Core.SKETCH_FONT : Core.CRISP_FONT;
    const size = el.fontSize || Core.DEFAULT_STYLE.fontSize;
    const lh = Core.lineHeight(size);
    const r = normRect(el);
    const boxed = el.kind !== 'text';
    const padding = boxed ? 10 : 4;
    const maxWidth = Math.max(16, r.w - padding * 2);
    const lines = Core.wrapText(text, maxWidth, size, font);

    const topAligned = el.kind === 'sticky' || el.kind === 'frame' || el.kind === 'umlClass' || el.kind === 'text';
    let x = r.x + r.w / 2;
    let anchor = 'middle';
    if (topAligned && el.kind !== 'text') { x = r.x + padding; anchor = 'start'; }
    if (el.kind === 'text') {
      anchor = el.textAlign === 'center' ? 'middle' : el.textAlign === 'right' ? 'end' : 'start';
      x = el.textAlign === 'center' ? r.x + r.w / 2 : el.textAlign === 'right' ? r.x + r.w - padding : r.x + padding;
    }

    const totalHeight = lines.length * lh;
    let y = topAligned
      ? r.y + padding + size * 0.85
      : r.y + r.h / 2 - totalHeight / 2 + size * 0.85;

    if (el.kind === 'frame') y = r.y - 8;    // frame label sits above the border

    const textNode = svg('text', {
      'font-family': font,
      'font-size': size,
      fill: el.kind === 'sticky' ? '#2b2620' : (el.stroke || Core.DEFAULT_STYLE.stroke),
      'text-anchor': anchor,
      'dominant-baseline': 'auto',
      'style': 'white-space:pre'
    });

    // A "--" line is a UML compartment separator: it becomes a rule in a tight
    // gap rather than an empty text line, so compartments don't gape.
    const rules = [];
    let cursor = y;
    for (const line of lines) {
      if (el.kind === 'umlClass' && line === '--') {
        rules.push(round(cursor - size * 0.72));
        cursor += size * 0.55;
        continue;
      }
      const tspan = svg('tspan', { x: round(x), y: round(cursor) });
      tspan.textContent = line;
      textNode.appendChild(tspan);
      cursor += lh;
    }
    group.appendChild(textNode);

    for (const ly of rules) {
      group.appendChild(svg('line', {
        x1: round(r.x), y1: ly, x2: round(r.x + r.w), y2: ly,
        stroke: el.stroke || Core.DEFAULT_STYLE.stroke, 'stroke-width': 1
      }));
    }
    if (opts && opts.measured) opts.measured.height = totalHeight + padding * 2;
  };

  function headPath(tipX, tipY, fromX, fromY, kind, size) {
    const angle = Math.atan2(tipY - fromY, tipX - fromX);
    const spread = 0.42;
    const p = (dist, rot) => [
      tipX - Math.cos(angle + rot) * dist,
      tipY - Math.sin(angle + rot) * dist
    ];
    if (kind === 'arrow') {
      const [ax, ay] = p(size, spread);
      const [bx, by] = p(size, -spread);
      return { d: `M ${round(ax)} ${round(ay)} L ${round(tipX)} ${round(tipY)} L ${round(bx)} ${round(by)}`, filled: false, trim: 0 };
    }
    if (kind === 'triangle' || kind === 'triangleHollow') {
      const [ax, ay] = p(size * 1.15, spread * 0.9);
      const [bx, by] = p(size * 1.15, -spread * 0.9);
      return {
        d: `M ${round(tipX)} ${round(tipY)} L ${round(ax)} ${round(ay)} L ${round(bx)} ${round(by)} Z`,
        filled: kind === 'triangle', hollow: kind === 'triangleHollow', trim: size * 1.05
      };
    }
    if (kind === 'diamond' || kind === 'diamondHollow') {
      const len = size * 1.8;
      const [ax, ay] = p(len / 2, spread * 1.1);
      const [bx, by] = p(len, 0);
      const [cx, cy] = p(len / 2, -spread * 1.1);
      return {
        d: `M ${round(tipX)} ${round(tipY)} L ${round(ax)} ${round(ay)} L ${round(bx)} ${round(by)} L ${round(cx)} ${round(cy)} Z`,
        filled: kind === 'diamond', hollow: kind === 'diamondHollow', trim: len
      };
    }
    if (kind === 'circle') {
      const [cx, cy] = p(size * 0.5, 0);
      return { circle: [cx, cy, size * 0.5], filled: true, trim: size };
    }
    return null;
  }

  function renderArrow(group, el, byId, sketch) {
    const { a, b } = Core.resolveArrow(el, byId);
    const sw = el.strokeWidth || 2;
    const headSize = 6 + sw * 2.2;
    const startKind = el.headStart && el.headStart !== 'none' ? el.headStart : null;
    const endKind = el.kind === 'line'
      ? (el.headEnd && el.headEnd !== 'none' ? el.headEnd : null)
      : (el.headEnd === undefined ? 'arrow' : (el.headEnd !== 'none' ? el.headEnd : null));

    let ax = a[0], ay = a[1], bx = b[0], by = b[1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    const startHead = startKind ? headPath(ax, ay, bx, by, startKind, headSize) : null;
    const endHead = endKind ? headPath(bx, by, ax, ay, endKind, headSize) : null;

    // Pull the shaft back so it doesn't poke through a solid head.
    let sx = ax, sy = ay, ex = bx, ey = by;
    if (startHead && startHead.trim) { sx += ux * startHead.trim * 0.85; sy += uy * startHead.trim * 0.85; }
    if (endHead && endHead.trim) { ex -= ux * endHead.trim * 0.85; ey -= uy * endHead.trim * 0.85; }

    const rnd = mulberry32(hashSeed(el.id));
    const shaftD = sketch
      ? sketchSeg(sx, sy, ex, ey, rnd, 0.8)
      : `M ${round(sx)} ${round(sy)} L ${round(ex)} ${round(ey)}`;

    group.appendChild(svg('path', Object.assign(strokeAttrs(el, sketch), { d: shaftD })));
    if (sketch) {
      group.appendChild(svg('path', Object.assign(strokeAttrs(el, sketch), {
        d: sketchSeg(sx, sy, ex, ey, rnd, 0.5), opacity: 0.55
      })));
    }

    for (const head of [startHead, endHead]) {
      if (!head) continue;
      const color = el.stroke || Core.DEFAULT_STYLE.stroke;
      if (head.circle) {
        group.appendChild(svg('circle', {
          cx: round(head.circle[0]), cy: round(head.circle[1]), r: round(head.circle[2]),
          fill: color, stroke: color, 'stroke-width': sw
        }));
      } else {
        group.appendChild(svg('path', {
          d: head.d,
          fill: head.filled ? color : (head.hollow ? HOLLOW : 'none'),
          stroke: color,
          'stroke-width': sw,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        }));
      }
    }

    // Label on the arrow midpoint
    if (el.text) {
      const font = sketch ? Core.SKETCH_FONT : Core.CRISP_FONT;
      const size = el.fontSize || 15;
      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;
      const width = measureText(el.text, size, font);
      group.appendChild(svg('rect', {
        x: round(mx - width / 2 - 4), y: round(my - size * 0.75 - 2),
        width: round(width + 8), height: round(size * 1.3 + 4),
        fill: HOLLOW, rx: 3, opacity: 0.9
      }));
      const label = svg('text', {
        x: round(mx), y: round(my + size * 0.35),
        'font-family': font, 'font-size': size,
        fill: el.stroke || Core.DEFAULT_STYLE.stroke, 'text-anchor': 'middle'
      });
      label.textContent = el.text;
      group.appendChild(label);
    }

    // Invisible fat line so thin arrows are easy to grab.
    group.appendChild(svg('path', {
      d: `M ${round(ax)} ${round(ay)} L ${round(bx)} ${round(by)}`,
      stroke: 'transparent', 'stroke-width': Math.max(14, sw + 12), fill: 'none', class: 'hit'
    }));
  }

  function renderIcon(group, el, block) {
    const r = normRect(el);
    const size = Math.min(r.w, r.h * 0.82);
    const iconId = el.icon || '';
    const scale = size / 24;
    const ox = r.x + (r.w - size) / 2;
    const oy = r.y;

    let node = null;
    if (iconId.startsWith('custom:')) {
      const asset = block.assets && block.assets[iconId.slice(7)];
      if (asset) {
        node = svg('g', {});
        const holder = svg('svg', { viewBox: asset.viewBox || '0 0 24 24', width: 24, height: 24, overflow: 'visible' });
        holder.innerHTML = asset.body;
        node.appendChild(holder);
      }
    } else if (App.Icons) {
      node = App.Icons.nodeFor(iconId, el.stroke || Core.DEFAULT_STYLE.stroke);
    }
    if (!node) {
      node = svg('g', {});
      node.appendChild(svg('rect', { x: 2, y: 2, width: 20, height: 20, rx: 3, fill: 'none', stroke: '#a89c8c', 'stroke-dasharray': '3 2' }));
    }
    node.setAttribute('transform', `translate(${round(ox)} ${round(oy)}) scale(${round(scale * 100) / 100})`);
    group.appendChild(node);

    if (el.text) {
      const font = block.sketch ? Core.SKETCH_FONT : Core.CRISP_FONT;
      const fontSize = el.fontSize || 14;
      const lines = Core.wrapText(el.text, Math.max(40, r.w + 20), fontSize, font);
      const label = svg('text', {
        x: round(r.x + r.w / 2), y: round(oy + size + fontSize),
        'font-family': font, 'font-size': fontSize,
        fill: el.stroke || Core.DEFAULT_STYLE.stroke, 'text-anchor': 'middle'
      });
      lines.forEach((line, i) => {
        const tspan = svg('tspan', { x: round(r.x + r.w / 2), dy: i === 0 ? 0 : Core.lineHeight(fontSize) });
        tspan.textContent = line;
        label.appendChild(tspan);
      });
      group.appendChild(label);
    }

    group.appendChild(svg('rect', {
      x: round(r.x), y: round(r.y), width: round(r.w), height: round(r.h),
      fill: 'transparent', class: 'hit'
    }));
  }

  Core.renderElement = function (el, block, byId) {
    const sketch = !!block.sketch;
    const group = svg('g', {
      'data-el-id': el.id,
      class: 'cv-el cv-' + el.kind,
      opacity: el.opacity === undefined ? 1 : el.opacity
    });

    if (el.kind === 'arrow' || el.kind === 'line') {
      renderArrow(group, el, byId, sketch);
      return group;
    }

    if (el.kind === 'draw') {
      const d = Core.openSpline(el.points || []);
      group.appendChild(svg('path', Object.assign(strokeAttrs(el, sketch), { d })));
      group.appendChild(svg('path', {
        d, stroke: 'transparent', 'stroke-width': Math.max(14, (el.strokeWidth || 2) + 12),
        fill: 'none', class: 'hit'
      }));
      return group;
    }

    if (el.kind === 'icon') {
      renderIcon(group, el, block);
      return group;
    }

    if (el.kind === 'text') {
      appendText(group, el, block);
      const r = normRect(el);
      group.appendChild(svg('rect', {
        x: round(r.x), y: round(r.y), width: round(r.w), height: round(Math.max(r.h, 20)),
        fill: 'transparent', class: 'hit'
      }));
      return group;
    }

    // Shapes
    const r = normRect(el);
    const rnd = mulberry32(hashSeed(el.id));
    const [d1, d2] = loopPaths(el, sketch, rnd);
    const fill = el.kind === 'sticky'
      ? (el.fill && el.fill !== 'transparent' ? el.fill : Core.STICKY_FILLS[0])
      : (el.fill || 'transparent');

    if (el.kind === 'ellipse' && !sketch) {
      group.appendChild(svg('ellipse', Object.assign(strokeAttrs(el, sketch), {
        cx: round(r.x + r.w / 2), cy: round(r.y + r.h / 2),
        rx: round(r.w / 2), ry: round(r.h / 2), fill
      })));
    } else if (el.kind === 'sticky') {
      group.appendChild(svg('rect', {
        x: round(r.x), y: round(r.y), width: round(r.w), height: round(r.h),
        fill, stroke: 'rgba(43,38,32,0.12)', 'stroke-width': 1, rx: 2
      }));
    } else if (el.kind === 'frame') {
      group.appendChild(svg('rect', {
        x: round(r.x), y: round(r.y), width: round(r.w), height: round(r.h),
        fill: el.fill && el.fill !== 'transparent' ? el.fill : 'rgba(255,255,255,0.35)',
        stroke: el.stroke || '#a89c8c', 'stroke-width': el.strokeWidth || 1.5,
        'stroke-dasharray': '10 7', rx: 6
      }));
    } else {
      group.appendChild(svg('path', Object.assign(strokeAttrs(el, sketch), { d: d1, fill })));
      if (d2) group.appendChild(svg('path', Object.assign(strokeAttrs(el, sketch), { d: d2, fill: 'none', opacity: 0.6 })));
    }

    appendText(group, el, block);

    group.appendChild(svg('rect', {
      x: round(r.x), y: round(r.y), width: round(r.w), height: round(r.h),
      fill: 'transparent', class: 'hit'
    }));
    return group;
  };

  // ---------- export ----------

  Core.exportSVGString = function (block, opts) {
    const options = opts || {};
    const padding = options.padding === undefined ? 24 : options.padding;
    const byId = Core.indexById(block.elements);
    const box = Core.bboxOfAll(block.elements, byId) || { x: 0, y: 0, w: 400, h: 300 };
    const width = Math.max(1, Math.round(box.w + padding * 2));
    const height = Math.max(1, Math.round(box.h + padding * 2));
    const vx = Math.round(box.x - padding);
    const vy = Math.round(box.y - padding);

    const root = svg('svg', {
      xmlns: NS,
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      width,
      height,
      viewBox: `${vx} ${vy} ${width} ${height}`
    });
    if (options.background !== 'transparent') {
      root.appendChild(svg('rect', { x: vx, y: vy, width, height, fill: options.background || '#faf6ee' }));
    }
    for (const el of block.elements) {
      const group = Core.renderElement(el, block, byId);
      group.querySelectorAll('.hit').forEach((n) => n.remove());
      root.appendChild(group);
    }
    return new XMLSerializer().serializeToString(root);
  };
})();

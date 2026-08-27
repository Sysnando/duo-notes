/* Duo Notes — canvas surface: camera, tools, selection, bindings, history, export.
 *
 * One Surface drives one live canvas view (inline in a page, or expanded in the
 * drawer). Geometry and element rendering come from canvas-core.js; the toolbar,
 * style panel and icon picker come from canvas-ui.js. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const Canvas = (App.Canvas = {});
  const Core = App.CanvasCore;
  const svg = Core.svg;

  const MIN_ZOOM = 0.15;
  const MAX_ZOOM = 5;
  const SNAP_PX = 6;
  const BIND_PX = 16;
  const HANDLE = 9;

  const surfaces = [];
  let clipboard = null;

  Canvas.makeBlock = Core.makeBlock;

  const uid = () => (App.uid ? App.uid() : Math.random().toString(36).slice(2));

  // ---------- registry-level helpers used by sync.js ----------

  function liveSurfaces() {
    for (let i = surfaces.length - 1; i >= 0; i--) {
      if (!document.contains(surfaces[i].root)) surfaces.splice(i, 1);
    }
    return surfaces;
  }

  Canvas.isBusy = function () {
    return liveSurfaces().some((s) => s.isBusy());
  };

  Canvas.refreshAll = function () {
    for (const s of liveSurfaces()) s.reload();
  };

  // Union canvas elements by id so two people drawing at once don't erase each
  // other. Local edits win per element; anything only the server has is kept.
  Canvas.mergeCanvasBlocks = function (localPage, remotePage) {
    if (!localPage || !remotePage || !Array.isArray(localPage.blocks) || !Array.isArray(remotePage.blocks)) return;
    const localById = {};
    for (const block of localPage.blocks) if (block && block.type === 'canvas') localById[block.id] = block;

    for (const remoteBlock of remotePage.blocks) {
      if (!remoteBlock || remoteBlock.type !== 'canvas') continue;
      const localBlock = localById[remoteBlock.id];
      if (!localBlock) continue;
      Core.normalize(localBlock);
      Core.normalize(remoteBlock);

      const merged = [];
      const seen = new Set();
      const localIndex = Core.indexById(localBlock.elements);
      for (const el of remoteBlock.elements) {
        merged.push(localIndex[el.id] || el);
        seen.add(el.id);
      }
      for (const el of localBlock.elements) {
        if (!seen.has(el.id)) merged.push(el);
      }
      remoteBlock.elements = merged;
      remoteBlock.assets = Object.assign({}, remoteBlock.assets, localBlock.assets);
    }
  };

  // Append elements the server has but we don't, into our local canvas blocks.
  // Used when our copy of the page wins on timestamp but theirs holds strokes we
  // have never seen. Returns true when something was added.
  Canvas.foldRemoteElements = function (localPage, remotePage) {
    if (!localPage || !remotePage || !Array.isArray(localPage.blocks) || !Array.isArray(remotePage.blocks)) return false;
    const remoteById = {};
    for (const block of remotePage.blocks) if (block && block.type === 'canvas') remoteById[block.id] = block;

    let changed = false;
    for (const localBlock of localPage.blocks) {
      if (!localBlock || localBlock.type !== 'canvas') continue;
      const remoteBlock = remoteById[localBlock.id];
      if (!remoteBlock) continue;
      Core.normalize(localBlock);
      Core.normalize(remoteBlock);
      const known = new Set(localBlock.elements.map((el) => el.id));
      for (const el of remoteBlock.elements) {
        if (!known.has(el.id)) { localBlock.elements.push(el); changed = true; }
      }
      for (const key in remoteBlock.assets) {
        if (!localBlock.assets[key]) { localBlock.assets[key] = remoteBlock.assets[key]; changed = true; }
      }
    }
    return changed;
  };

  // ---------- inline block rendering (called by editor.js) ----------

  Canvas.render = function (block, page) {
    Core.normalize(block);
    const wrap = document.createElement('div');
    wrap.className = 'cv-block';

    const stage = document.createElement('div');
    stage.className = 'cv-stage';
    wrap.appendChild(stage);

    const surface = Canvas.createSurface({ block, page, container: stage, expanded: false });
    if (App.CanvasUI) App.CanvasUI.mountChrome(surface, wrap, { compact: true });
    requestAnimationFrame(() => surface.resize());
    return wrap;
  };

  // ---------- surface ----------

  Canvas.createSurface = function (opts) {
    const page = opts.page;
    const expanded = !!opts.expanded;
    let block = Core.normalize(opts.block);

    const root = document.createElement('div');
    root.className = 'cv-surface' + (expanded ? ' expanded' : '');
    root.tabIndex = 0;
    opts.container.appendChild(root);

    const svgEl = svg('svg', { class: 'cv-svg' });
    const defs = svg('defs', {});
    const bgRect = svg('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'none' });
    const content = svg('g', { class: 'cv-content' });
    const ghosts = svg('g', { class: 'cv-ghosts' });   // in-progress strokes from the other person
    const overlay = svg('g', { class: 'cv-overlay' }); // screen-space chrome: handles, guides, cursors
    svgEl.append(defs, bgRect, content, ghosts, overlay);
    root.appendChild(svgEl);

    const editorHost = document.createElement('div');
    editorHost.className = 'cv-text-host';
    root.appendChild(editorHost);

    const viewKey = 'duo-notes.view.' + block.id;
    let view = { tx: 40, ty: 40, z: 1 };
    try {
      const saved = JSON.parse(localStorage.getItem(viewKey) || 'null');
      if (saved && typeof saved.z === 'number') view = saved;
    } catch (err) { /* fresh camera */ }

    let tool = 'select';
    let style = Object.assign({}, Core.DEFAULT_STYLE);
    let selection = new Set();
    let gesture = null;
    let hoverId = null;
    let highlightId = null;
    let textEditor = null;
    let history = [];
    let historyIndex = -1;
    let nodeById = new Map();
    let byId = {};
    let spaceDown = false;
    let guides = [];
    let marquee = null;
    let remoteCursors = [];
    let lastWorld = [0, 0];
    let onChange = null;
    let onSelection = null;
    let onToolChange = null;
    let broadcast = null;

    const surface = {
      root, svgEl, expanded, page,
      get block() { return block; },
      get tool() { return tool; },
      get style() { return style; },
      get selectionIds() { return [...selection]; }
    };

    // ---------- coordinate helpers ----------

    let rectCache = null;
    function svgRect() {
      if (!rectCache) rectCache = svgEl.getBoundingClientRect();
      return rectCache;
    }
    function screenPoint(evt) {
      const r = svgRect();
      return [evt.clientX - r.left, evt.clientY - r.top];
    }
    const toWorld = (p) => [(p[0] - view.tx) / view.z, (p[1] - view.ty) / view.z];
    const toScreen = (p) => [p[0] * view.z + view.tx, p[1] * view.z + view.ty];
    surface.toWorld = toWorld;
    surface.toScreen = toScreen;

    // ---------- persistence ----------

    function saveView() {
      try { localStorage.setItem(viewKey, JSON.stringify(view)); } catch (err) { /* quota */ }
    }

    function commit() {
      pushHistory();
      persist();
    }

    function persist() {
      if (page && App.persistAndRender) App.persistAndRender(page.id, { rerender: false });
      if (onChange) onChange();
    }

    function pushHistory() {
      const snapshot = JSON.stringify(block.elements);
      if (history[historyIndex] === snapshot) return;
      history = history.slice(0, historyIndex + 1);
      history.push(snapshot);
      if (history.length > 60) history.shift();
      historyIndex = history.length - 1;
    }
    pushHistory();

    function applyHistory(index) {
      if (index < 0 || index >= history.length) return;
      historyIndex = index;
      block.elements = JSON.parse(history[index]);
      selection = new Set([...selection].filter((id) => block.elements.some((el) => el.id === id)));
      render();
      persist();
      emitSelection();
    }

    surface.undo = () => applyHistory(historyIndex - 1);
    surface.redo = () => applyHistory(historyIndex + 1);
    surface.canUndo = () => historyIndex > 0;
    surface.canRedo = () => historyIndex < history.length - 1;

    // ---------- rendering ----------

    function updateBackground() {
      defs.textContent = '';
      if (block.bg === 'plain') { bgRect.setAttribute('fill', 'transparent'); return; }
      const step = 20 * view.z;
      const patternId = 'cv-bg-' + block.id.replace(/[^a-zA-Z0-9]/g, '');
      const pattern = svg('pattern', {
        id: patternId,
        width: step,
        height: step,
        patternUnits: 'userSpaceOnUse',
        patternTransform: `translate(${view.tx % step} ${view.ty % step})`
      });
      if (block.bg === 'dots') {
        pattern.appendChild(svg('circle', { cx: step / 2, cy: step / 2, r: Math.max(0.6, 1 * view.z), fill: '#cdbfa8' }));
      } else {
        pattern.appendChild(svg('path', {
          d: `M ${step} 0 H 0 V ${step}`,
          fill: 'none', stroke: 'rgba(168,156,140,0.35)', 'stroke-width': 1
        }));
      }
      defs.appendChild(pattern);
      bgRect.setAttribute('fill', `url(#${patternId})`);
    }

    function applyTransform() {
      const transform = `translate(${Core.round(view.tx)} ${Core.round(view.ty)}) scale(${view.z})`;
      content.setAttribute('transform', transform);
      ghosts.setAttribute('transform', transform);
      updateBackground();
    }

    function render() {
      byId = Core.indexById(block.elements);
      content.textContent = '';
      nodeById = new Map();
      for (const el of block.elements) {
        const node = Core.renderElement(el, block, byId);
        nodeById.set(el.id, node);
        content.appendChild(node);
      }
      applyTransform();
      drawOverlay();
    }
    surface.render = render;

    // Re-render only the given elements, plus any arrow bound to them.
    function patch(ids) {
      byId = Core.indexById(block.elements);
      const set = new Set(ids);
      for (const el of block.elements) {
        if ((el.kind === 'arrow' || el.kind === 'line') &&
            ((el.bindStart && set.has(el.bindStart.id)) || (el.bindEnd && set.has(el.bindEnd.id)))) {
          set.add(el.id);
        }
      }
      for (const id of set) {
        const el = byId[id];
        const old = nodeById.get(id);
        if (!el || !old) continue;
        const fresh = Core.renderElement(el, block, byId);
        old.replaceWith(fresh);
        nodeById.set(id, fresh);
      }
      drawOverlay();
    }

    function selectedElements() {
      return block.elements.filter((el) => selection.has(el.id));
    }

    function selectionBox() {
      const els = selectedElements();
      if (!els.length) return null;
      return Core.bboxOfAll(els, byId);
    }

    function drawOverlay() {
      overlay.textContent = '';

      for (const g of guides) {
        const a = toScreen([g[0], g[1]]);
        const b = toScreen([g[2], g[3]]);
        overlay.appendChild(svg('line', {
          x1: a[0], y1: a[1], x2: b[0], y2: b[1],
          stroke: '#c05b3c', 'stroke-width': 1, 'stroke-dasharray': '4 3'
        }));
      }

      if (marquee) {
        overlay.appendChild(svg('rect', {
          x: Math.min(marquee[0], marquee[2]), y: Math.min(marquee[1], marquee[3]),
          width: Math.abs(marquee[2] - marquee[0]), height: Math.abs(marquee[3] - marquee[1]),
          fill: 'rgba(192,91,60,0.08)', stroke: '#c05b3c', 'stroke-width': 1
        }));
      }

      if (highlightId && byId[highlightId]) {
        const b = Core.bbox(byId[highlightId], byId);
        const p = toScreen([b.x, b.y]);
        overlay.appendChild(svg('rect', {
          x: p[0] - 3, y: p[1] - 3, width: b.w * view.z + 6, height: b.h * view.z + 6,
          fill: 'none', stroke: '#c05b3c', 'stroke-width': 2, rx: 4
        }));
      }

      const box = selectionBox();
      if (box && !gesture) {
        const p = toScreen([box.x, box.y]);
        const w = box.w * view.z;
        const h = box.h * view.z;
        overlay.appendChild(svg('rect', {
          x: p[0] - 2, y: p[1] - 2, width: w + 4, height: h + 4,
          fill: 'none', stroke: '#c05b3c', 'stroke-width': 1.5, 'stroke-dasharray': '5 4', class: 'cv-selbox'
        }));

        const single = selectedElements();
        const isSingleArrow = single.length === 1 && (single[0].kind === 'arrow' || single[0].kind === 'line');
        if (isSingleArrow) {
          const { a, b } = Core.resolveArrow(single[0], byId);
          for (const [point, which] of [[a, 'start'], [b, 'end']]) {
            const s = toScreen(point);
            overlay.appendChild(svg('circle', {
              cx: s[0], cy: s[1], r: HANDLE / 2 + 1,
              fill: '#fffdf8', stroke: '#c05b3c', 'stroke-width': 2,
              class: 'cv-handle', 'data-endpoint': which
            }));
          }
        } else {
          for (const [hx, hy, id] of handlePositions(p[0], p[1], w, h)) {
            overlay.appendChild(svg('rect', {
              x: hx - HANDLE / 2, y: hy - HANDLE / 2, width: HANDLE, height: HANDLE,
              fill: '#fffdf8', stroke: '#c05b3c', 'stroke-width': 1.5, rx: 2,
              class: 'cv-handle', 'data-handle': id
            }));
          }
        }
      }

      // Connector dots for quick arrow linking
      if (tool === 'select' && !gesture && hoverId && byId[hoverId] && canBind(byId[hoverId])) {
        const b = Core.bbox(byId[hoverId], byId);
        for (const [anchor, wx, wy] of [
          ['n', b.x + b.w / 2, b.y],
          ['s', b.x + b.w / 2, b.y + b.h],
          ['w', b.x, b.y + b.h / 2],
          ['e', b.x + b.w, b.y + b.h / 2]
        ]) {
          const s = toScreen([wx, wy]);
          overlay.appendChild(svg('circle', {
            cx: s[0], cy: s[1], r: 5,
            fill: '#c05b3c', stroke: '#fffdf8', 'stroke-width': 1.5,
            class: 'cv-dot', 'data-anchor': anchor, 'data-el': hoverId
          }));
        }
      }

      for (const cursor of remoteCursors) {
        const s = toScreen([cursor.x, cursor.y]);
        const g = svg('g', { class: 'cv-remote' });
        g.appendChild(svg('path', {
          d: 'M0 0 L0 14 L4 10.5 L7 16 L9.5 15 L6.5 9.5 L11 9 Z',
          fill: cursor.color || '#c05b3c', stroke: '#fffdf8', 'stroke-width': 1,
          transform: `translate(${s[0]} ${s[1]})`
        }));
        const label = svg('text', {
          x: s[0] + 13, y: s[1] + 18, 'font-size': 11, 'font-family': 'Newsreader, serif',
          fill: '#fffdf8', stroke: 'none'
        });
        label.textContent = cursor.name || 'guest';
        const width = Core.measureText(label.textContent, 11, 'Newsreader, serif') + 10;
        g.appendChild(svg('rect', {
          x: s[0] + 9, y: s[1] + 7, width, height: 16, rx: 8, fill: cursor.color || '#c05b3c'
        }));
        g.appendChild(label);
        overlay.appendChild(g);
      }
    }

    function handlePositions(x, y, w, h) {
      return [
        [x, y, 'nw'], [x + w / 2, y, 'n'], [x + w, y, 'ne'],
        [x + w, y + h / 2, 'e'], [x + w, y + h, 'se'],
        [x + w / 2, y + h, 's'], [x, y + h, 'sw'], [x, y + h / 2, 'w']
      ];
    }

    const canBind = (el) => el && el.kind !== 'arrow' && el.kind !== 'line' && el.kind !== 'draw' && el.kind !== 'frame';

    // ---------- hit testing ----------

    function elementAt(worldPoint) {
      const tol = 6 / view.z;
      for (let i = block.elements.length - 1; i >= 0; i--) {
        const el = block.elements[i];
        if (Core.hitTest(el, worldPoint[0], worldPoint[1], tol, byId)) return el;
      }
      return null;
    }

    function bindTargetAt(worldPoint, excludeId) {
      const tol = BIND_PX / view.z;
      for (let i = block.elements.length - 1; i >= 0; i--) {
        const el = block.elements[i];
        if (el.id === excludeId || !canBind(el)) continue;
        if (Core.hitTest(el, worldPoint[0], worldPoint[1], tol, byId)) return el;
      }
      return null;
    }

    function overlayHandleAt(screen) {
      let found = null;
      overlay.querySelectorAll('.cv-handle, .cv-dot').forEach((node) => {
        if (found) return;
        const isRect = node.tagName === 'rect';
        const cx = isRect ? +node.getAttribute('x') + HANDLE / 2 : +node.getAttribute('cx');
        const cy = isRect ? +node.getAttribute('y') + HANDLE / 2 : +node.getAttribute('cy');
        if (Math.hypot(screen[0] - cx, screen[1] - cy) <= 9) found = node;
      });
      return found;
    }

    // ---------- snapping ----------

    function computeSnap(movingIds, dx, dy) {
      const moving = block.elements.filter((el) => movingIds.has(el.id));
      const box = Core.bboxOfAll(moving, byId);
      guides = [];
      if (!box) return [dx, dy];

      const threshold = SNAP_PX / view.z;
      const candidate = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
      const others = block.elements.filter((el) => !movingIds.has(el.id));
      let bestX = null;
      let bestY = null;

      for (const el of others) {
        const b = Core.bbox(el, byId);
        const pairsX = [
          [candidate.x, b.x], [candidate.x, b.x + b.w],
          [candidate.x + candidate.w / 2, b.x + b.w / 2],
          [candidate.x + candidate.w, b.x], [candidate.x + candidate.w, b.x + b.w]
        ];
        for (const [from, to] of pairsX) {
          const delta = to - from;
          if (Math.abs(delta) < threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
            bestX = { delta, line: to, other: b };
          }
        }
        const pairsY = [
          [candidate.y, b.y], [candidate.y, b.y + b.h],
          [candidate.y + candidate.h / 2, b.y + b.h / 2],
          [candidate.y + candidate.h, b.y], [candidate.y + candidate.h, b.y + b.h]
        ];
        for (const [from, to] of pairsY) {
          const delta = to - from;
          if (Math.abs(delta) < threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
            bestY = { delta, line: to, other: b };
          }
        }
      }

      let outX = dx;
      let outY = dy;
      if (bestX) {
        outX = dx + bestX.delta;
        const top = Math.min(candidate.y, bestX.other.y);
        const bottom = Math.max(candidate.y + candidate.h, bestX.other.y + bestX.other.h);
        guides.push([bestX.line, top - 20, bestX.line, bottom + 20]);
      }
      if (bestY) {
        outY = dy + bestY.delta;
        const left = Math.min(candidate.x, bestY.other.x);
        const right = Math.max(candidate.x + candidate.w, bestY.other.x + bestY.other.w);
        guides.push([left - 20, bestY.line, right + 20, bestY.line]);
      }
      return [outX, outY];
    }

    // ---------- element factories ----------

    function styleFor(kind) {
      const base = {
        stroke: style.stroke,
        fill: kind === 'sticky' ? (style.fill !== 'transparent' ? style.fill : Core.STICKY_FILLS[0]) : style.fill,
        strokeWidth: style.strokeWidth,
        dash: style.dash,
        opacity: style.opacity,
        fontSize: style.fontSize
      };
      if (kind === 'frame') { base.fill = 'transparent'; base.dash = true; }
      return base;
    }

    function addElement(el, options) {
      block.elements.push(el);
      if (!options || options.render !== false) render();
      if (!options || options.commit !== false) commit();
      return el;
    }

    surface.insertIcon = function (iconId, label) {
      const r = svgRect();
      const centre = toWorld([r.width / 2, r.height / 2]);
      const el = Object.assign({
        id: uid(), kind: 'icon', icon: iconId,
        x: Core.round(centre[0] - 40), y: Core.round(centre[1] - 40),
        w: 80, h: 96, text: label || ''
      }, styleFor('icon'));
      el.fill = 'transparent';
      addElement(el);
      selection = new Set([el.id]);
      emitSelection();
      drawOverlay();
      return el;
    };

    surface.insertShape = function (kind) {
      const r = svgRect();
      const centre = toWorld([r.width / 2, r.height / 2]);
      const w = kind === 'umlClass' ? 200 : 160;
      const h = kind === 'umlClass' ? 120 : 100;
      const el = Object.assign({
        id: uid(), kind,
        x: Core.round(centre[0] - w / 2), y: Core.round(centre[1] - h / 2),
        w, h, text: kind === 'umlClass' ? 'ClassName\n--\n+ field\n--\n+ method()' : ''
      }, styleFor(kind));
      addElement(el);
      selection = new Set([el.id]);
      emitSelection();
      drawOverlay();
      return el;
    };

    // ---------- text editing ----------

    function openTextEditor(el) {
      closeTextEditor();
      const r = Core.bbox(el, byId);
      const screen = toScreen([r.x, r.y]);
      const area = document.createElement('textarea');
      area.className = 'cv-textarea';
      area.value = el.text || '';
      const fontSize = (el.fontSize || Core.DEFAULT_STYLE.fontSize) * view.z;
      const boxed = el.kind !== 'text' && el.kind !== 'arrow' && el.kind !== 'line';
      area.style.left = `${screen[0]}px`;
      area.style.top = `${screen[1]}px`;
      area.style.width = `${Math.max(60, (r.w || 160) * view.z)}px`;
      area.style.height = `${Math.max(fontSize * 1.6, (boxed ? r.h * view.z : fontSize * 1.8))}px`;
      area.style.fontSize = `${fontSize}px`;
      area.style.fontFamily = block.sketch ? Core.SKETCH_FONT : Core.CRISP_FONT;
      area.style.color = el.stroke || Core.DEFAULT_STYLE.stroke;
      area.style.textAlign = el.kind === 'text' ? (el.textAlign || 'left') : (boxed && el.kind !== 'sticky' && el.kind !== 'umlClass' ? 'center' : 'left');
      editorHost.appendChild(area);
      area.focus();
      area.select();

      textEditor = { el, area };
      area.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(true); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeTextEditor(); }
      });
      area.addEventListener('blur', () => closeTextEditor());
    }

    function closeTextEditor(discard) {
      if (!textEditor) return;
      const { el, area } = textEditor;
      const value = area.value;
      textEditor = null;
      area.remove();
      if (discard) { render(); return; }
      if ((el.text || '') === value) {
        // Nothing typed into a brand-new text element: drop it.
        if (el.kind === 'text' && !value.trim()) {
          block.elements = block.elements.filter((x) => x.id !== el.id);
          selection.delete(el.id);
          render();
          commit();
          emitSelection();
          return;
        }
        render();
        return;
      }
      el.text = value;
      if (el.kind === 'text') {
        const font = block.sketch ? Core.SKETCH_FONT : Core.CRISP_FONT;
        el.h = Core.textHeight(el, font);
        if (!value.trim()) {
          block.elements = block.elements.filter((x) => x.id !== el.id);
          selection.delete(el.id);
        }
      }
      render();
      commit();
      emitSelection();
    }
    surface.closeTextEditor = closeTextEditor;

    // ---------- pointer handling ----------

    function beginGesture(kind, extra) {
      gesture = Object.assign({ kind, moved: false }, extra);
      root.classList.add('busy');
    }

    function endGesture() {
      gesture = null;
      guides = [];
      marquee = null;
      highlightId = null;
      root.classList.remove('busy');
      // Clear the ghost on the other side, bypassing the throttle.
      if (broadcast) broadcast({ x: lastWorld[0], y: lastWorld[1], draft: null, force: true });
      if (App.Sync && App.Sync.flushDeferred) App.Sync.flushDeferred();
    }

    svgEl.addEventListener('pointerdown', (evt) => {
      if (evt.button === 2) return;
      rectCache = null;
      root.focus({ preventScroll: true });
      if (textEditor) closeTextEditor();

      const screen = screenPoint(evt);
      const world = toWorld(screen);
      try { svgEl.setPointerCapture(evt.pointerId); } catch (err) { /* synthetic pointer */ }

      // Middle button, space, or the hand tool always pans.
      if (evt.button === 1 || spaceDown || tool === 'pan') {
        beginGesture('pan', { start: screen, origin: { tx: view.tx, ty: view.ty } });
        return;
      }

      if (tool === 'select') {
        const handleNode = overlayHandleAt(screen);
        if (handleNode) {
          if (handleNode.classList.contains('cv-dot')) {
            const sourceId = handleNode.getAttribute('data-el');
            const anchor = handleNode.getAttribute('data-anchor');
            const source = byId[sourceId];
            const from = Core.anchorPoint(source, anchor, world[0], world[1], byId);
            const el = Object.assign({
              id: uid(), kind: 'arrow',
              points: [[Core.round(from[0]), Core.round(from[1])], [Core.round(world[0]), Core.round(world[1])]],
              bindStart: { id: sourceId, anchor },
              bindEnd: null,
              headEnd: 'arrow'
            }, styleFor('arrow'));
            el.fill = 'transparent';
            addElement(el, { commit: false });
            selection = new Set([el.id]);
            beginGesture('arrowDraw', { el, fresh: true });
            return;
          }
          const endpoint = handleNode.getAttribute('data-endpoint');
          if (endpoint) {
            const el = selectedElements()[0];
            beginGesture('arrowEndpoint', { el, endpoint });
            return;
          }
          const box = selectionBox();
          beginGesture('resize', {
            handle: handleNode.getAttribute('data-handle'),
            startWorld: world,
            box,
            originals: selectedElements().map((el) => JSON.parse(JSON.stringify(el)))
          });
          return;
        }

        const hit = elementAt(world);
        if (hit) {
          if (evt.shiftKey) {
            if (selection.has(hit.id)) selection.delete(hit.id);
            else selection.add(hit.id);
          } else if (!selection.has(hit.id)) {
            selection = new Set([hit.id]);
          }
          emitSelection();
          beginGesture('move', {
            startWorld: world,
            originals: selectedElements().map((el) => ({ id: el.id, snapshot: JSON.parse(JSON.stringify(el)) }))
          });
          drawOverlay();
          return;
        }

        if (!evt.shiftKey) { selection = new Set(); emitSelection(); }
        marquee = [screen[0], screen[1], screen[0], screen[1]];
        beginGesture('marquee', { start: screen, base: new Set(selection) });
        drawOverlay();
        return;
      }

      if (tool === 'eraser') {
        beginGesture('erase', {});
        eraseAt(world);
        return;
      }

      if (tool === 'draw') {
        const el = Object.assign({
          id: uid(), kind: 'draw', points: [[Core.round(world[0]), Core.round(world[1])]]
        }, styleFor('draw'));
        el.fill = 'transparent';
        addElement(el, { commit: false });
        beginGesture('freehand', { el, raw: [[world[0], world[1]]] });
        return;
      }

      if (tool === 'arrow' || tool === 'line') {
        const target = bindTargetAt(world, null);
        const el = Object.assign({
          id: uid(), kind: tool,
          points: [[Core.round(world[0]), Core.round(world[1])], [Core.round(world[0]), Core.round(world[1])]],
          bindStart: target ? { id: target.id, anchor: 'auto' } : null,
          bindEnd: null,
          headEnd: tool === 'arrow' ? 'arrow' : 'none',
          headStart: 'none'
        }, styleFor(tool));
        el.fill = 'transparent';
        addElement(el, { commit: false });
        beginGesture('arrowDraw', { el, fresh: true });
        return;
      }

      if (tool === 'text') {
        const el = Object.assign({
          id: uid(), kind: 'text',
          x: Core.round(world[0]), y: Core.round(world[1]),
          w: 240, h: (style.fontSize || 18) * 1.4, text: '', textAlign: 'left'
        }, styleFor('text'));
        el.fill = 'transparent';
        addElement(el, { commit: false });
        selection = new Set([el.id]);
        setTool('select');
        openTextEditor(el);
        return;
      }

      // Shape tools
      if (Core.SHAPE_KINDS.includes(tool)) {
        const el = Object.assign({
          id: uid(), kind: tool,
          x: Core.round(world[0]), y: Core.round(world[1]), w: 0, h: 0,
          text: tool === 'umlClass' ? 'ClassName\n--\n+ field\n--\n+ method()' : ''
        }, styleFor(tool));
        addElement(el, { commit: false });
        beginGesture('shapeDraw', { el, startWorld: world });
        return;
      }
    });

    svgEl.addEventListener('pointermove', (evt) => {
      const screen = screenPoint(evt);
      const world = toWorld(screen);
      lastWorld = world;

      if (!gesture) {
        if (tool === 'select') {
          const hit = elementAt(world);
          const nextHover = hit ? hit.id : null;
          if (nextHover !== hoverId) { hoverId = nextHover; drawOverlay(); }
        } else if (hoverId) { hoverId = null; drawOverlay(); }
        if (broadcast) broadcast({ x: world[0], y: world[1] });
        return;
      }

      gesture.moved = true;

      switch (gesture.kind) {
        case 'pan': {
          view.tx = gesture.origin.tx + (screen[0] - gesture.start[0]);
          view.ty = gesture.origin.ty + (screen[1] - gesture.start[1]);
          applyTransform();
          drawOverlay();
          break;
        }
        case 'move': {
          let dx = world[0] - gesture.startWorld[0];
          let dy = world[1] - gesture.startWorld[1];
          if (evt.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
          const ids = new Set(gesture.originals.map((o) => o.id));
          if (!evt.altKey) [dx, dy] = computeSnap(ids, dx, dy);
          for (const { id, snapshot } of gesture.originals) {
            const el = byId[id];
            if (!el) continue;
            translateElement(el, snapshot, dx, dy);
          }
          patch([...ids]);
          break;
        }
        case 'resize': {
          resizeSelection(gesture, world, evt.shiftKey);
          patch(gesture.originals.map((o) => o.id));
          break;
        }
        case 'marquee': {
          marquee = [gesture.start[0], gesture.start[1], screen[0], screen[1]];
          const a = toWorld([Math.min(marquee[0], marquee[2]), Math.min(marquee[1], marquee[3])]);
          const b = toWorld([Math.max(marquee[0], marquee[2]), Math.max(marquee[1], marquee[3])]);
          const next = new Set(gesture.base);
          for (const el of block.elements) {
            const box = Core.bbox(el, byId);
            if (box.x + box.w >= a[0] && box.x <= b[0] && box.y + box.h >= a[1] && box.y <= b[1]) next.add(el.id);
          }
          selection = next;
          drawOverlay();
          emitSelection();
          break;
        }
        case 'shapeDraw': {
          const el = gesture.el;
          let w = world[0] - gesture.startWorld[0];
          let h = world[1] - gesture.startWorld[1];
          if (evt.shiftKey) {
            const size = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * size;
            h = Math.sign(h || 1) * size;
          }
          el.w = Core.round(w);
          el.h = Core.round(h);
          patch([el.id]);
          break;
        }
        case 'freehand': {
          const el = gesture.el;
          const events = evt.getCoalescedEvents ? evt.getCoalescedEvents() : [];
          const samples = events.length ? events.map((e) => toWorld(screenPoint(e))) : [world];
          for (const point of samples) gesture.raw.push(point);
          el.points = Core.simplify(gesture.raw, 0.7 / view.z);
          patch([el.id]);
          break;
        }
        case 'arrowDraw': {
          const el = gesture.el;
          el.points[el.points.length - 1] = [Core.round(world[0]), Core.round(world[1])];
          const target = bindTargetAt(world, el.id);
          highlightId = target ? target.id : null;
          el.bindEnd = target ? { id: target.id, anchor: 'auto' } : null;
          patch([el.id]);
          break;
        }
        case 'arrowEndpoint': {
          const el = gesture.el;
          const index = gesture.endpoint === 'start' ? 0 : el.points.length - 1;
          el.points[index] = [Core.round(world[0]), Core.round(world[1])];
          const target = bindTargetAt(world, el.id);
          highlightId = target ? target.id : null;
          const binding = target ? { id: target.id, anchor: 'auto' } : null;
          if (gesture.endpoint === 'start') el.bindStart = binding;
          else el.bindEnd = binding;
          patch([el.id]);
          break;
        }
        case 'erase': {
          eraseAt(world);
          break;
        }
      }

      // Let the other person watch the stroke as it happens, not 800ms later.
      if (broadcast) {
        broadcast({
          x: world[0],
          y: world[1],
          draft: gesture.el ? JSON.parse(JSON.stringify(gesture.el)) : null
        });
      }
    });

    svgEl.addEventListener('pointerup', (evt) => {
      if (!gesture) return;
      const current = gesture;
      const screen = screenPoint(evt);
      const world = toWorld(screen);

      if (current.kind === 'pan') {
        saveView();
        endGesture();
        drawOverlay();
        return;
      }

      if (current.kind === 'shapeDraw') {
        const el = current.el;
        if (Math.abs(el.w) < 6 && Math.abs(el.h) < 6) {
          // A click, not a drag: give the shape a sensible default size.
          const w = el.kind === 'umlClass' ? 200 : 160;
          const h = el.kind === 'umlClass' ? 120 : 100;
          el.x = Core.round(el.x - w / 2);
          el.y = Core.round(el.y - h / 2);
          el.w = w;
          el.h = h;
        } else {
          const r = Core.normRect(el);
          el.x = Core.round(r.x); el.y = Core.round(r.y);
          el.w = Core.round(r.w); el.h = Core.round(r.h);
        }
        selection = new Set([el.id]);
        setTool('select');
        render();
        commit();
        emitSelection();
        endGesture();
        return;
      }

      if (current.kind === 'freehand') {
        const el = current.el;
        el.points = Core.simplify(current.raw, 0.8 / view.z);
        if (el.points.length < 2) {
          block.elements = block.elements.filter((x) => x.id !== el.id);
          render();
        } else {
          render();
          commit();
        }
        endGesture();
        return;
      }

      if (current.kind === 'arrowDraw' || current.kind === 'arrowEndpoint') {
        const el = current.el;
        const { a, b } = Core.resolveArrow(el, byId);
        if (current.kind === 'arrowDraw' && Math.hypot(b[0] - a[0], b[1] - a[1]) < 8 && !el.bindEnd) {
          block.elements = block.elements.filter((x) => x.id !== el.id);
          selection = new Set();
          render();
          emitSelection();
        } else {
          if (current.kind === 'arrowDraw') { selection = new Set([el.id]); setTool('select'); }
          render();
          commit();
          emitSelection();
        }
        endGesture();
        return;
      }

      if (current.kind === 'move' || current.kind === 'resize') {
        // Round off the drag so the JSON stays tidy.
        for (const el of selectedElements()) {
          if (el.x !== undefined) { el.x = Core.round(el.x); el.y = Core.round(el.y); }
          if (el.w !== undefined) { el.w = Core.round(el.w); el.h = Core.round(el.h); }
        }
        if (current.moved) { render(); commit(); }
        endGesture();
        drawOverlay();
        return;
      }

      if (current.kind === 'erase') {
        commit();
        endGesture();
        return;
      }

      endGesture();
      drawOverlay();
    });

    svgEl.addEventListener('pointercancel', () => { if (gesture) { endGesture(); render(); } });

    svgEl.addEventListener('dblclick', (evt) => {
      rectCache = null;
      const world = toWorld(screenPoint(evt));
      const hit = elementAt(world);
      if (hit) {
        if (hit.kind === 'draw') return;
        selection = new Set([hit.id]);
        emitSelection();
        openTextEditor(hit);
        return;
      }
      const el = Object.assign({
        id: uid(), kind: 'text',
        x: Core.round(world[0]), y: Core.round(world[1]),
        w: 240, h: (style.fontSize || 18) * 1.4, text: '', textAlign: 'left'
      }, styleFor('text'));
      el.fill = 'transparent';
      addElement(el, { commit: false });
      selection = new Set([el.id]);
      openTextEditor(el);
    });

    svgEl.addEventListener('wheel', (evt) => {
      evt.preventDefault();
      rectCache = null;
      const screen = screenPoint(evt);
      if (evt.ctrlKey || evt.metaKey) {
        zoomAt(screen, Math.pow(0.998, evt.deltaY * 2));
      } else if (evt.shiftKey) {
        view.tx -= evt.deltaY;
        applyTransform();
        drawOverlay();
        saveView();
      } else {
        view.tx -= evt.deltaX;
        view.ty -= evt.deltaY;
        applyTransform();
        drawOverlay();
        saveView();
      }
    }, { passive: false });

    function zoomAt(screen, factor) {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.z * factor));
      const world = toWorld(screen);
      view.z = next;
      view.tx = screen[0] - world[0] * next;
      view.ty = screen[1] - world[1] * next;
      applyTransform();
      drawOverlay();
      saveView();
      if (onChange) onChange();
    }

    // ---------- element transforms ----------

    function translateElement(el, snapshot, dx, dy) {
      if (el.kind === 'draw') {
        el.points = snapshot.points.map(([x, y]) => [Core.round(x + dx), Core.round(y + dy)]);
      } else if (el.kind === 'arrow' || el.kind === 'line') {
        el.points = snapshot.points.map(([x, y]) => [Core.round(x + dx), Core.round(y + dy)]);
      } else {
        el.x = snapshot.x + dx;
        el.y = snapshot.y + dy;
      }
    }

    function resizeSelection(state, world, keepRatio) {
      const box = state.box;
      if (!box) return;
      const handle = state.handle;
      let left = box.x;
      let top = box.y;
      let right = box.x + box.w;
      let bottom = box.y + box.h;

      if (handle.includes('w')) left = world[0];
      if (handle.includes('e')) right = world[0];
      if (handle.includes('n')) top = world[1];
      if (handle.includes('s')) bottom = world[1];

      let newW = Math.max(8, right - left);
      let newH = Math.max(8, bottom - top);
      if (keepRatio && box.w > 0 && box.h > 0) {
        const ratio = box.w / box.h;
        if (newW / newH > ratio) newW = newH * ratio;
        else newH = newW / ratio;
        if (handle.includes('w')) left = right - newW;
        if (handle.includes('n')) top = bottom - newH;
      }
      const sx = box.w ? newW / box.w : 1;
      const sy = box.h ? newH / box.h : 1;
      const originX = handle.includes('w') ? right : left;
      const originY = handle.includes('n') ? bottom : top;

      const mapX = (x) => handle.includes('w') ? originX - (originX - x) * sx : originX + (x - originX) * sx;
      const mapY = (y) => handle.includes('n') ? originY - (originY - y) * sy : originY + (y - originY) * sy;

      for (const snapshot of state.originals) {
        const el = byId[snapshot.id];
        if (!el) continue;
        if (el.kind === 'draw' || el.kind === 'arrow' || el.kind === 'line') {
          el.points = snapshot.points.map(([x, y]) => [Core.round(mapX(x)), Core.round(mapY(y))]);
        } else {
          const x2 = mapX(snapshot.x + snapshot.w);
          const y2 = mapY(snapshot.y + snapshot.h);
          el.x = mapX(snapshot.x);
          el.y = mapY(snapshot.y);
          el.w = Math.max(8, x2 - el.x);
          el.h = Math.max(8, y2 - el.y);
        }
      }
    }

    function eraseAt(world) {
      const hit = elementAt(world);
      if (!hit) return;
      block.elements = block.elements.filter((el) => el.id !== hit.id);
      selection.delete(hit.id);
      render();
      emitSelection();
    }

    // ---------- commands ----------

    function setTool(next) {
      tool = next;
      root.dataset.tool = next;
      root.classList.toggle('drawing-tool', next !== 'select' && next !== 'pan');
      hoverId = null;
      drawOverlay();
      if (onToolChange) onToolChange(next);
    }
    surface.setTool = setTool;

    surface.setStyle = function (patchStyle) {
      Object.assign(style, patchStyle);
      const els = selectedElements();
      if (els.length) {
        for (const el of els) {
          for (const key in patchStyle) {
            if (key === 'fill' && el.kind === 'frame') continue;
            el[key] = patchStyle[key];
          }
          if (el.kind === 'text' && patchStyle.fontSize) {
            el.h = Core.textHeight(el, block.sketch ? Core.SKETCH_FONT : Core.CRISP_FONT);
          }
        }
        render();
        commit();
      }
      if (onChange) onChange();
    };

    surface.setHeads = function (patchHeads) {
      const els = selectedElements().filter((el) => el.kind === 'arrow' || el.kind === 'line');
      if (!els.length) return;
      for (const el of els) Object.assign(el, patchHeads);
      render();
      commit();
    };

    surface.deleteSelection = function () {
      if (!selection.size) return;
      const doomed = new Set(selection);
      block.elements = block.elements.filter((el) => !doomed.has(el.id));
      // Drop bindings that pointed at deleted elements.
      for (const el of block.elements) {
        if (el.bindStart && doomed.has(el.bindStart.id)) el.bindStart = null;
        if (el.bindEnd && doomed.has(el.bindEnd.id)) el.bindEnd = null;
      }
      selection = new Set();
      render();
      commit();
      emitSelection();
    };

    surface.selectAll = function () {
      selection = new Set(block.elements.map((el) => el.id));
      drawOverlay();
      emitSelection();
    };

    function cloneSelection(offset) {
      const els = selectedElements();
      if (!els.length) return [];
      const idMap = new Map();
      const copies = els.map((el) => {
        const copy = JSON.parse(JSON.stringify(el));
        copy.id = uid();
        idMap.set(el.id, copy.id);
        return copy;
      });
      for (const copy of copies) {
        if (copy.bindStart) copy.bindStart = idMap.has(copy.bindStart.id) ? { id: idMap.get(copy.bindStart.id), anchor: copy.bindStart.anchor } : null;
        if (copy.bindEnd) copy.bindEnd = idMap.has(copy.bindEnd.id) ? { id: idMap.get(copy.bindEnd.id), anchor: copy.bindEnd.anchor } : null;
        if (copy.kind === 'draw' || copy.kind === 'arrow' || copy.kind === 'line') {
          copy.points = copy.points.map(([x, y]) => [Core.round(x + offset), Core.round(y + offset)]);
        } else {
          copy.x = Core.round(copy.x + offset);
          copy.y = Core.round(copy.y + offset);
        }
      }
      return copies;
    }

    surface.duplicate = function () {
      const copies = cloneSelection(16);
      if (!copies.length) return;
      block.elements.push(...copies);
      selection = new Set(copies.map((c) => c.id));
      render();
      commit();
      emitSelection();
    };

    surface.copy = function () {
      const els = selectedElements();
      if (els.length) clipboard = JSON.stringify(els);
    };

    surface.paste = function () {
      if (!clipboard) return;
      let parsed;
      try { parsed = JSON.parse(clipboard); } catch (err) { return; }
      const idMap = new Map();
      const copies = parsed.map((el) => {
        const copy = JSON.parse(JSON.stringify(el));
        copy.id = uid();
        idMap.set(el.id, copy.id);
        return copy;
      });
      for (const copy of copies) {
        if (copy.bindStart) copy.bindStart = idMap.has(copy.bindStart.id) ? { id: idMap.get(copy.bindStart.id), anchor: copy.bindStart.anchor } : null;
        if (copy.bindEnd) copy.bindEnd = idMap.has(copy.bindEnd.id) ? { id: idMap.get(copy.bindEnd.id), anchor: copy.bindEnd.anchor } : null;
        if (copy.kind === 'draw' || copy.kind === 'arrow' || copy.kind === 'line') {
          copy.points = copy.points.map(([x, y]) => [Core.round(x + 20), Core.round(y + 20)]);
        } else {
          copy.x = Core.round(copy.x + 20);
          copy.y = Core.round(copy.y + 20);
        }
      }
      block.elements.push(...copies);
      selection = new Set(copies.map((c) => c.id));
      render();
      commit();
      emitSelection();
    };

    surface.zOrder = function (direction) {
      const chosen = block.elements.filter((el) => selection.has(el.id));
      if (!chosen.length) return;
      const rest = block.elements.filter((el) => !selection.has(el.id));
      block.elements = direction === 'front' ? [...rest, ...chosen] : [...chosen, ...rest];
      render();
      commit();
    };

    surface.setSketch = function (value) {
      block.sketch = !!value;
      render();
      commit();
      if (onChange) onChange();
    };

    surface.setBackground = function (value) {
      block.bg = value;
      applyTransform();
      commit();
      if (onChange) onChange();
    };

    surface.zoomBy = function (factor) {
      const r = svgRect();
      zoomAt([r.width / 2, r.height / 2], factor);
    };

    surface.resetZoom = function () {
      const r = svgRect();
      zoomAt([r.width / 2, r.height / 2], 1 / view.z);
    };

    surface.fit = function () {
      const box = Core.bboxOfAll(block.elements, byId);
      const r = svgRect();
      if (!box || !r.width) return;
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(
        (r.width - 80) / Math.max(box.w, 1),
        (r.height - 80) / Math.max(box.h, 1)
      )));
      view.z = z;
      view.tx = r.width / 2 - (box.x + box.w / 2) * z;
      view.ty = r.height / 2 - (box.y + box.h / 2) * z;
      applyTransform();
      drawOverlay();
      saveView();
      if (onChange) onChange();
    };

    surface.getZoom = () => view.z;

    surface.resize = function () {
      rectCache = null;
      applyTransform();
      drawOverlay();
    };

    surface.isBusy = () => !!gesture || !!textEditor;

    // Re-resolve the block from state (used after a remote update replaced it).
    surface.reload = function () {
      if (!page || !App.state) return;
      const fresh = App.state.pages[page.id];
      if (!fresh) return;
      surface.page = fresh;
      const next = (fresh.blocks || []).find((b) => b && b.id === block.id);
      if (!next) return;
      block = Core.normalize(next);
      selection = new Set([...selection].filter((id) => block.elements.some((el) => el.id === id)));
      render();
      emitSelection();
      if (onChange) onChange();
    };

    surface.setRemoteCursors = function (list) {
      remoteCursors = list || [];
      drawOverlay();
    };

    // Elements the other person is drawing right now: shown as ghosts, never
    // written into the document.
    surface.setRemoteDrafts = function (drafts) {
      ghosts.textContent = '';
      for (const draft of drafts || []) {
        if (!draft || !draft.kind) continue;
        const node = Core.renderElement(draft, block, byId);
        node.setAttribute('opacity', 0.5);
        node.querySelectorAll('.hit').forEach((n) => n.remove());
        ghosts.appendChild(node);
      }
    };

    surface.onChange = (cb) => { onChange = cb; };
    surface.onSelectionChange = (cb) => { onSelection = cb; };
    surface.onToolChange = (cb) => { onToolChange = cb; };
    surface.setBroadcast = (fn) => { broadcast = fn; };

    function emitSelection() {
      if (onSelection) onSelection(selectedElements());
    }

    // ---------- import / export ----------

    surface.importSVG = function (name, markup) {
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
      const root2 = doc.documentElement;
      if (!root2 || root2.nodeName.toLowerCase() !== 'svg') return null;
      // Strip anything scriptable before it ever reaches the page.
      root2.querySelectorAll('script, foreignObject, image, use, a').forEach((n) => n.remove());
      root2.querySelectorAll('*').forEach((node) => {
        for (const attr of [...node.attributes]) {
          if (/^on/i.test(attr.name) || /javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
        }
      });
      let viewBox = root2.getAttribute('viewBox');
      if (!viewBox) {
        const w = parseFloat(root2.getAttribute('width')) || 24;
        const h = parseFloat(root2.getAttribute('height')) || 24;
        viewBox = `0 0 ${w} ${h}`;
      }
      const assetId = uid().slice(0, 8);
      block.assets[assetId] = { name: name || 'Imported', viewBox, body: root2.innerHTML };
      commit();
      return 'custom:' + assetId;
    };

    surface.exportSVG = function () {
      const markup = Core.exportSVGString(block, { background: '#faf6ee' });
      download(new Blob([markup], { type: 'image/svg+xml' }), fileName('svg'));
    };

    surface.exportPNG = function () {
      const markup = Core.exportSVGString(block, { background: '#faf6ee' });
      const byIdLocal = Core.indexById(block.elements);
      const box = Core.bboxOfAll(block.elements, byIdLocal) || { w: 400, h: 300 };
      const scale = 2;
      const width = Math.max(1, Math.round((box.w + 48) * scale));
      const height = Math.max(1, Math.round((box.h + 48) * scale));
      const image = new Image();
      image.onload = function () {
        const canvasEl = document.createElement('canvas');
        canvasEl.width = width;
        canvasEl.height = height;
        const ctx = canvasEl.getContext('2d');
        ctx.fillStyle = '#faf6ee';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        canvasEl.toBlob((blob) => { if (blob) download(blob, fileName('png')); });
      };
      image.onerror = function () { window.alert('PNG export failed; the SVG download should still work.'); };
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    };

    function fileName(ext) {
      const base = (surface.page && surface.page.title ? surface.page.title : 'canvas')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'canvas';
      return `${base}.${ext}`;
    }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // ---------- keyboard ----------

    function isActive() {
      if (textEditor) return false;
      return root.contains(document.activeElement) || document.activeElement === root;
    }

    function onKeyDown(evt) {
      if (evt.key === ' ' && isActive()) { spaceDown = true; root.classList.add('panning'); }
      if (!isActive()) return;

      const meta = evt.metaKey || evt.ctrlKey;
      const key = evt.key.toLowerCase();

      if (meta && key === 'z') {
        evt.preventDefault();
        evt.stopPropagation();
        if (evt.shiftKey) surface.redo(); else surface.undo();
        return;
      }
      if (meta && key === 'a') { evt.preventDefault(); evt.stopPropagation(); surface.selectAll(); return; }
      if (meta && key === 'c') { surface.copy(); return; }
      if (meta && key === 'v') { evt.preventDefault(); surface.paste(); return; }
      if (meta && key === 'd') { evt.preventDefault(); evt.stopPropagation(); surface.duplicate(); return; }
      if (meta && (key === ']' || key === '[')) {
        evt.preventDefault();
        surface.zOrder(key === ']' ? 'front' : 'back');
        return;
      }
      if (meta) return;

      if (evt.key === 'Backspace' || evt.key === 'Delete') {
        if (selection.size) { evt.preventDefault(); evt.stopPropagation(); surface.deleteSelection(); }
        return;
      }
      if (evt.key === 'Escape') {
        // Escape first cancels: drop the selection, or step back to the select
        // tool. Only when there is nothing left to cancel does it bubble on (the
        // drawer uses that to close), so deselecting never shuts the drawer.
        const hadSomethingToCancel = selection.size > 0 || tool !== 'select';
        if (hadSomethingToCancel) {
          evt.stopPropagation();
          evt.__canvasHandled = true;
          selection = new Set();
          setTool('select');
          emitSelection();
          drawOverlay();
        }
        return;
      }
      if (evt.key === 'Enter' && selection.size === 1) {
        const el = selectedElements()[0];
        if (el && el.kind !== 'draw') { evt.preventDefault(); evt.stopPropagation(); openTextEditor(el); }
        return;
      }
      if (evt.key.startsWith('Arrow') && selection.size) {
        evt.preventDefault();
        evt.stopPropagation();
        const step = evt.shiftKey ? 10 : 1;
        const dx = evt.key === 'ArrowLeft' ? -step : evt.key === 'ArrowRight' ? step : 0;
        const dy = evt.key === 'ArrowUp' ? -step : evt.key === 'ArrowDown' ? step : 0;
        for (const el of selectedElements()) translateElement(el, JSON.parse(JSON.stringify(el)), dx, dy);
        render();
        commit();
        return;
      }

      const TOOL_KEYS = {
        v: 'select', h: 'pan', r: 'rect', o: 'ellipse', d: 'diamond', g: 'triangle',
        a: 'arrow', l: 'line', p: 'draw', t: 'text', s: 'sticky', f: 'frame', e: 'eraser', c: 'cylinder'
      };
      if (TOOL_KEYS[key]) {
        evt.stopPropagation();
        setTool(TOOL_KEYS[key]);
      }
    }

    function onKeyUp(evt) {
      if (evt.key === ' ') { spaceDown = false; root.classList.remove('panning'); }
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    const resizeObserver = new ResizeObserver(() => surface.resize());
    resizeObserver.observe(root);

    surface.destroy = function () {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      resizeObserver.disconnect();
      const index = surfaces.indexOf(surface);
      if (index >= 0) surfaces.splice(index, 1);
      root.remove();
    };

    setTool('select');
    render();

    // Re-wrap once the hand-drawn font is actually available.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!document.contains(root)) return;
        Core.clearWrapCache();
        render();
      });
    }

    surfaces.push(surface);
    return surface;
  };
})();

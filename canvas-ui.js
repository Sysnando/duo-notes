/* Duo Notes — canvas chrome: toolbar, style popover, icon picker, full-screen
 * drawer, and live cursors over a Supabase broadcast channel. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const UI = (App.CanvasUI = {});
  const Core = App.CanvasCore;

  const SHAPE_GLYPHS = {
    cylinder: 'M3 6 A7 3 0 0 1 17 6 L17 14 A7 3 0 0 1 3 14 Z',
    sticky: 'M3 3 H17 V13 L13 17 H3 Z',
    frame: 'M3 6 H17 M3 6 V17 H17 V6 M6 3 V6 M14 3 V6',
    umlClass: 'M3 4 H17 V16 H3 Z M3 8 H17 M3 12 H17'
  };

  const TOOLS = [
    { id: 'select', label: '↖', title: 'Select (V)' },
    { id: 'pan', label: '✋', title: 'Pan (H) — or hold Space' },
    { id: 'draw', label: '✎', title: 'Pencil (P)', compact: true },
    { id: 'eraser', label: '⌫', title: 'Eraser (E)' },
    { id: 'sep' },
    { id: 'rect', label: '▢', title: 'Rectangle (R)', compact: true },
    { id: 'ellipse', label: '○', title: 'Ellipse (O)', compact: true },
    { id: 'diamond', label: '◇', title: 'Diamond (D)' },
    { id: 'triangle', label: '△', title: 'Triangle (G)' },
    { id: 'cylinder', shape: 'cylinder', title: 'Cylinder / database (C)' },
    { id: 'sep' },
    { id: 'arrow', label: '↗', title: 'Arrow (A)', compact: true },
    { id: 'line', label: '╱', title: 'Line (L)' },
    { id: 'sep' },
    { id: 'text', label: 'T', title: 'Text (T)', compact: true },
    { id: 'sticky', shape: 'sticky', title: 'Sticky note (S)' },
    { id: 'frame', shape: 'frame', title: 'Frame (F)' },
    { id: 'umlClass', shape: 'umlClass', title: 'UML class box' }
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function shapeGlyph(name) {
    const svg = Core.svg('svg', { viewBox: '0 0 20 20', width: 16, height: 16 });
    svg.appendChild(Core.svg('path', {
      d: SHAPE_GLYPHS[name], fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));
    return svg;
  }

  // ---------- popovers ----------

  let openPopover = null;

  function closePopover() {
    if (openPopover) { openPopover.remove(); openPopover = null; }
  }

  function popover(anchor, build, options) {
    const wasOpen = openPopover && openPopover.dataset.owner === (options && options.key);
    closePopover();
    if (wasOpen) return null;

    const node = el('div', 'cv-popover');
    if (options && options.key) node.dataset.owner = options.key;
    if (options && options.wide) node.classList.add('wide');
    build(node);
    document.body.appendChild(node);

    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    node.style.top = `${rect.bottom + 6}px`;
    openPopover = node;

    setTimeout(() => {
      document.addEventListener('mousedown', function onDoc(e) {
        if (!node.contains(e.target) && e.target !== anchor) {
          closePopover();
          document.removeEventListener('mousedown', onDoc);
        }
      });
    }, 0);
    return node;
  }

  // ---------- chrome ----------

  UI.mountChrome = function (surface, wrap, options) {
    const compact = !!(options && options.compact);
    const bar = el('div', 'cv-toolbar' + (compact ? ' compact' : ''));
    wrap.insertBefore(bar, wrap.firstChild);

    const toolButtons = new Map();

    // --- tools ---
    const toolGroup = el('div', 'cv-group');
    for (const tool of TOOLS) {
      if (tool.id === 'sep') {
        const sep = el('span', 'cv-sep');
        if (compact) sep.classList.add('full-only');
        toolGroup.appendChild(sep);
        continue;
      }
      const button = el('button', 'cv-tool');
      if (compact && !tool.compact) button.classList.add('full-only');
      button.title = tool.title;
      if (tool.shape) button.appendChild(shapeGlyph(tool.shape));
      else button.textContent = tool.label;
      button.addEventListener('click', () => surface.setTool(tool.id));
      toolButtons.set(tool.id, button);
      toolGroup.appendChild(button);
    }

    const iconsButton = el('button', 'cv-tool', '✦');
    iconsButton.title = 'Insert an icon (AWS, UML, infrastructure)';
    iconsButton.addEventListener('click', () => openIconPicker(iconsButton, surface));
    toolGroup.appendChild(iconsButton);
    bar.appendChild(toolGroup);

    // --- style + edit actions ---
    const editGroup = el('div', 'cv-group' + (compact ? ' full-only' : ''));

    const styleButton = el('button', 'cv-btn', 'Style');
    styleButton.title = 'Colours, thickness, text size';
    styleButton.addEventListener('click', () => openStylePopover(styleButton, surface));
    editGroup.appendChild(styleButton);

    const headsButton = el('button', 'cv-btn', 'Ends');
    headsButton.title = 'Arrowheads (UML inheritance, composition, aggregation)';
    headsButton.disabled = true;
    headsButton.addEventListener('click', () => openHeadsPopover(headsButton, surface));
    editGroup.appendChild(headsButton);

    const undoButton = iconButton('↶', 'Undo (⌘Z)', () => surface.undo());
    const redoButton = iconButton('↷', 'Redo (⇧⌘Z)', () => surface.redo());
    const dupButton = iconButton('⧉', 'Duplicate (⌘D)', () => surface.duplicate());
    const frontButton = iconButton('⬆', 'Bring to front (⌘])', () => surface.zOrder('front'));
    const backButton = iconButton('⬇', 'Send to back (⌘[)', () => surface.zOrder('back'));
    const deleteButton = iconButton('✕', 'Delete (⌫)', () => surface.deleteSelection());
    deleteButton.classList.add('danger');
    editGroup.append(undoButton, redoButton, dupButton, frontButton, backButton, deleteButton);
    bar.appendChild(editGroup);

    // --- view ---
    const viewGroup = el('div', 'cv-group');
    const zoomOut = iconButton('−', 'Zoom out', () => surface.zoomBy(1 / 1.2));
    const zoomLabel = el('button', 'cv-zoom', '100%');
    zoomLabel.title = 'Reset zoom to 100%';
    zoomLabel.addEventListener('click', () => surface.resetZoom());
    const zoomIn = iconButton('+', 'Zoom in', () => surface.zoomBy(1.2));
    const fitButton = el('button', 'cv-btn', 'Fit');
    fitButton.title = 'Fit the drawing to the view';
    fitButton.addEventListener('click', () => surface.fit());
    viewGroup.append(zoomOut, zoomLabel, zoomIn, fitButton);
    if (compact) { zoomOut.classList.add('full-only'); zoomIn.classList.add('full-only'); }
    bar.appendChild(viewGroup);

    // --- canvas options ---
    const optionGroup = el('div', 'cv-group' + (compact ? ' full-only' : ''));
    const sketchButton = el('button', 'cv-btn');
    sketchButton.addEventListener('click', () => {
      surface.setSketch(!surface.block.sketch);
      refresh();
    });
    const bgButton = el('button', 'cv-btn');
    bgButton.title = 'Background: grid, dots, or plain';
    bgButton.addEventListener('click', () => {
      const order = ['grid', 'dots', 'plain'];
      const next = order[(order.indexOf(surface.block.bg) + 1) % order.length];
      surface.setBackground(next);
      refresh();
    });
    const exportButton = el('button', 'cv-btn', 'Export');
    exportButton.addEventListener('click', () => {
      popover(exportButton, (node) => {
        node.appendChild(menuItem('Download PNG', () => { closePopover(); surface.exportPNG(); }));
        node.appendChild(menuItem('Download SVG', () => { closePopover(); surface.exportSVG(); }));
      }, { key: 'export' });
    });
    optionGroup.append(sketchButton, bgButton, exportButton);
    bar.appendChild(optionGroup);

    // --- expand / close ---
    const endGroup = el('div', 'cv-group cv-end');
    if (surface.expanded) {
      const closeButton = el('button', 'cv-btn primary', '✕ Close');
      closeButton.addEventListener('click', () => UI.closeDrawer());
      endGroup.appendChild(closeButton);
    } else {
      const expandButton = el('button', 'cv-btn primary', '⤢ Expand');
      expandButton.title = 'Open full screen';
      expandButton.addEventListener('click', () => UI.openDrawer(surface.block, surface.page));
      endGroup.appendChild(expandButton);
    }
    bar.appendChild(endGroup);

    function iconButton(glyph, title, fn) {
      const button = el('button', 'cv-tool', glyph);
      button.title = title;
      button.addEventListener('click', fn);
      return button;
    }

    function menuItem(label, fn) {
      const button = el('button', 'cv-menu-item', label);
      button.addEventListener('click', fn);
      return button;
    }

    function refresh() {
      for (const [id, button] of toolButtons) button.classList.toggle('active', surface.tool === id);
      zoomLabel.textContent = Math.round(surface.getZoom() * 100) + '%';
      undoButton.disabled = !surface.canUndo();
      redoButton.disabled = !surface.canRedo();
      sketchButton.textContent = surface.block.sketch ? 'Sketchy' : 'Crisp';
      sketchButton.classList.toggle('active', surface.block.sketch);
      sketchButton.title = surface.block.sketch
        ? 'Hand-drawn lines — click for crisp geometry'
        : 'Crisp lines — click for the hand-drawn look';
      bgButton.textContent = surface.block.bg === 'grid' ? 'Grid' : surface.block.bg === 'dots' ? 'Dots' : 'Plain';
    }

    function refreshSelection(selected) {
      const has = selected.length > 0;
      dupButton.disabled = !has;
      deleteButton.disabled = !has;
      frontButton.disabled = !has;
      backButton.disabled = !has;
      headsButton.disabled = !selected.some((s) => s.kind === 'arrow' || s.kind === 'line');
    }

    surface.onChange(refresh);
    surface.onToolChange(refresh);
    surface.onSelectionChange(refreshSelection);
    refresh();
    refreshSelection([]);
    return { refresh };
  };

  // ---------- style popover ----------

  function swatchRow(node, label, colors, current, onPick) {
    const row = el('div', 'cv-row');
    row.appendChild(el('span', 'cv-row-label', label));
    const swatches = el('div', 'cv-swatches');
    for (const color of colors) {
      const button = el('button', 'cv-swatch' + (color === current ? ' active' : ''));
      if (color === 'transparent') {
        button.classList.add('transparent');
        button.title = 'No fill';
      } else {
        button.style.background = color;
      }
      button.addEventListener('click', () => onPick(color));
      swatches.appendChild(button);
    }
    row.appendChild(swatches);
    node.appendChild(row);
  }

  function openStylePopover(anchor, surface) {
    popover(anchor, (node) => {
      const style = surface.style;
      swatchRow(node, 'Stroke', Core.STROKES, style.stroke, (color) => {
        surface.setStyle({ stroke: color });
        openStylePopover(anchor, surface);
      });
      swatchRow(node, 'Fill', Core.FILLS.concat(Core.STICKY_FILLS), style.fill, (color) => {
        surface.setStyle({ fill: color });
        openStylePopover(anchor, surface);
      });

      const widthRow = el('div', 'cv-row');
      widthRow.appendChild(el('span', 'cv-row-label', 'Thickness'));
      const widths = el('div', 'cv-choices');
      for (const [value, name] of [[1, 'Thin'], [2, 'Medium'], [4, 'Bold']]) {
        const button = el('button', 'cv-choice' + (style.strokeWidth === value ? ' active' : ''), name);
        button.addEventListener('click', () => { surface.setStyle({ strokeWidth: value }); openStylePopover(anchor, surface); });
        widths.appendChild(button);
      }
      widthRow.appendChild(widths);
      node.appendChild(widthRow);

      const textRow = el('div', 'cv-row');
      textRow.appendChild(el('span', 'cv-row-label', 'Text size'));
      const sizes = el('div', 'cv-choices');
      for (const [value, name] of [[14, 'S'], [18, 'M'], [26, 'L'], [36, 'XL']]) {
        const button = el('button', 'cv-choice' + (style.fontSize === value ? ' active' : ''), name);
        button.addEventListener('click', () => { surface.setStyle({ fontSize: value }); openStylePopover(anchor, surface); });
        sizes.appendChild(button);
      }
      textRow.appendChild(sizes);
      node.appendChild(textRow);

      const toggleRow = el('div', 'cv-row');
      toggleRow.appendChild(el('span', 'cv-row-label', 'Dashed'));
      const dashToggle = el('button', 'cv-choice' + (style.dash ? ' active' : ''), style.dash ? 'On' : 'Off');
      dashToggle.addEventListener('click', () => { surface.setStyle({ dash: !style.dash }); openStylePopover(anchor, surface); });
      toggleRow.appendChild(dashToggle);
      node.appendChild(toggleRow);

      const opacityRow = el('div', 'cv-row');
      opacityRow.appendChild(el('span', 'cv-row-label', 'Opacity'));
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0.1';
      range.max = '1';
      range.step = '0.05';
      range.value = String(style.opacity === undefined ? 1 : style.opacity);
      range.addEventListener('input', () => surface.setStyle({ opacity: parseFloat(range.value) }));
      opacityRow.appendChild(range);
      node.appendChild(opacityRow);
    }, { key: 'style' });
  }

  function openHeadsPopover(anchor, surface) {
    popover(anchor, (node) => {
      const hint = el('p', 'cv-hint', 'UML: hollow triangle is inheritance, filled diamond composition, hollow diamond aggregation. Use a dashed stroke for dependency.');
      node.appendChild(hint);
      for (const [key, label] of [['headStart', 'Start'], ['headEnd', 'End']]) {
        const row = el('div', 'cv-row');
        row.appendChild(el('span', 'cv-row-label', label));
        const select = document.createElement('select');
        select.className = 'cv-select';
        for (const head of Core.HEADS) {
          const option = document.createElement('option');
          option.value = head.id;
          option.textContent = head.name;
          select.appendChild(option);
        }
        const selected = surface.selectionIds.length ? null : null;
        const first = surface.block.elements.find((x) => surface.selectionIds.includes(x.id) && (x.kind === 'arrow' || x.kind === 'line'));
        select.value = first ? (first[key] || (key === 'headEnd' && first.kind === 'arrow' ? 'arrow' : 'none')) : 'none';
        select.addEventListener('change', () => surface.setHeads({ [key]: select.value }));
        row.appendChild(select);
        node.appendChild(row);
      }
    }, { key: 'heads' });
  }

  // ---------- icon picker ----------

  function openIconPicker(anchor, surface) {
    popover(anchor, (node) => {
      node.classList.add('cv-icon-picker');

      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Search icons…';
      search.className = 'cv-search';
      node.appendChild(search);

      const tabs = el('div', 'cv-tabs');
      const grid = el('div', 'cv-icon-grid');
      let category = 'all';

      const categories = [{ id: 'all', name: 'All' }].concat(App.Icons ? App.Icons.CATEGORIES : []);
      for (const cat of categories) {
        const button = el('button', 'cv-tab' + (cat.id === category ? ' active' : ''), cat.name);
        button.addEventListener('click', () => {
          category = cat.id;
          tabs.querySelectorAll('.cv-tab').forEach((t) => t.classList.remove('active'));
          button.classList.add('active');
          draw();
        });
        tabs.appendChild(button);
      }
      node.append(tabs, grid);

      function draw() {
        grid.textContent = '';
        if (!App.Icons) {
          grid.appendChild(el('p', 'cv-hint', 'Icon library unavailable.'));
          return;
        }
        const matches = App.Icons.search(search.value)
          .filter((icon) => category === 'all' || icon.cat === category);
        if (!matches.length) {
          grid.appendChild(el('p', 'cv-hint', 'No icons match that search.'));
          return;
        }
        for (const icon of matches) {
          const cell = el('button', 'cv-icon-cell');
          cell.title = icon.name;
          const preview = Core.svg('svg', { viewBox: '0 0 24 24', width: 30, height: 30 });
          preview.appendChild(App.Icons.nodeFor(icon.id, '#2b2620'));
          cell.appendChild(preview);
          cell.appendChild(el('span', 'cv-icon-name', icon.name));
          cell.addEventListener('click', () => {
            closePopover();
            surface.insertIcon(icon.id, icon.name);
          });
          grid.appendChild(cell);
        }
      }

      search.addEventListener('input', draw);
      draw();

      const importButton = el('button', 'cv-btn wide-btn', '＋ Import an SVG…');
      importButton.addEventListener('click', () => {
        closePopover();
        openImportDialog(surface);
      });
      node.appendChild(importButton);
      setTimeout(() => search.focus(), 0);
    }, { key: 'icons', wide: true });
  }

  function openImportDialog(surface) {
    const backdrop = el('div', 'cv-modal-backdrop');
    const modal = el('div', 'cv-modal');
    modal.appendChild(el('h3', null, 'Import an SVG icon'));
    modal.appendChild(el('p', 'cv-hint', 'Paste the SVG markup — handy for official AWS or vendor icons. Scripts, images and links are stripped before it is stored.'));

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Name (e.g. Athena)';
    nameInput.className = 'cv-input';

    const area = document.createElement('textarea');
    area.className = 'cv-input cv-svg-input';
    area.placeholder = '<svg viewBox="0 0 24 24">…</svg>';
    area.rows = 8;

    const error = el('p', 'cv-error');
    error.hidden = true;

    const actions = el('div', 'cv-modal-actions');
    const cancel = el('button', 'cv-btn', 'Cancel');
    const confirm = el('button', 'cv-btn primary', 'Add icon');
    actions.append(cancel, confirm);
    modal.append(nameInput, area, error, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    setTimeout(() => nameInput.focus(), 0);

    const close = () => backdrop.remove();
    cancel.addEventListener('click', close);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    confirm.addEventListener('click', () => {
      const iconId = surface.importSVG(nameInput.value.trim(), area.value.trim());
      if (!iconId) {
        error.textContent = 'That does not look like valid SVG markup.';
        error.hidden = false;
        return;
      }
      close();
      surface.insertIcon(iconId, nameInput.value.trim());
    });
  }

  // ---------- full-screen drawer ----------

  let drawer = null;

  UI.openDrawer = function (block, page) {
    UI.closeDrawer();
    closePopover();

    const backdrop = el('div', 'cv-drawer');
    const head = el('div', 'cv-drawer-head');
    head.appendChild(el('span', 'cv-drawer-title', (page && page.title) || 'Untitled'));
    const hint = el('span', 'cv-drawer-hint', 'Space to pan · scroll to move · ⌘scroll to zoom · Esc to close');
    head.appendChild(hint);
    backdrop.appendChild(head);

    const body = el('div', 'cv-drawer-body');
    backdrop.appendChild(body);
    document.body.appendChild(backdrop);
    document.body.classList.add('cv-locked');

    const stage = el('div', 'cv-stage');
    body.appendChild(stage);
    const surface = App.Canvas.createSurface({ block, page, container: stage, expanded: true });
    UI.mountChrome(surface, body, { compact: false });
    body.insertBefore(body.querySelector('.cv-toolbar'), stage);

    const cursors = wireLiveCursors(surface, block);

    function onKey(e) {
      // The surface gets first refusal on Escape (deselect / cancel a tool);
      // it only reaches us when there was nothing left to cancel.
      if (e.key === 'Escape' && !e.__canvasHandled && !surface.isBusy()) {
        e.stopPropagation();
        UI.closeDrawer();
      }
    }
    document.addEventListener('keydown', onKey);

    drawer = {
      backdrop,
      surface,
      close() {
        document.removeEventListener('keydown', onKey);
        if (cursors) cursors.close();
        surface.destroy();
        backdrop.remove();
        document.body.classList.remove('cv-locked');
        drawer = null;
        if (App.render) App.render();
      }
    };

    requestAnimationFrame(() => {
      surface.resize();
      surface.root.focus({ preventScroll: true });
    });
    return surface;
  };

  UI.closeDrawer = function () {
    if (drawer) drawer.close();
  };

  UI.isDrawerOpen = () => !!drawer;

  // ---------- live cursors ----------

  const CURSOR_COLORS = ['#c05b3c', '#2f6f4f', '#2b5c8a', '#7a4fa3', '#a8891f'];

  function colorFor(clientId) {
    return CURSOR_COLORS[Core.hashSeed(String(clientId)) % CURSOR_COLORS.length];
  }

  function wireLiveCursors(surface, block) {
    if (!App.Sync || !App.Sync.canvasChannel) return null;
    const channel = App.Sync.canvasChannel(block.id, {
      onCursor(payload) {
        if (!payload || !payload.clientId) return;
        peers.set(payload.clientId, {
          x: payload.x,
          y: payload.y,
          name: payload.name,
          color: colorFor(payload.clientId),
          draft: payload.draft || null,
          at: performance.now()
        });
        flush();
      },
      onLeave(clientId) {
        peers.delete(clientId);
        flush();
      }
    });
    if (!channel) return null;

    const peers = new Map();
    let lastSent = 0;

    function flush() {
      const list = [];
      const drafts = [];
      for (const peer of peers.values()) {
        list.push(peer);
        if (peer.draft) drafts.push(peer.draft);
      }
      surface.setRemoteCursors(list);
      if (surface.setRemoteDrafts) surface.setRemoteDrafts(drafts);
    }

    surface.setBroadcast((payload) => {
      const now = performance.now();
      if (!payload.force && now - lastSent < 45) return;
      lastSent = now;
      channel.send(payload);
    });

    const prune = setInterval(() => {
      const now = performance.now();
      let changed = false;
      for (const [id, peer] of peers) {
        if (now - peer.at > 8000) { peers.delete(id); changed = true; }
      }
      if (changed) flush();
    }, 3000);

    return {
      close() {
        clearInterval(prune);
        channel.close();
        surface.setBroadcast(null);
      }
    };
  }

  UI.wireLiveCursors = wireLiveCursors;
})();

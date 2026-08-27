/* Duo Notes — state, persistence funnel, sidebar tree, routing, boot. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const STORAGE_KEY = 'duo-notes.cache.v1';
  // Which sidebar branches are folded shut. Deliberately per-person and outside
  // the synced document: one of us collapsing a branch shouldn't fold it for the
  // other, the same reasoning as the canvas camera.
  const TREE_KEY = 'duo-notes.tree.v1';

  const state = (App.state = {
    pages: {},          // id -> { id, parentId, title, blocks, sortOrder, updatedAt }
    currentPageId: null
  });

  App.uid = () => crypto.randomUUID();

  // ---------- blocks ----------

  App.makeBlock = function (type) {
    const id = App.uid();
    switch (type) {
      case 'heading1': return { id, type: 'heading', level: 1, text: '' };
      case 'heading2': return { id, type: 'heading', level: 2, text: '' };
      case 'heading3': return { id, type: 'heading', level: 3, text: '' };
      case 'bullet':   return { id, type: 'bullet', text: '' };
      case 'todo':     return { id, type: 'todo', text: '', checked: false };
      case 'divider':  return { id, type: 'divider' };
      case 'table':    return App.Table.makeBlock(id);
      case 'canvas':   return App.Canvas.makeBlock(id);
      default:         return { id, type: 'paragraph', text: '' };
    }
  };

  App.isTextBlock = (b) => b && ['paragraph', 'heading', 'bullet', 'todo'].includes(b.type);

  // ---------- pages ----------

  function siblingSortOrder(parentId) {
    let max = 0;
    for (const p of Object.values(state.pages)) {
      if ((p.parentId || null) === (parentId || null)) max = Math.max(max, p.sortOrder || 0);
    }
    return max + 1;
  }

  App.createPage = function (parentId) {
    const page = {
      id: App.uid(),
      parentId: parentId || null,
      title: '',
      blocks: [App.makeBlock('paragraph')],
      sortOrder: siblingSortOrder(parentId),
      updatedAt: new Date().toISOString()
    };
    state.pages[page.id] = page;
    App.persistAndRender(page.id);
    App.openPage(page.id);
    requestAnimationFrame(() => document.getElementById('page-title').focus());
    return page;
  };

  App.descendantIds = function (pageId) {
    const out = [];
    const walk = (id) => {
      for (const p of Object.values(state.pages)) {
        if (p.parentId === id) { out.push(p.id); walk(p.id); }
      }
    };
    walk(pageId);
    return out;
  };

  App.deletePage = function (pageId) {
    const page = state.pages[pageId];
    if (!page) return;
    const label = page.title || 'Untitled';
    const kids = App.descendantIds(pageId);
    const msg = kids.length
      ? `Delete “${label}” and its ${kids.length} sub-page${kids.length > 1 ? 's' : ''}?`
      : `Delete “${label}”?`;
    if (!confirm(msg)) return;
    const ids = [pageId, ...kids];
    for (const id of ids) {
      delete state.pages[id];
      collapsed.delete(id);
    }
    saveCollapsed();
    if (ids.includes(state.currentPageId)) App.openPage(firstPageId());
    App.saveLocal();
    App.Sync.pushDelete(ids);
    App.render();
  };

  function firstPageId() {
    const roots = childrenOf(null);
    return roots.length ? roots[0].id : null;
  }

  function childrenOf(parentId) {
    return Object.values(state.pages)
      .filter((p) => (p.parentId || null) === (parentId || null))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.title || '').localeCompare(b.title || ''));
  }
  App.childrenOf = childrenOf;

  const hasChildren = (pageId) => Object.values(state.pages).some((p) => p.parentId === pageId);

  // ---------- sidebar fold state ----------

  let collapsed = new Set();

  function loadCollapsed() {
    try {
      const saved = JSON.parse(localStorage.getItem(TREE_KEY) || 'null');
      if (Array.isArray(saved)) collapsed = new Set(saved);
    } catch (err) { /* start expanded */ }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem(TREE_KEY, JSON.stringify([...collapsed]));
    } catch (err) { /* quota */ }
  }

  App.isCollapsed = (pageId) => collapsed.has(pageId);

  App.toggleCollapse = function (pageId) {
    if (collapsed.has(pageId)) collapsed.delete(pageId);
    else collapsed.add(pageId);
    saveCollapsed();
    renderTree();
  };

  // Opening a page has to reveal it, so unfold every branch above it.
  function expandAncestors(pageId) {
    let page = state.pages[pageId];
    let changed = false;
    const guard = new Set();
    while (page && page.parentId && !guard.has(page.id)) {
      guard.add(page.id);
      if (collapsed.delete(page.parentId)) changed = true;
      page = state.pages[page.parentId];
    }
    if (changed) saveCollapsed();
  }
  App.expandAncestors = expandAncestors;

  App.openPage = function (pageId) {
    state.currentPageId = pageId && state.pages[pageId] ? pageId : null;
    if (state.currentPageId) expandAncestors(state.currentPageId);
    const hash = state.currentPageId ? '#' + state.currentPageId : '';
    if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname);
    App.saveLocal();
    App.Sync.reportPresence();
    App.render();
  };

  // ---------- persistence funnel ----------

  App.saveLocal = function () {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        pages: state.pages,
        lastOpenPageId: state.currentPageId,
        dirty: [...App.Sync.dirty]
      }));
    } catch (err) {
      console.warn('saveLocal failed', err);
    }
  };

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      state.pages = saved.pages || {};
      state.currentPageId = saved.lastOpenPageId || null;
      for (const id of saved.dirty || []) App.Sync.dirty.add(id);
    } catch (err) {
      console.warn('loadLocal failed', err);
    }
  }

  // Every local mutation funnels through here.
  // opts.rerender=false keeps the DOM untouched (used while typing in a block).
  App.persistAndRender = function (pageId, opts = {}) {
    const page = state.pages[pageId];
    if (page) {
      page.updatedAt = new Date().toISOString();
      App.Sync.schedulePush(pageId); // before saveLocal so the dirty set is persisted too
    }
    App.saveLocal();
    if (opts.rerender !== false) App.render();
  };

  // ---------- rendering ----------

  const el = (id) => document.getElementById(id);

  App.render = function () {
    renderTree();
    renderPage();
  };

  function renderTree() {
    const nav = el('page-tree');
    nav.textContent = '';
    const build = (parentId, depth) => {
      for (const page of childrenOf(parentId)) {
        const row = document.createElement('div');
        row.className = 'tree-row' + (page.id === state.currentPageId ? ' active' : '');
        row.style.setProperty('--depth', depth);
        row.dataset.pageId = page.id;

        const kids = hasChildren(page.id);
        const isCollapsed = collapsed.has(page.id);

        // Pages without sub-pages get an invisible spacer so titles stay aligned.
        const toggle = document.createElement('button');
        toggle.className = 'tree-toggle' + (kids ? (isCollapsed ? '' : ' open') : ' spacer');
        toggle.textContent = kids ? '▸' : '';
        if (kids) {
          toggle.title = isCollapsed ? 'Show sub-pages' : 'Hide sub-pages';
          toggle.setAttribute('aria-expanded', String(!isCollapsed));
          toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${page.title || 'Untitled'}`);
          toggle.addEventListener('click', (e) => { e.stopPropagation(); App.toggleCollapse(page.id); });
        } else {
          toggle.tabIndex = -1;
          toggle.setAttribute('aria-hidden', 'true');
        }

        const name = document.createElement('button');
        name.className = 'tree-name';
        name.textContent = page.title || 'Untitled';
        name.addEventListener('click', () => App.openPage(page.id));
        // Double-clicking the row itself is a quick way to fold a branch.
        if (kids) name.addEventListener('dblclick', () => App.toggleCollapse(page.id));

        const add = document.createElement('button');
        add.className = 'tree-action';
        add.textContent = '＋';
        add.title = 'Add sub-page';
        add.addEventListener('click', (e) => { e.stopPropagation(); App.createPage(page.id); });

        const del = document.createElement('button');
        del.className = 'tree-action';
        del.textContent = '✕';
        del.title = 'Delete page';
        del.addEventListener('click', (e) => { e.stopPropagation(); App.deletePage(page.id); });

        add.title = kids && isCollapsed ? 'Add sub-page (will expand)' : 'Add sub-page';

        row.append(toggle, name, add, del);
        nav.appendChild(row);
        if (!isCollapsed) build(page.id, depth + 1);
      }
    };
    build(null, 0);
    if (!nav.children.length) {
      const hint = document.createElement('p');
      hint.className = 'tree-empty';
      hint.textContent = 'No pages yet.';
      nav.appendChild(hint);
    }
  }

  function renderPage() {
    const page = state.pages[state.currentPageId];
    el('page-view').hidden = !page;
    el('empty-state').hidden = !!page;
    if (!page) return;

    const title = el('page-title');
    if (document.activeElement !== title) title.textContent = page.title;
    App.Editor.render(page);
  }

  // ---------- title editing ----------

  function wireTitle() {
    const title = el('page-title');
    title.addEventListener('input', () => {
      const page = state.pages[state.currentPageId];
      if (!page) return;
      page.title = title.textContent;
      App.persistAndRender(page.id, { rerender: false });
      renderTree(); // sidebar name follows the title live
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const page = state.pages[state.currentPageId];
        if (!page) return;
        if (!page.blocks.length) page.blocks.push(App.makeBlock('paragraph'));
        App.persistAndRender(page.id);
        App.Editor.focusBlock(page.blocks[0].id, 0);
      }
    });
    title.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\n+/g, ' '));
    });
  }

  // ---------- boot ----------

  function wireShell() {
    el('new-page-btn').addEventListener('click', () => App.createPage(null));
    el('empty-new-page').addEventListener('click', () => App.createPage(null));
    window.addEventListener('hashchange', () => {
      const id = location.hash.slice(1);
      if (id && state.pages[id]) App.openPage(id);
    });
  }

  App.showApp = function () {
    el('login').classList.add('hidden');
    el('app').classList.remove('hidden');
    const id = location.hash.slice(1);
    if (id && state.pages[id]) state.currentPageId = id;
    if (!state.currentPageId || !state.pages[state.currentPageId]) state.currentPageId = firstPageId();
    if (state.currentPageId) expandAncestors(state.currentPageId);
    App.render();
  };

  App.showLogin = function () {
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
  };

  function init() {
    loadLocal();
    loadCollapsed();
    wireShell();
    wireTitle();
    App.Editor.init();
    App.Sync.init(); // decides between login view and app view
  }

  document.addEventListener('DOMContentLoaded', init);
})();

/* Duo Notes — block editor: rendering, caret handling, slash menu, reorder. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const Editor = (App.Editor = {});

  const SLASH_ITEMS = [
    { key: 'paragraph', label: 'Text',          hint: 'Plain paragraph',                 aliases: 'paragraph plain' },
    { key: 'heading1',  label: 'Heading 1',     hint: 'Large section heading',           aliases: 'h1 title' },
    { key: 'heading2',  label: 'Heading 2',     hint: 'Medium section heading',          aliases: 'h2 subtitle' },
    { key: 'heading3',  label: 'Heading 3',     hint: 'Small section heading',           aliases: 'h3' },
    { key: 'bullet',    label: 'Bulleted list', hint: 'Simple bullet point',             aliases: 'list ul point' },
    { key: 'todo',      label: 'To-do list',    hint: 'Task with a checkbox',            aliases: 'todo task checkbox check' },
    { key: 'divider',   label: 'Divider',       hint: 'Horizontal rule',                 aliases: 'rule line hr separator' },
    { key: 'table',     label: 'Table',         hint: 'Mini database with typed columns', aliases: 'database grid db' }
  ];

  // "/todo" should find "To-do list", so match on letters and digits only.
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  function matchItems(query) {
    const q = normalize(query);
    if (!q) return SLASH_ITEMS;
    return SLASH_ITEMS.filter((item) => {
      const haystack = normalize(item.label) + ' ' + (item.aliases || '');
      return haystack.split(' ').some((word) => normalize(word).includes(q)) || normalize(item.label).includes(q);
    });
  }

  let editorEl, menuEl;
  let slash = null;        // { blockId, items, index }
  let draggingId = null;

  // ---------- caret helpers ----------

  function caretOffset(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(el);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    return range.toString().length;
  }

  function setCaret(el, offset) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    let remaining = Math.max(0, Math.min(offset, el.textContent.length));
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.length) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= node.length;
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Is the caret visually on the first / last line of the element?
  function caretOnEdgeLine(el, edge) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return true;
    if (!el.textContent) return true;
    const rects = sel.getRangeAt(0).getClientRects();
    const caretRect = rects.length ? rects[0] : null;
    if (!caretRect) return true;
    const elRect = el.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    return edge === 'first'
      ? caretRect.top - elRect.top < line * 0.8
      : elRect.bottom - caretRect.bottom < line * 0.8;
  }

  function currentPage() {
    return App.state.pages[App.state.currentPageId] || null;
  }

  function blockIndex(page, blockId) {
    return page.blocks.findIndex((b) => b.id === blockId);
  }

  Editor.focusBlock = function (blockId, offset) {
    const wrap = editorEl.querySelector(`.block[data-block-id="${blockId}"]`);
    if (!wrap) return;
    const text = wrap.querySelector('.block-text');
    if (text) setCaret(text, offset ?? text.textContent.length);
    else wrap.focus();
  };

  // ---------- rendering ----------

  Editor.render = function (page) {
    // Preserve caret across full re-renders (remote applies, structural edits).
    let restore = null;
    const active = document.activeElement;
    if (active && editorEl.contains(active) && active.classList.contains('block-text')) {
      const wrap = active.closest('.block');
      if (wrap) restore = { blockId: wrap.dataset.blockId, offset: caretOffset(active) ?? 0 };
    }

    editorEl.textContent = '';
    for (const block of page.blocks) editorEl.appendChild(renderBlock(block, page));

    if (restore) {
      const stillThere = page.blocks.some((b) => b.id === restore.blockId);
      if (stillThere) Editor.focusBlock(restore.blockId, restore.offset);
    }
  };

  function renderBlock(block, page) {
    const wrap = document.createElement('div');
    wrap.className = `block block-${block.type}`;
    wrap.dataset.blockId = block.id;

    const handle = document.createElement('button');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder';
    handle.draggable = true;
    handle.tabIndex = -1;
    handle.addEventListener('dragstart', (e) => {
      draggingId = block.id;
      wrap.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', block.id);
      e.dataTransfer.setDragImage(wrap, 12, 12);
    });
    handle.addEventListener('dragend', () => {
      draggingId = null;
      wrap.classList.remove('dragging');
      clearDropMarkers();
    });
    wrap.appendChild(handle);

    const body = document.createElement('div');
    body.className = 'block-body';

    if (block.type === 'divider') {
      body.appendChild(document.createElement('hr'));
      wrap.tabIndex = 0;
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          removeBlock(page, block.id);
        }
      });
    } else if (block.type === 'table') {
      body.appendChild(App.Table.render(block, page));
    } else {
      if (block.type === 'todo') {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'todo-check';
        check.checked = !!block.checked;
        check.addEventListener('change', () => {
          block.checked = check.checked;
          wrap.classList.toggle('done', check.checked);
          App.persistAndRender(page.id, { rerender: false });
        });
        body.appendChild(check);
        if (block.checked) wrap.classList.add('done');
      }
      const text = document.createElement('div');
      text.className = 'block-text' + (block.type === 'heading' ? ` h${block.level}` : '');
      text.contentEditable = 'true';
      text.spellcheck = true;
      text.textContent = block.text || '';
      text.dataset.placeholder = 'Type “/” for commands';
      wireTextBlock(text, block, page);
      body.appendChild(text);
    }

    wrap.appendChild(body);
    wireDropTarget(wrap, block, page);
    return wrap;
  }

  function clearDropMarkers() {
    editorEl.querySelectorAll('.drop-above, .drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below'));
  }

  function wireDropTarget(wrap, block, page) {
    wrap.addEventListener('dragover', (e) => {
      if (!draggingId || draggingId === block.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarkers();
      const rect = wrap.getBoundingClientRect();
      wrap.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below');
    });
    wrap.addEventListener('drop', (e) => {
      if (!draggingId || draggingId === block.id) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const from = blockIndex(page, draggingId);
      if (from === -1) return;
      const [moved] = page.blocks.splice(from, 1);
      let to = blockIndex(page, block.id);
      if (!before) to += 1;
      page.blocks.splice(to, 0, moved);
      draggingId = null;
      clearDropMarkers();
      App.persistAndRender(page.id);
    });
  }

  // ---------- text block behavior ----------

  function wireTextBlock(text, block, page) {
    text.addEventListener('input', () => {
      block.text = text.textContent;
      App.persistAndRender(page.id, { rerender: false });
      if (text.textContent.startsWith('/')) openSlash(block, text);
      else closeSlash();
    });

    text.addEventListener('blur', () => setTimeout(closeSlash, 150));

    text.addEventListener('paste', (e) => {
      e.preventDefault();
      const plain = e.clipboardData.getData('text/plain') || '';
      const lines = plain.split(/\r?\n/);
      if (lines.length === 1) {
        document.execCommand('insertText', false, plain);
        return;
      }
      // Multi-line paste: first line into this block, the rest become paragraphs.
      const offset = caretOffset(text) ?? text.textContent.length;
      const cur = block.text || '';
      block.text = cur.slice(0, offset) + lines[0] + cur.slice(offset);
      const idx = blockIndex(page, block.id);
      const extra = lines.slice(1).map((line) => Object.assign(App.makeBlock('paragraph'), { text: line }));
      page.blocks.splice(idx + 1, 0, ...extra);
      App.persistAndRender(page.id);
      const last = extra[extra.length - 1];
      Editor.focusBlock(last.id, last.text.length);
    });

    text.addEventListener('keydown', (e) => {
      if (slash && handleSlashKey(e)) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        splitBlock(page, block, text);
      } else if (e.key === 'Backspace' && (caretOffset(text) ?? 1) === 0 && window.getSelection().isCollapsed) {
        e.preventDefault();
        mergeWithPrevious(page, block, text);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
        e.preventDefault();
        swapBlock(page, block, text, e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === 'ArrowUp' && caretOnEdgeLine(text, 'first')) {
        if (moveFocus(page, block, -1, caretOffset(text) ?? 0)) e.preventDefault();
      } else if (e.key === 'ArrowDown' && caretOnEdgeLine(text, 'last')) {
        if (moveFocus(page, block, 1, caretOffset(text) ?? 0)) e.preventDefault();
      }
    });
  }

  function splitBlock(page, block, text) {
    closeSlash();
    const offset = caretOffset(text) ?? text.textContent.length;
    const cur = block.text || '';
    const left = cur.slice(0, offset);
    const right = cur.slice(offset);

    // Enter on an empty bullet/todo exits the list back to a paragraph.
    if ((block.type === 'bullet' || block.type === 'todo') && cur === '') {
      const fresh = App.makeBlock('paragraph');
      fresh.id = block.id;
      page.blocks[blockIndex(page, block.id)] = fresh;
      App.persistAndRender(page.id);
      Editor.focusBlock(fresh.id, 0);
      return;
    }

    block.text = left;
    const nextType = block.type === 'bullet' ? 'bullet' : block.type === 'todo' ? 'todo' : 'paragraph';
    const fresh = App.makeBlock(nextType);
    fresh.text = right;
    page.blocks.splice(blockIndex(page, block.id) + 1, 0, fresh);
    App.persistAndRender(page.id);
    Editor.focusBlock(fresh.id, 0);
  }

  function mergeWithPrevious(page, block, text) {
    const idx = blockIndex(page, block.id);
    if (idx === 0) {
      // Non-paragraph at the top demotes to paragraph instead of merging.
      if (block.type !== 'paragraph') {
        const fresh = Object.assign(App.makeBlock('paragraph'), { id: block.id, text: block.text || '' });
        page.blocks[idx] = fresh;
        App.persistAndRender(page.id);
        Editor.focusBlock(fresh.id, 0);
      }
      return;
    }
    const prev = page.blocks[idx - 1];
    if (App.isTextBlock(prev)) {
      const at = (prev.text || '').length;
      prev.text = (prev.text || '') + (block.text || '');
      page.blocks.splice(idx, 1);
      App.persistAndRender(page.id);
      Editor.focusBlock(prev.id, at);
    } else {
      // Previous is a divider/table: delete it (empty text block) or just hop over.
      if (prev.type === 'divider') {
        page.blocks.splice(idx - 1, 1);
        App.persistAndRender(page.id);
        Editor.focusBlock(block.id, 0);
      }
    }
  }

  function removeBlock(page, blockId) {
    const idx = blockIndex(page, blockId);
    if (idx === -1) return;
    page.blocks.splice(idx, 1);
    if (!page.blocks.length) page.blocks.push(App.makeBlock('paragraph'));
    App.persistAndRender(page.id);
    const target = page.blocks[Math.max(0, idx - 1)];
    if (App.isTextBlock(target)) Editor.focusBlock(target.id);
  }
  Editor.removeBlock = removeBlock;

  function swapBlock(page, block, text, dir) {
    const idx = blockIndex(page, block.id);
    const to = idx + dir;
    if (to < 0 || to >= page.blocks.length) return;
    const offset = caretOffset(text) ?? 0;
    [page.blocks[idx], page.blocks[to]] = [page.blocks[to], page.blocks[idx]];
    App.persistAndRender(page.id);
    Editor.focusBlock(block.id, offset);
  }

  function moveFocus(page, block, dir, offset) {
    let idx = blockIndex(page, block.id) + dir;
    while (idx >= 0 && idx < page.blocks.length && !App.isTextBlock(page.blocks[idx])) idx += dir;
    if (idx < 0 || idx >= page.blocks.length) {
      if (dir === -1) { document.getElementById('page-title').focus(); return true; }
      return false;
    }
    const target = page.blocks[idx];
    Editor.focusBlock(target.id, Math.min(offset, (target.text || '').length));
    return true;
  }

  // ---------- slash menu ----------

  function openSlash(block, text) {
    const items = matchItems(text.textContent.slice(1));
    if (!items.length) { closeSlash(); return; }
    slash = { blockId: block.id, items, index: 0 };
    renderSlash();
    const rect = text.getBoundingClientRect();
    menuEl.style.left = `${rect.left}px`;
    menuEl.style.top = `${rect.bottom + 6 + window.scrollY}px`;
    menuEl.hidden = false;
  }

  function renderSlash() {
    menuEl.textContent = '';
    slash.items.forEach((item, i) => {
      const row = document.createElement('button');
      row.className = 'slash-item' + (i === slash.index ? ' selected' : '');
      const label = document.createElement('span');
      label.className = 'slash-label';
      label.textContent = item.label;
      const hint = document.createElement('span');
      hint.className = 'slash-hint';
      hint.textContent = item.hint;
      row.append(label, hint);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); applySlash(item.key); });
      menuEl.appendChild(row);
    });
  }

  function closeSlash() {
    slash = null;
    menuEl.hidden = true;
  }

  function handleSlashKey(e) {
    if (e.key === 'ArrowDown') { slash.index = (slash.index + 1) % slash.items.length; renderSlash(); }
    else if (e.key === 'ArrowUp') { slash.index = (slash.index - 1 + slash.items.length) % slash.items.length; renderSlash(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { applySlash(slash.items[slash.index].key); }
    else if (e.key === 'Escape') { closeSlash(); }
    else return false;
    e.preventDefault();
    return true;
  }

  function applySlash(key) {
    const page = currentPage();
    if (!page || !slash) return;
    const idx = blockIndex(page, slash.blockId);
    if (idx === -1) { closeSlash(); return; }
    closeSlash();

    const fresh = App.makeBlock(key);
    fresh.id = page.blocks[idx].id; // keep identity so caret restore stays sane
    page.blocks[idx] = fresh;

    if (key === 'divider' || key === 'table') {
      // Non-text blocks: give the caret somewhere to land after insertion.
      const next = page.blocks[idx + 1];
      if (!next || !App.isTextBlock(next)) {
        page.blocks.splice(idx + 1, 0, App.makeBlock('paragraph'));
      }
      App.persistAndRender(page.id);
      Editor.focusBlock(page.blocks[idx + 1].id, 0);
    } else {
      App.persistAndRender(page.id);
      Editor.focusBlock(fresh.id, 0);
    }
  }

  // ---------- init ----------

  Editor.init = function () {
    editorEl = document.getElementById('editor');
    menuEl = document.getElementById('slash-menu');

    // Click on empty space below the last block appends a paragraph.
    editorEl.addEventListener('mousedown', (e) => {
      if (e.target !== editorEl) return;
      const page = currentPage();
      if (!page) return;
      const last = page.blocks[page.blocks.length - 1];
      if (last && App.isTextBlock(last) && !last.text) {
        Editor.focusBlock(last.id);
        return;
      }
      e.preventDefault();
      const fresh = App.makeBlock('paragraph');
      page.blocks.push(fresh);
      App.persistAndRender(page.id);
      Editor.focusBlock(fresh.id, 0);
    });

    document.addEventListener('mousedown', (e) => {
      if (slash && !menuEl.contains(e.target)) closeSlash();
    });
  };
})();

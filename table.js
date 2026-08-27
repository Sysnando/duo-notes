/* Duo Notes — mini-database table block: typed columns, rows, sorting. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const Table = (App.Table = {});

  const COLUMN_TYPES = ['text', 'checkbox', 'date', 'select'];

  Table.makeBlock = function (id) {
    return {
      id,
      type: 'table',
      columns: [
        { id: App.uid(), name: 'Name', type: 'text', options: [] },
        { id: App.uid(), name: 'Notes', type: 'text', options: [] }
      ],
      rows: [{ id: App.uid(), cells: {} }],
      sort: { columnId: null, dir: 'asc' }
    };
  };

  // ---------- sorting ----------

  function sortedRows(block) {
    const { columnId, dir } = block.sort || {};
    if (!columnId) return block.rows;
    const col = block.columns.find((c) => c.id === columnId);
    if (!col) return block.rows;
    const sign = dir === 'desc' ? -1 : 1;
    const empty = (v) => v === undefined || v === null || v === '';
    return [...block.rows].sort((a, b) => {
      const va = a.cells[columnId];
      const vb = b.cells[columnId];
      if (empty(va) && empty(vb)) return 0;
      if (empty(va)) return 1; // empties last, regardless of direction
      if (empty(vb)) return -1;
      if (col.type === 'checkbox') return ((va ? 1 : 0) - (vb ? 1 : 0)) * sign;
      return String(va).localeCompare(String(vb)) * sign; // ISO dates compare fine as strings
    });
  }

  // ---------- rendering ----------

  Table.render = function (block, page) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    // Keep table keystrokes (Enter in inputs, arrows in selects) out of the editor.
    wrap.addEventListener('keydown', (e) => e.stopPropagation());

    const table = document.createElement('table');
    table.className = 'mini-table';

    // Header
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of block.columns) {
      const th = document.createElement('th');
      const name = document.createElement('button');
      name.className = 'col-name';
      name.textContent = col.name || 'Untitled';
      name.title = 'Rename column';
      name.addEventListener('click', () => renameColumn(th, block, col, page));
      const caret = document.createElement('button');
      caret.className = 'col-caret';
      caret.textContent = block.sort?.columnId === col.id ? (block.sort.dir === 'desc' ? '▾' : '▴') : '▿';
      caret.title = 'Column options';
      caret.addEventListener('click', (e) => openColMenu(e.currentTarget, block, col, page));
      th.append(name, caret);
      headRow.appendChild(th);
    }
    const addTh = document.createElement('th');
    addTh.className = 'add-col';
    const addBtn = document.createElement('button');
    addBtn.textContent = '＋';
    addBtn.title = 'Add column';
    addBtn.addEventListener('click', () => {
      block.columns.push({ id: App.uid(), name: `Column ${block.columns.length + 1}`, type: 'text', options: [] });
      App.persistAndRender(page.id);
    });
    addTh.appendChild(addBtn);
    headRow.appendChild(addTh);
    thead.appendChild(headRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const row of sortedRows(block)) {
      const tr = document.createElement('tr');
      for (const col of block.columns) {
        const td = document.createElement('td');
        td.appendChild(renderCell(block, page, row, col));
        tr.appendChild(td);
      }
      const endTd = document.createElement('td');
      endTd.className = 'row-end';
      const del = document.createElement('button');
      del.className = 'row-del';
      del.textContent = '✕';
      del.title = 'Delete row';
      del.addEventListener('click', () => {
        block.rows = block.rows.filter((r) => r.id !== row.id);
        App.persistAndRender(page.id);
      });
      endTd.appendChild(del);
      tr.appendChild(endTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // Footer
    const tfoot = document.createElement('tfoot');
    const footRow = document.createElement('tr');
    const footTd = document.createElement('td');
    footTd.colSpan = block.columns.length + 1;
    const newRow = document.createElement('button');
    newRow.className = 'new-row';
    newRow.textContent = '＋ New row';
    newRow.addEventListener('click', () => {
      block.rows.push({ id: App.uid(), cells: {} });
      App.persistAndRender(page.id);
    });
    footTd.appendChild(newRow);
    footRow.appendChild(footTd);
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    const remove = document.createElement('button');
    remove.className = 'table-remove';
    remove.textContent = '✕ table';
    remove.title = 'Delete this table block';
    remove.addEventListener('click', () => {
      if (confirm('Delete this table?')) App.Editor.removeBlock(page, block.id);
    });

    wrap.append(table, remove);
    return wrap;
  };

  function renderCell(block, page, row, col) {
    const value = row.cells[col.id];
    const commit = (v, rerender) => {
      row.cells[col.id] = v;
      App.persistAndRender(page.id, { rerender: rerender !== false });
    };

    switch (col.type) {
      case 'checkbox': {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!value;
        input.addEventListener('change', () => commit(input.checked));
        return input;
      }
      case 'date': {
        const input = document.createElement('input');
        input.type = 'date';
        input.className = 'cell-input';
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) input.value = value;
        input.addEventListener('change', () => commit(input.value));
        return input;
      }
      case 'select': {
        const select = document.createElement('select');
        select.className = 'cell-input';
        const opts = [...(col.options || [])];
        if (value && !opts.includes(value)) opts.unshift(value); // orphaned value still shows
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        select.appendChild(blank);
        for (const o of opts) {
          const opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          select.appendChild(opt);
        }
        select.value = typeof value === 'string' ? value : '';
        select.addEventListener('change', () => commit(select.value));
        return select;
      }
      default: {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cell-input';
        input.value = value === undefined || value === null ? '' : String(value);
        // Typing shouldn't re-render (rows would jump under a live sort);
        // order settles on the next structural render.
        input.addEventListener('input', () => commit(input.value, false));
        return input;
      }
    }
  }

  // ---------- column management ----------

  function renameColumn(th, block, col, page) {
    const name = th.querySelector('.col-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'col-rename';
    input.value = col.name;
    name.replaceWith(input);
    input.focus();
    input.select();
    const done = () => {
      col.name = input.value.trim() || col.name;
      App.persistAndRender(page.id);
    };
    input.addEventListener('blur', done);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = col.name; input.blur(); }
    });
  }

  let menuEl = null;

  function closeColMenu() {
    if (menuEl) { menuEl.hidden = true; menuEl.textContent = ''; }
  }

  function openColMenu(anchor, block, col, page) {
    menuEl = document.getElementById('col-menu');
    menuEl.textContent = '';

    const item = (label, fn, cls) => {
      const btn = document.createElement('button');
      btn.className = 'col-menu-item' + (cls ? ' ' + cls : '');
      btn.textContent = label;
      btn.addEventListener('click', () => { closeColMenu(); fn(); });
      menuEl.appendChild(btn);
    };
    const rule = () => menuEl.appendChild(document.createElement('hr'));

    item('Sort ascending', () => { block.sort = { columnId: col.id, dir: 'asc' }; App.persistAndRender(page.id); });
    item('Sort descending', () => { block.sort = { columnId: col.id, dir: 'desc' }; App.persistAndRender(page.id); });
    if (block.sort?.columnId) {
      item('Clear sort', () => { block.sort = { columnId: null, dir: 'asc' }; App.persistAndRender(page.id); });
    }
    rule();
    for (const type of COLUMN_TYPES) {
      if (type === col.type) continue;
      item(`Type: ${type}`, () => {
        col.type = type;
        if (type === 'select' && !col.options?.length) editOptions(block, col, page);
        else App.persistAndRender(page.id);
      });
    }
    if (col.type === 'select') {
      rule();
      item('Edit options…', () => editOptions(block, col, page));
    }
    rule();
    item('Delete column', () => {
      if (!confirm(`Delete column “${col.name}” and its values?`)) return;
      block.columns = block.columns.filter((c) => c.id !== col.id);
      for (const row of block.rows) delete row.cells[col.id];
      if (block.sort?.columnId === col.id) block.sort = { columnId: null, dir: 'asc' };
      App.persistAndRender(page.id);
    }, 'danger');

    const rect = anchor.getBoundingClientRect();
    menuEl.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
    menuEl.style.top = `${rect.bottom + 4 + window.scrollY}px`;
    menuEl.hidden = false;

    setTimeout(() => {
      document.addEventListener('mousedown', function onDoc(e) {
        if (!menuEl.contains(e.target)) {
          closeColMenu();
          document.removeEventListener('mousedown', onDoc);
        }
      });
    }, 0);
  }

  function editOptions(block, col, page) {
    const current = (col.options || []).join(', ');
    const next = prompt('Options (comma-separated):', current);
    if (next === null) { App.persistAndRender(page.id); return; }
    col.options = next.split(',').map((s) => s.trim()).filter(Boolean);
    App.persistAndRender(page.id);
  }
})();

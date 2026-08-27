/* Duo Notes — Supabase auth, debounced push, realtime subscription, presence.
 * With an empty config.js the app runs local-only: no login, localStorage only. */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const Sync = (App.Sync = {});

  const cfg = window.DUO_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const clientId = crypto.randomUUID(); // per-tab, for echo filtering

  Sync.dirty = new Set();          // page ids with unpushed local edits
  Sync.applyingRemote = false;

  let client = null;
  let user = null;
  let pushTimers = {};             // pageId -> debounce timer
  let pendingDeletes = new Set();
  let presenceChannel = null;
  let wasHidden = false;

  const $ = (id) => document.getElementById(id);

  // ---------- status UI ----------

  function setStatus(kind, title) {
    const dot = $('sync-status');
    dot.className = 'sync-status ' + kind;
    dot.title = title;
    $('offline-banner').hidden = kind !== 'offline';
  }

  // ---------- row mapping ----------

  const toRow = (p) => ({
    id: p.id,
    parent_id: p.parentId || null,
    title: p.title || '',
    blocks: p.blocks || [],
    sort_order: p.sortOrder || 0,
    updated_at: p.updatedAt || new Date().toISOString(),
    updated_by: user ? user.id : null,
    client_id: clientId
  });

  const fromRow = (r) => ({
    id: r.id,
    parentId: r.parent_id || null,
    title: r.title || '',
    blocks: r.blocks || [],
    sortOrder: r.sort_order || 0,
    updatedAt: r.updated_at
  });

  // ---------- push ----------

  Sync.schedulePush = function (pageId) {
    if (!enabled || Sync.applyingRemote) return;
    Sync.dirty.add(pageId);
    clearTimeout(pushTimers[pageId]);
    pushTimers[pageId] = setTimeout(() => pushPage(pageId), 800);
  };

  async function pushPage(pageId) {
    if (!enabled || !user) return;
    const page = App.state.pages[pageId];
    if (!page) { Sync.dirty.delete(pageId); return; }
    const { error } = await client.from('pages').upsert(toRow(page));
    if (error) {
      console.warn('push failed', error);
      setStatus('offline', 'Push failed; will retry');
    } else {
      Sync.dirty.delete(pageId);
      App.saveLocal();
      setStatus('online', 'Synced');
    }
  }

  Sync.pushDelete = async function (ids) {
    if (!enabled || !user) return;
    const { error } = await client.from('pages').delete().in('id', ids);
    if (error) {
      console.warn('delete failed', error);
      for (const id of ids) pendingDeletes.add(id);
      setStatus('offline', 'Delete failed; will retry');
    }
  };

  async function flushPending() {
    if (!enabled || !user) return;
    if (pendingDeletes.size) {
      const ids = [...pendingDeletes];
      pendingDeletes.clear();
      await Sync.pushDelete(ids);
    }
    for (const id of [...Sync.dirty]) await pushPage(id);
  }

  // ---------- pull / reconcile ----------

  // Take the server's copy of a page. When we still owe a push, canvas elements
  // are unioned by id rather than overwritten, so two people drawing on the same
  // canvas don't erase each other.
  function adoptRow(row) {
    const remotePage = fromRow(row);
    const local = App.state.pages[row.id];
    if (local && Sync.dirty.has(row.id) && App.Canvas && App.Canvas.mergeCanvasBlocks) {
      App.Canvas.mergeCanvasBlocks(local, remotePage);
    }
    App.state.pages[row.id] = remotePage;
  }

  // We're keeping our newer copy of the page, but anything drawn on a canvas that
  // only the server knows about should still survive.
  function foldCanvasOnly(row) {
    const local = App.state.pages[row.id];
    if (!local || !App.Canvas || !App.Canvas.foldRemoteElements) return;
    if (App.Canvas.foldRemoteElements(local, fromRow(row))) {
      App.saveLocal();
      App.Canvas.refreshAll();
    }
  }

  const deferredRows = new Map();

  function applyRemoteRow(row) {
    // Never yank the DOM out from under an in-progress drawing gesture.
    if (App.Canvas && App.Canvas.isBusy()) {
      deferredRows.set(row.id, row);
      return;
    }
    Sync.applyingRemote = true;
    adoptRow(row);
    Sync.applyingRemote = false;
    if (App.state.currentPageId && !App.state.pages[App.state.currentPageId]) {
      App.state.currentPageId = null;
    }
    App.saveLocal();
    App.render();
    if (App.Canvas) App.Canvas.refreshAll();
  }

  // Called by the canvas as soon as a gesture finishes. This runs before the
  // debounced push fires, so remote work is merged in before we upload.
  Sync.flushDeferred = function () {
    if (!deferredRows.size) return;
    if (App.Canvas && App.Canvas.isBusy()) return;
    const rows = [...deferredRows.values()];
    deferredRows.clear();
    for (const row of rows) applyRemoteRow(row);
  };

  async function refetchAll() {
    const { data, error } = await client.from('pages').select('*');
    if (error) {
      console.warn('fetch failed', error);
      setStatus('offline', 'Server unreachable; offline from cache');
      return false;
    }
    Sync.applyingRemote = true;
    const remoteIds = new Set();
    for (const row of data) {
      remoteIds.add(row.id);
      const local = App.state.pages[row.id];
      const localWins = local && Sync.dirty.has(row.id) && local.updatedAt > row.updated_at;
      if (localWins) foldCanvasOnly(row);
      else adoptRow(row);
    }
    // Local pages missing remotely: deleted elsewhere unless we still owe a push.
    for (const id of Object.keys(App.state.pages)) {
      if (!remoteIds.has(id) && !Sync.dirty.has(id)) delete App.state.pages[id];
    }
    Sync.applyingRemote = false;
    if (App.state.currentPageId && !App.state.pages[App.state.currentPageId]) {
      App.state.currentPageId = null;
    }
    App.saveLocal();
    App.render();
    if (App.Canvas) App.Canvas.refreshAll();
    setStatus('online', 'Synced');
    await flushPending();
    return true;
  }

  async function fetchOne(pageId) {
    const { data } = await client.from('pages').select('*').eq('id', pageId).maybeSingle();
    if (!data) return;
    applyRemoteRow(data);
  }

  // ---------- realtime ----------

  function subscribe() {
    client
      .channel('pages-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pages' }, onChange)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setStatus('online', 'Live');
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setStatus('offline', 'Realtime dropped; refetching on focus');
        }
      });
  }

  function onChange(payload) {
    if (payload.eventType === 'DELETE') {
      const id = payload.old && payload.old.id;
      if (!id || !App.state.pages[id]) return;
      Sync.applyingRemote = true;
      delete App.state.pages[id];
      Sync.applyingRemote = false;
      if (App.state.currentPageId === id) App.state.currentPageId = null;
      App.saveLocal();
      App.render();
      return;
    }

    const row = payload.new;
    if (!row || row.client_id === clientId) return; // self-echo
    if (row.blocks === undefined || row.blocks === null) { fetchOne(row.id); return; } // oversized payload

    const local = App.state.pages[row.id];
    const stale = local && local.updatedAt && row.updated_at <= local.updatedAt;
    if (stale) {
      // Our copy is newer, so it wins — but don't discard canvas work that only
      // exists on their side.
      if (Sync.dirty.has(row.id)) foldCanvasOnly(row);
      return;
    }
    applyRemoteRow(row);
  }

  // ---------- canvas live cursors ----------

  // Ephemeral broadcast channel: cursor positions and in-progress strokes never
  // touch the database, so they cost no writes and cause no write conflicts.
  Sync.canvasChannel = function (blockId, handlers) {
    if (!enabled || !client || !user) return null;
    const channel = client.channel('canvas:' + blockId, {
      config: { broadcast: { self: false } }
    });
    channel.on('broadcast', { event: 'cursor' }, (message) => {
      if (handlers.onCursor) handlers.onCursor(message && message.payload);
    });
    channel.on('broadcast', { event: 'leave' }, (message) => {
      const payload = message && message.payload;
      if (handlers.onLeave && payload) handlers.onLeave(payload.clientId);
    });
    channel.subscribe();

    return {
      send(payload) {
        channel.send({
          type: 'broadcast',
          event: 'cursor',
          payload: Object.assign({ clientId, name: user ? user.email : '' }, payload)
        });
      },
      close() {
        try {
          channel.send({ type: 'broadcast', event: 'leave', payload: { clientId } });
        } catch (err) { /* channel already gone */ }
        client.removeChannel(channel);
      }
    };
  };

  // ---------- presence ----------

  function startPresence() {
    presenceChannel = client.channel('presence:duo-notes', {
      config: { presence: { key: clientId } }
    });
    presenceChannel.on('presence', { event: 'sync' }, renderPresence);
    presenceChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') Sync.reportPresence();
    });
  }

  Sync.reportPresence = function () {
    if (!presenceChannel) return;
    presenceChannel.track({ email: user ? user.email : '', pageId: App.state.currentPageId });
  };

  function renderPresence() {
    const hint = $('presence-hint');
    if (!presenceChannel) { hint.hidden = true; return; }
    const others = [];
    const presences = presenceChannel.presenceState();
    for (const [key, metas] of Object.entries(presences)) {
      if (key === clientId) continue;
      for (const meta of metas) {
        if (meta.pageId && meta.pageId === App.state.currentPageId) others.push(meta.email || 'Someone');
      }
    }
    const names = [...new Set(others)];
    hint.hidden = !names.length;
    if (names.length) hint.textContent = `${names.join(', ')} is also on this page`;
  }

  // ---------- auth ----------

  function wireLogin() {
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('login-btn');
      const errEl = $('login-error');
      btn.disabled = true;
      errEl.hidden = true;
      const { error } = await client.auth.signInWithPassword({
        email: $('login-email').value.trim(),
        password: $('login-password').value
      });
      btn.disabled = false;
      if (error) {
        errEl.textContent = error.message;
        errEl.hidden = false;
      }
      // Success is handled by onAuthStateChange.
    });

    $('signout-btn').addEventListener('click', () => client.auth.signOut());
  }

  async function startApp(session) {
    user = session.user;
    $('user-email').textContent = user.email || '';
    $('signout-btn').hidden = false;
    App.showApp();
    setStatus('online', 'Connecting…');
    await refetchAll();
    subscribe();
    startPresence();
    Sync.reportPresence();
  }

  // ---------- init ----------

  Sync.init = async function () {
    if (!enabled) {
      // Still track dirty ids: pages written before Supabase was configured
      // must survive the first reconcile and get pushed up, not wiped.
      Sync.schedulePush = (pageId) => { Sync.dirty.add(pageId); };
      Sync.pushDelete = () => {};
      Sync.reportPresence = () => {};
      App.showApp();
      setStatus('local', 'Local-only mode (no Supabase configured)');
      return;
    }

    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    wireLogin();

    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && !user) startApp(session);
      if (event === 'SIGNED_OUT') {
        user = null;
        App.showLogin();
      }
    });

    const { data } = await client.auth.getSession();
    if (data.session) startApp(data.session);
    else App.showLogin();

    // Heal missed events and retry failed pushes.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { wasHidden = true; return; }
      if (wasHidden && user) { wasHidden = false; refetchAll(); }
    });
    window.addEventListener('online', flushPending);
    setInterval(() => { if (user) flushPending(); }, 15000);
  };
})();

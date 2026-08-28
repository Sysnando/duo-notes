# Duo Notes

A tiny Notion-like knowledge app for two people. Pages are the base primitive:
each page holds blocks (text, headings, bullets, to-dos, dividers, mini-database
tables, and drawing canvases) edited Notion-style with a "/" insert menu. Both
users share the same pages with live sync.

Zero build: plain HTML/CSS/vanilla JS. No framework, no bundler, no package.json.

## Run locally

```bash
cd duo-notes
python3 -m http.server 8000   # then open http://localhost:8000
```

With an empty `config.js` the app runs in **local-only mode**: no login, data
persisted in `localStorage` only. That is enough to try everything except sync.

## Backend (already provisioned)

The app is wired to a Supabase project (`duo-notes`, eu-west-1, free tier) and
`config.js` holds its URL and anon key. That key is meant to be public: it grants
nothing on its own, because access is gated on the `members` allow-list below.

### Two spaces: shared and private

The sidebar has a **Shared** section both people see and a **Private** section
each person sees only their own of. Where you create a page decides its space, so
there is no invisible default; the control next to a page title moves it across.

- `pages.visibility` is `'shared'` or `'private'`, defaulting to private.
- `pages.owner_id` is stamped from `auth.uid()` by a trigger on insert and frozen
  on update, so ownership cannot be claimed or reassigned through the API. The
  client never sends it.
- The policy is `using (is_member() and (visibility = 'shared' or owner_id =
  auth.uid()))`, applied as both `USING` and `WITH CHECK`. Using it for the check
  as well is what makes **only the owner able to un-share**: for anyone else the
  new row fails the check.
- `set_page_visibility(root_id, vis)` moves a page and its whole subtree in one
  transaction, under the caller's own permissions. Doing this as N separate
  updates from the browser could leave a subtree half-moved, which for privacy is
  the one failure worth designing out.
- A page changing space becomes top level there, because its parent may not exist
  in the other space. The sidebar also treats any page whose parent it cannot see
  as a root, so a page can never exist while being unreachable.
- Sub-pages inherit their parent's space, so a tree is never half-shared.

Signed out (local-only mode) there is one person and one space, so the sections
and the control disappear and it stays a single flat list.

### How access is restricted

- `public.pages` has RLS on, with a single policy: `for all to authenticated
  using (public.is_member() and (visibility = 'shared' or owner_id =
  auth.uid()))`.
- `public.is_member()` is a `security definer` function that checks the caller's
  email against `public.members`.
- `public.members` has RLS on and **no** policies, and `anon`/`authenticated`
  have no grants on it, so the allow-list cannot be read or edited through the
  API — only with the database password or the service role key.
- A `before insert` trigger on `auth.users` refuses any account whose address is
  not on the allow-list, so a stray signup cannot create an account at all —
  even if public signup is left enabled in the dashboard. Add the address to
  `members` first, then create the account.

Verified end to end against the live project, with two real accounts: anonymous
reads return nothing; a signed-in account that is not on the list reads nothing
and gets 403 on writes; an account on the list reads and writes normally;
reading the allow-list is denied; an account for an uninvited address is refused outright; one person cannot
see or fetch the other's private pages, cannot seize ownership of a shared page,
and cannot un-share a page they did not write; and cascading a subtree between
spaces works for the owner and does nothing for anyone else.

### Adding or changing who has access

Connect with the pooler connection string (the database password is in
`~/.duo-notes/db-password.txt` on the owner's Mac, and in the Supabase dashboard
under Settings → Database):

```bash
psql "postgresql://postgres.qnhmpcropfqkorvltpmx:<db-password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"
```

```sql
-- grant access to an address
insert into public.members (email, note) values ('her@example.com', 'Wife');
-- revoke it
delete from public.members where email = 'her@example.com';
-- inviting a third person is just this insert; no trigger to drop
```

An email must be on this list **and** have an account. Accounts are created in
the dashboard under Authentication → Users → Add user, with "Auto Confirm User"
ticked.

### Recreating the backend from scratch

If the project is ever deleted, run this in the SQL editor of a new project,
then paste the new URL and anon key into `config.js`:

```sql
create table public.pages (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.pages(id) on delete cascade,
  title       text not null default '',
  blocks      jsonb not null default '[]'::jsonb,
  sort_order  double precision not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id),
  client_id   text,
  owner_id    uuid references auth.users(id),
  visibility  text not null default 'private' check (visibility in ('private','shared'))
);
create index pages_parent_idx on public.pages(parent_id);
create index pages_visibility_idx on public.pages(visibility);
alter table public.pages enable row level security;
alter table public.pages replica identity full;   -- realtime needs the whole row
alter publication supabase_realtime add table public.pages;

create table public.members (email text primary key, note text, added_at timestamptz not null default now());
alter table public.members enable row level security;
revoke all on public.members from anon, authenticated;

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.members m
                   where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
  $$;
revoke all on function public.is_member() from anon;
grant execute on function public.is_member() to authenticated;

-- Ownership is stamped by the database and immutable, so it cannot be claimed.
create or replace function public.stamp_owner() returns trigger
  language plpgsql security definer set search_path = public as $$
  begin
    if tg_op = 'INSERT' then new.owner_id := coalesce(auth.uid(), new.owner_id);
    else new.owner_id := old.owner_id; end if;
    return new;
  end $$;
create trigger pages_stamp_owner before insert or update on public.pages
  for each row execute function public.stamp_owner();

-- Used as WITH CHECK too: that is what stops anyone but the owner un-sharing.
create policy "shared or mine" on public.pages for all to authenticated
  using      (public.is_member() and (visibility = 'shared' or owner_id = auth.uid()))
  with check (public.is_member() and (visibility = 'shared' or owner_id = auth.uid()));

-- Moves a page and its whole subtree between spaces in one transaction.
create or replace function public.set_page_visibility(root_id uuid, vis text)
returns setof uuid language sql volatile security invoker set search_path = public as $$
  with recursive subtree as (
    select id from public.pages where id = root_id
    union all
    select p.id from public.pages p join subtree s on p.parent_id = s.id
  )
  update public.pages p
     set visibility = vis,
         parent_id  = case when p.id = root_id then null else p.parent_id end,
         updated_at = now()
   where p.id in (select id from subtree) and vis in ('private','shared')
  returning p.id;
$$;
revoke all on function public.set_page_visibility(uuid, text) from anon;
grant execute on function public.set_page_visibility(uuid, text) to authenticated;

-- Only invited addresses may have accounts.
create or replace function public.gate_signups() returns trigger
  language plpgsql security definer set search_path = auth, public as $$
  begin
    if not exists (select 1 from public.members m where lower(m.email) = lower(new.email)) then
      raise exception 'duo-notes: % is not an invited address', new.email;
    end if;
    return new;
  end $$;
create trigger duo_notes_gate_signups before insert on auth.users
  for each row execute function public.gate_signups();
```

Turning off Authentication → Sign In / Providers → Email → "Allow new users to
sign up" is still tidy, but no longer load-bearing: the gate trigger means an
uninvited address cannot get an account whether signup is on or off.

Note: free Supabase projects pause after about a week of inactivity. If the app
shows the offline banner and nothing syncs, open the dashboard and hit Restore.

## Deploy

`.github/workflows/pages.yml` publishes the repo root to GitHub Pages on every
push to `main`. Enable Pages in the repo settings with Source: GitHub Actions.
Everything committed ships as-is, including `config.js`.

## Architecture

- `app.js` — state (`{pages, currentPageId}`), localStorage cache
  (`duo-notes.cache.v1`), the `persistAndRender()` funnel every mutation goes
  through, sidebar tree, hash routing, boot.

  Sidebar branches fold. A page with sub-pages gets a disclosure triangle
  (double-clicking its name works too), and which branches are shut is kept per
  person in `duo-notes.tree.v1`, outside the synced document — otherwise one of
  you folding a branch would fold it for the other. Opening a page unfolds
  whatever is above it, and adding a sub-page to a folded parent opens that
  parent so the new page is visible. Folding a branch you are currently reading
  inside is allowed: the branch closes, the page stays open.
- `editor.js` — block editor: one contenteditable per text block, Enter
  splits / Backspace merges, arrow-key navigation, "/" slash menu,
  Alt+Arrow and drag-handle reorder, plain-text paste.
- `table.js` — the table block: a mini database with typed columns
  (text / checkbox / date / select), add/remove rows and columns, per-column
  sort persisted as view state. Lives entirely inside the block JSON, so it
  syncs for free.
- `icons.js` / `canvas-core.js` / `canvas.js` / `canvas-ui.js` — the drawing
  block. See below.
- `sync.js` — Supabase auth, debounced per-page upsert (last write wins per
  page), realtime `postgres_changes` subscription with self-echo and staleness
  guards, presence hint ("X is also on this page"), offline retry, and the
  ephemeral broadcast channel behind live canvas cursors.
- `index.html` / `styles.css` — login view + app shell, warm notebook theme.

## The drawing block

Insert one with `/draw` (also `/canvas`, `/sketch`, `/diagram`). It renders
inline in the page and **Expand** opens it full screen. Everything lives in the
block's JSON, so a drawing persists and syncs like any other block.

Tools: select (V), pan (H, or hold Space), pencil (P), eraser (E), rectangle (R),
ellipse (O), diamond (D), triangle (G), cylinder (C), arrow (A), line (L), text
(T), sticky note (S), frame (F), and a UML class box. Double-click any shape to
label it, or empty space for free text. `⌘Z` / `⇧⌘Z` undo and redo, `⌘D`
duplicates, `⌘]` / `⌘[` change stacking, arrow keys nudge, `⌘A` selects all.
Escape cancels a tool or selection first, and only closes the drawer when there
is nothing left to cancel.

**Linking is by binding, not coordinates.** Hover a shape and four connector dots
appear on its edges; drag from one to another shape to connect them. Arrows drawn
with the arrow tool also bind when an endpoint lands on a shape. An arrow stores
*which* elements it joins, and its endpoints are recomputed at render time from
where those shapes currently sit — so moving a box re-routes every arrow attached
to it without touching any stored geometry. The **Ends** menu carries the UML
arrowheads (hollow triangle for inheritance, filled diamond for composition,
hollow diamond for aggregation; pair a dashed stroke with an open arrow for
dependency).

**Icons** come from `icons.js`: 20 AWS-style, 8 UML, and 20 generic
infrastructure glyphs. The AWS ones are original simplified approximations in
AWS's category colours, **not** Amazon's official artwork, which is licensed and
would need fetching from outside. When a diagram needs the real thing, use
*Import an SVG…* in the icon picker: paste the markup and it becomes a reusable
icon stored on that canvas. Imports are sanitised (scripts, inline handlers,
external references and `foreignObject` are stripped) before anything is stored.

**Sketchy or crisp** toggles per canvas. Sketch mode derives a deterministic
wobble from each element's id — the same shape always wobbles the same way, so
nothing shimmers on re-render — and sets canvas text in Architects Daughter.
Crisp mode draws true geometry, which reads better for formal diagrams.

Pan and zoom are stored per person in `localStorage`
(`duo-notes.view.<blockId>`), deliberately outside the synced document: if the
camera were shared, one person scrolling would drag the other's viewport.

**Drawing together.** While the drawer is open, a Supabase *broadcast* channel
carries each person's cursor and the element they are currently dragging, so you
see her stroke as it happens rather than after it lands. None of that touches the
database. For the document itself, two guards protect concurrent drawing: an
incoming page update is deferred while a gesture is in flight, and when an update
arrives for a canvas you have unpushed edits on, elements are merged by id rather
than the page being replaced. Element-level last-write-wins means two people
adding different things never lose work; a deletion racing an edit can lose, and
the element comes back.

Export writes a PNG (2×) or a standalone SVG of the drawing's bounds. Text in the
PNG may fall back to a system font, because webfonts don't load inside an SVG
being rasterised; the SVG export is unaffected.

Not in this version: rotating elements, and live cursors on the small inline
canvas (they run in the expanded drawer only).

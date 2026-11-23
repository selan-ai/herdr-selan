// Workspace spaces with their tabs (agents) listed under each one, in place of a tab bar:
// stable colored avatars, worktrees under their checkout, grouped by machine when more
// than one is known. After a space's name, only what is unusual about the repo its first
// terminal is in now: its branch, ahead/behind. Under it, one row per tab: its agent's icon, its
// live title and status, and the tab's sub-agents under it. Click a space or a tab to
// show it, right-click for its menu, drag a space to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, machines, panes, terminals, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout, appHome, readTextFile } from "herdr";

// Same as the tabs and agents mods: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title; a name the person gave stays.
function tabLabel(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

// The program's icon: a one-color glyph or a picture.
function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// A sub-agent's raw word: error counts as blocked, and it's never done (its parent's done is the news).
const kidStatus = (s) => (s === "error" ? "blocked" : s === "done" ? "idle" : s);

// Where a tab row's text starts: under the space's name (row inset 8 + avatar 18 + gap 9).
const TAB_INSET = 35;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The mod a space dropped on another machine opens, when it is installed: it moves the space there.
const TELEPORT = "selan-teleport";

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A chat's own color, picked from its right-press menu: a bar at its left in one of the avatar colors,
// or muted, which dims the whole row for a chat to leave be. Kept by tab id, in this order in the menu.
const CHAT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1", "muted"];
const CHAT_KEY = "chats.colors";
const MENU = { width: 228, swatches: 40, item: 28, pad: 4 };
const MENU_ITEMS = ["Rename", "New tab", "Close"];

// Every chat's color, as the sidebar and its menu share it.
function chatColors() {
  const c = shared(CHAT_KEY);
  return c && typeof c === "object" && !Array.isArray(c) ? c : {};
}

// A chat's color set (null: none), kept across restarts, among the chats there are now.
function setChatColor(id, color) {
  const tabs = new Set(spaces().flatMap((s) => (s.tabs ?? []).map((c) => c.id)));
  const kept = Object.fromEntries(Object.entries(chatColors()).filter(([k]) => tabs.has(k) && k !== id));
  if (color) kept[id] = color;
  setShared(CHAT_KEY, kept);
  localStorage.setItem(CHAT_KEY, JSON.stringify(kept));
}

// A chat's right-press menu, opened as a popup at the pointer: its colors, then Rename, New tab, Close.
class ChatMenu {
  static open(tab, space) {
    const height = MENU.pad * 2 + MENU.swatches + 9 + MENU_ITEMS.length * MENU.item;
    openOverlay({ mod: "selan-spaces", kind: "popup", width: MENU.width, height, props: { chatMenu: { tab, space } } });
  }

  static render(t, { tab, space }, overlay) {
    const current = chatColors()[tab] ?? null;
    const done = () => closeOverlay(overlay);
    const swatch = (color) => div().id(`color-${color ?? "none"}`).size(18).flex_none().rounded(9).cursor_pointer()
      .when(color === null, (el) => el.border(1.5).border_color(t.dim))
      .when(color === "muted", (el) => el.bg(t.dim))
      .when(color !== null && color !== "muted", (el) => el.bg(MARK[color] ?? t[color]))
      .when(current === color, (el) => el.border(2).border_color(t.foreground))
      .when(current !== color, (el) => el.hover((st) => st.opacity(0.75)))
      .tooltip(color === null ? "No color" : color === "muted" ? "Muted" : "Color")
      .on_click(() => { setChatColor(tab, color); done(); });
    const item = (label, action) => h_flex().id(`item-${label}`).h(MENU.item).flex_none().px(10).items_center().rounded(6)
      .cursor_pointer().text_color(t.foreground).hover((st) => st.bg(t.hover)).on_click(() => { done(); action(); }).child(label);
    const actions = {
      "Rename": () => run("tab.rename", { id: tab }),
      "New tab": () => run("tab.new", { space }),
      "Close": () => run("tab.close", { id: tab }),
    };
    return v_flex().size_full().p(MENU.pad).bg(t.popover ?? t.chrome).text_size(12.5)
      .child(h_flex().h(MENU.swatches).flex_none().px(6).gap(6).items_center().children([null, ...CHAT_COLORS].map(swatch)))
      .child(div().h(1).mx(2).my(4).flex_none().bg(t.border))
      .children(MENU_ITEMS.map((label) => item(label, actions[label])));
  }
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.chatMenu) {
      this.chatMenu = p;
      return;
    }
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.drop = null; // the machine a pressed space would be moved to, when let go over its group
    this.dragging = false; // a pressed space has been moved: the sidebar shows it is being carried
    this.pressedTab = null; // the chat (tab) pressed, when it is a chat that is carried rather than its space
    this.teleport = false; // whether the mod that moves it is installed
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    // Spaces folded to their one row: their tabs hidden, their count and most urgent status on it.
    try { this.foldedSpaces = new Set(JSON.parse(localStorage.getItem("spaces.folded") ?? "[]")); } catch { this.foldedSpaces = new Set(); }
    // Chats' colors from before a restart, for the menu and the rows to share.
    if (!shared(CHAT_KEY)) {
      try {
        const kept = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "{}");
        if (kept && typeof kept === "object" && !Array.isArray(kept)) setShared(CHAT_KEY, kept);
      } catch {}
    }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      try { this.teleport = (await readTextFile(`${appHome()}/mods/${TELEPORT}/main.js`)) !== null; } catch { this.teleport = false; }
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      this.activeAt = rows.findIndex(r => r.w.active);
      return rows.map(draw);
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      // The machine stands out from its spaces: its mark and name bright, every group but the first set apart.
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(14).flex_none().text_color(t.foreground);
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      // A space from this computer, carried over this machine's header or its spaces, moves here when let go.
      const head = h_flex().id(`machine-${m ?? "local"}`).h(30).flex_none().px(collapsed ? 0 : 8).gap(8).items_center().text_size(12).text_color(t.muted)
        .when(Boolean(m) && !collapsed, el => el.mt(10))
        .when(this.drop !== null && this.drop === m, el => el.rounded(6).bg(t.selected).text_color(t.foreground))
        .on_mouse_move((_e, cx) => this.carry(null, m, cx))
        .on_mouse_up("left", (_e, cx) => this.letGo(null, m, cx))
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .when(!this.dragging, el => el.cursor_pointer()).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().font_semibold().text_color(t.foreground).child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const items = [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
      const first = folded ? -1 : mine.findIndex(r => r.w.active);
      if (first >= 0) this.activeAt = before + 1 + guidance.length + first;
      before += items.length;
      return items;
    });
  }

  // Only what's unusual, after the name: "spike \u21912 \u21931", all dim: none of it needs you.
  // The repo goes (the space's name says which one it is), so do master/main and a branch
  // the name already says (a worktree is named after its branch). The name keeps its width;
  // the branch gets what is left and gives way first.
  gitTail(g, name, t) {
    const key = (a) => a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const raw = g.branch ?? "detached";
    const branch = key(raw) === key(name) || raw === "master" || raw === "main" ? "" : raw;
    return h_flex()
      .flex_1()
      .when(Boolean(branch), (el) => el.min_w(SIDE_MIN))
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(branch), (el) => el.child(div().min_w(0).truncate().child(branch)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().child(`\u2193${g.behind}`)));
  }

  // Working: a spinner; needs you: a pill; done: a dot; idle: a ring.
  status(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return null;
  }

  // Live sub-agents of `addr`, depth first, with how deep each is.
  kids(addr, depth = 1) {
    return this.terms.filter((k) => k.parent === addr && k.state === "live")
      .flatMap((k) => [{ k, depth }, ...this.kids(k.address, depth + 1)]);
  }

  // One tab of space `w`: its lead agent's icon, its title, its status. The shown tab is highlighted.
  tabRow(w, c, t) {
    const mine = this.ps.filter((p) => p.tab === c.id && p.terminal);
    const lead = mine.find((p) => p.program?.agent) ?? mine[0];
    const shown = w.active && c.active;
    const color = chatColors()[c.id];
    const muted = color === "muted";
    const text = muted ? t.dim : shown ? t.foreground : t.muted;
    const pic = programIcon(lead?.program, 14, text);
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex()
      .id(`tab-${c.id}`)
      .relative()
      .pl(TAB_INSET)
      .pr(8)
      .h(28)
      .flex_none()
      .gap(8)
      .items_center()
      .rounded(8)
      .text_size(12.5)
      .when(shown, (el) => el.bg(t.selected))
      .when(!shown, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.dragging && this.pressedTab === c.id, (el) => el.opacity(0.5))
      // A chat is carried on its own: never among its space's neighbours, only onto another machine.
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count === 2) { run("tab.rename", { id: c.id }); return; }
        this.pressed = w.id;
        this.pressedTab = c.id;
      })
      .on_click(() => {
        if (!w.active) run("space.select", { id: w.id });
        run("tab.select", { id: c.id });
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); ChatMenu.open(c.id, w.id); })
      // The color: a bar left of the icon.
      .when(Boolean(color) && !muted, (el) => el.child(div().absolute().left(TAB_INSET - 10).top(7).w(3).h(14).rounded(2).bg(MARK[color] ?? t[color])))
      .child(pic ?? div().size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(text).child(c.zoomed ? `${tabLabel(c, lead)} Z` : tabLabel(c, lead)))
      .child(this.status(t, c.status) ?? div());
  }

  subRow(s, t) {
    const { k, depth } = s;
    const pic = programIcon(k.program, 13, t.muted);
    const paned = this.ps.some((p) => p.terminal === k.address);
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(TAB_INSET + 22 * depth)
      .pr(8)
      .h(26)
      .flex_none()
      .gap(8)
      .items_center()
      .rounded(8)
      .text_size(12)
      .hover((el) => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run(paned ? "pane.focus" : "terminal.peek", { terminal: k.address }))
      .child(pic ?? div().size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, kidStatus(k.status)) ?? div());
  }

  // A space's tabs, each followed by its agents' sub-agents.
  tabRows(w, t) {
    return (w.tabs ?? []).flatMap((c) => {
      const leads = this.ps.filter((p) => p.tab === c.id && p.terminal && p.program?.agent);
      return [this.tabRow(w, c, t), ...leads.flatMap((p) => this.kids(p.terminal)).map((s) => this.subRow(s, t))];
    });
  }

  // Whether the space being carried may be let go on machine m: one from this computer, onto another
  // machine that is connected over ssh, with the teleport mod installed to move it.
  droppable(m) {
    const source = spaces().find(s => s.id === this.pressed);
    const machine = this.machines.find(k => k.name === m);
    return this.teleport && Boolean(m) && Boolean(source) && !source.machine && machine?.state === "connected" && !machine.via;
  }

  // The pointer moved over a space row (w) or a machine's header (w null) of machine m while a space is
  // pressed: among its own machine's spaces it shows where it would land; over another machine's group,
  // that machine lights up when the space can move there.
  carry(w, m, cx) {
    if (this.pressed === null) return;
    const source = spaces().find(s => s.id === this.pressed);
    const over = w && source && this.pressedTab === null && (source.machine ?? null) === m ? w.id : null;
    const drop = (source?.machine ?? null) !== m && this.droppable(m) ? m : null;
    if (this.over !== over || this.drop !== drop || !this.dragging) {
      this.over = over;
      this.drop = drop;
      this.dragging = true;
      cx.notify();
    }
  }

  // Letting go over a space row (w) or a machine's header (w null) of machine m: a move to that machine,
  // a new place among its own machine's spaces, or a press that shows the space.
  letGo(w, m, cx) {
    const { pressed: from, pressedTab: tab, over, drop } = this;
    this.pressed = null;
    this.pressedTab = null;
    this.over = null;
    this.drop = null;
    this.dragging = false;
    if (from !== null && drop !== null && drop === m) {
      openOverlay({ mod: TELEPORT, kind: "dialog", width: 440, height: 190, props: { space: from, ...(tab ? { tab } : {}), machine: m } });
    } else if (tab !== null) {
      // A chat let go anywhere else: its press was a click, which the chat's own row answers.
    } else if (w && from !== null && over === w.id && from !== w.id) {
      const index = spaces().findIndex(s => s.id === w.id);
      if (index !== -1) run("space.move", { id: from, index: index + 1 });
    } else if (w && from === w.id) run("space.select", { id: w.id });
    cx.notify();
  }

  fold(id, cx) {
    this.foldedSpaces.has(id) ? this.foldedSpaces.delete(id) : this.foldedSpaces.add(id);
    const ids = new Set(spaces().map((s) => s.id));
    localStorage.setItem("spaces.folded", JSON.stringify([...this.foldedSpaces].filter((k) => ids.has(k))));
    cx.notify();
  }

  row({ w, i, g, tree }, t) {
    const folded = this.foldedSpaces.has(w.id);
    const hovered = this.hoverSpace === w.id;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const badge = w.status === "idle" ? null : this.status(t, w.status);
    // The space and its tabs are one group: it drags, and shows where a dragged space lands, as one.
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .flex_none()
      .pb(4)
      .when(this.pressed === w.id && this.pressedTab === null && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => this.carry(w, w.machine ?? null, cx))
      .on_mouse_up("left", (_e, cx) => this.letGo(w, w.machine ?? null, cx))
      .child(
        h_flex()
          .id(`space-head-${w.id}`)
          .px(8)
          .h(rowHeight({ tree }))
          .flex_none()
          .rounded(8)
          .gap(9)
          .items_center()
          .when(folded && w.active, (el) => el.bg(t.selected))
          .when(!(folded && w.active), (el) => el.hover((s) => s.bg(t.hover)))
          .on_mouse_down("right", () => this.menu(w))
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).when(w.active, el => el.font_medium()).child(w.name))
          .child(g ? this.gitTail(g, w.name, t) : div().flex_1())
          .on_hover((on, cx) => {
            if (on) this.hoverSpace = w.id;
            else if (this.hoverSpace === w.id) this.hoverSpace = null;
            cx.notify();
          })
          // Folded: how many tabs, and their most urgent status unless all are idle.
          .when(folded, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(w.tabs?.length ?? 0)))
            .when(Boolean(badge), el => el.child(badge)))
          // On hover, a new tab in this space: the menu that starts a terminal or an agent.
          .when(hovered, el => el.child(div().id(`space-tab-new-${w.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(6)
            .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(() => {
              if (!w.active) run("space.select", { id: w.id });
              openOverlay({ mod: "selan-new-menu", kind: "popup", width: 250, height: 512 });
            })
            .child(svg("mods/workspace-chrome/plus.svg").size(12))))
          // Fold the space to its one row, or open it again: shown on hover, and always while folded.
          .when(hovered || folded, el => el.child(div().id(`space-fold-${w.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(6)
            .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.fold(w.id, cx))
            .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12)))),
      )
      .children(folded ? [] : this.tabRows(w, t));
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    if (this.chatMenu) return ChatMenu.render(t, this.chatMenu.chatMenu, this.chatMenu.overlay);
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    // Read once per render: every host read copies the whole list.
    this.ps = panes();
    this.terms = terminals();
    const list = this.grouped(t, collapsed);
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        // Carrying a space: the pointer says so over the whole list.
        .when(this.dragging, el => el.cursor_grabbing())
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.pressedTab = null; this.drop = null; this.dragging = false; cx.notify(); })
        .children(list));
  }
}

// The status bar: the machine, the branch, the agents here and how many need you, then what Selan
// Reactor's agents are doing (runs going; runs in the last 24 h that went wrong, or ended with a warning)
// and the palette key.
// Opened as a popup with props { list, runs } it is the list behind one of those two counts; pressing a run
// opens its page in Reactor, in the browser (selan 1.33.1 and later say where that is).
// The runs come from the Selan CLI (`selan reactor runs --json`), which holds the person's sign-in.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, openOverlay, closeOverlay, props, checking, shared, setShared } from "herdr";

const PERIOD_MS = 60_000;
// Reactor's mark, as the Reactor panel draws it.
const LOGO = "mods/selan-reactor/reactor.svg";
const OLD = "This selan has no `selan reactor runs`: it needs selan 1.33 or later. Run selan update.";
// The most a popup lists; Reactor itself has the rest.
const SHOWN = 10;
// The popup's parts are fixed heights, so it is exactly as tall as what it holds and never scrolls:
// the title, then each row (its padding, the agent, `state · age`, an error's line) and a divider between rows.
// Like the new menu, the list sets its own height and the overlay gets room to spare, which it shrinks to.
const POPUP = { width: 340, title: 37, gap: 10, line: 17, sub: 15, room: 40 };
// Herdr's popup frame: a 1 px border above and below what the mod draws.
const FRAME = 2;
// Which list's popup is open, its overlay id, and when the last one closed: one popup at a time.
const OPEN = "selan-status.popup";
// A press on a count right after its popup closed is the press that closed it (a click outside does).
const JUST_CLOSED_MS = 400;
// What Reactor's own pages call each state.
const WORD = { queued: "queued", provisioning: "starting", running: "running", succeeded: "succeeded", failed: "failed", timed_out: "timed out", lost: "lost", unprovisioned: "never started" };
// Each list: what `selan reactor runs --json` calls it, and its popup's title.
const TITLE = { running: "Running", wentWrong: "Errors · last 24 h", warnings: "Warnings · last 24 h" };

/** The Selan CLI, run as the person: one JSON object out, never a throw. */
class Selan {
  static async runs() {
    let r;
    try {
      r = await exec("selan", ["reactor", "runs", "--json"], { timeout: PERIOD_MS });
    } catch (err) {
      return { error: `selan did not run (${String(err?.message ?? err)}). Is the Selan CLI installed and on PATH?` };
    }
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      return { error: OLD };
    }
    // A selan before 1.33 has `reactor` but not `runs`, and answers with its usage.
    return typeof out.error === "string" && out.error.startsWith("usage:") ? { error: OLD } : out;
  }
}

/** How long ago, in the largest whole unit: `now`, `5m`, `3h`, `2d`. */
class Age {
  static since(iso, now) {
    const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }
}

/** The list behind a count: each run's agent, then `state · age`, and an error's own words under it.
 *  A run with a page in Reactor is pressed as a whole row; one without stays plain. */
class RunList {
  /** Pressing a count opens its list, or closes it when it is the one open; another list's popup closes first. */
  static toggle(list, runs) {
    const open = shared(OPEN);
    if (open?.id) {
      closeOverlay(open.id);
      setShared(OPEN, { list: open.list, closedAt: Date.now() });
      if (open.list === list) return;
    } else if (open?.list === list && Date.now() - (open.closedAt ?? 0) < JUST_CLOSED_MS) {
      return;
    }
    RunList.open(list, runs);
  }

  static open(list, runs) {
    const shown = runs.slice(0, SHOWN);
    const height = RunList.height(list, shown);
    // Just above the status bar, at its right; at the pointer when the window cannot say how big it is.
    let at;
    try {
      const size = globalThis.window.viewport_size();
      at = { x: size.width - POPUP.width - 10, y: size.height - 28 - (height + FRAME) - 6 };
    } catch {
      at = undefined;
    }
    const id = openOverlay({ mod: "selan-status", kind: "popup", width: POPUP.width, height: height + POPUP.room, ...(at ? { at } : {}), props: { list, runs: shown } });
    setShared(OPEN, { id, list });
  }

  /** A row's press: the run's page in the browser, and the popup closes. */
  static press(cx, url, overlay) {
    cx.open_url(url);
    closeOverlay(overlay);
  }

  // An error's or a warning's own words go under it; a running run has none yet.
  static says(list, r) {
    return list !== "running" && Boolean(r.line);
  }

  static rowHeight(list, r) {
    return POPUP.gap * 2 + POPUP.line + POPUP.sub + (RunList.says(list, r) ? POPUP.sub : 0);
  }

  static height(list, runs) {
    return POPUP.title + runs.reduce((sum, r) => sum + RunList.rowHeight(list, r), 0) + Math.max(0, runs.length - 1);
  }

  static render(t, list, runs, overlay) {
    const now = Date.now();
    return v_flex().w_full().h(RunList.height(list, runs)).flex_none().bg(t.popover ?? t.chrome).text_size(12.5)
      .child(h_flex().h(POPUP.title).flex_none().px(14).items_center().border_b(1).border_color(t.border)
        .font_semibold().text_color(t.foreground).child(TITLE[list]))
      .children(runs.map((r, i) => v_flex().id(`run-${r.id}`).px(14).py(POPUP.gap).flex_none()
        .when(i > 0, (el) => el.border_t(1).border_color(t.border))
        .when(Boolean(r.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.raised))
          .on_click((_e, cx) => RunList.press(cx, r.url, overlay)))
        .child(div().h(POPUP.line).truncate().text_color(t.foreground).child(r.agent))
        .child(div().h(POPUP.sub).truncate().text_size(11).text_color(t.dim)
          .child(`${list === "wentWrong" && r.state === "succeeded" ? "said it went wrong" : (WORD[r.state] ?? r.state)} · ${Age.since(r.createdAt, now)}`))
        .when(RunList.says(list, r), (el) => el.child(div().h(POPUP.sub).truncate().text_size(11).text_color(t.muted).child(r.line)))));
  }
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.runs) {
      this.popup = p;
      return;
    }
    // A popup from before a restart is gone; its id would make the first press do nothing.
    if (shared(OPEN)) setShared(OPEN, null);
    this.runs = { kind: "loading" };
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(PERIOD_MS, (cx) => this.refresh(cx));
  }

  // The popup going away however it went (Esc, a click outside, a row opening its run, a press on its count).
  async close() {
    if (this.popup && shared(OPEN)?.id === this.popup.overlay) setShared(OPEN, { list: this.popup.list, closedAt: Date.now() });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      const out = await Selan.runs();
      this.runs = out.error
        ? { kind: "failed", reason: out.error }
        // A selan before warnings were listed sends none.
        : { kind: "loaded", running: out.running ?? [], wentWrong: out.wentWrong ?? [], warnings: out.warnings ?? [] };
      cx.notify();
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // Reactor's mark and name, then only what is happening: runs going, runs that went wrong, runs that ended
  // with a warning, a dim "·" between the parts that show. A read that failed leaves the name dim, with why on hover.
  reactor(t) {
    const s = this.runs;
    const group = h_flex().id("reactor").gap(6).items_center().child(image(LOGO).w(13).h(13).rounded(3).flex_none());
    if (s.kind !== "loaded") return group.child(div().text_color(t.dim).child("Reactor")).when(s.kind === "failed", (el) => el.tooltip(s.reason));
    const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const press = (list) => h_flex().id(`reactor-${list}`).gap(5).items_center().cursor_pointer()
      .on_click(() => RunList.toggle(list, s[list]));
    const parts = [
      s.running.length > 0 && press("running").hover((st) => st.text_color(t.foreground))
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
        .child(`${s.running.length} running`),
      s.wentWrong.length > 0 && press("wentWrong").text_color(t.blocked).child(count(s.wentWrong.length, "error")),
      // Amber is the dot's alone: the words stay muted, as warnings do across Selan.
      s.warnings.length > 0 && press("warnings").hover((st) => st.text_color(t.foreground))
        .child(div().size(6).rounded(3).flex_none().bg(t.working))
        .child(count(s.warnings.length, "warning")),
    ].filter(Boolean);
    return group.child("Reactor")
      .children(parts.flatMap((part, i) => (i === 0 ? [part] : [div().text_color(t.dim).child("·"), part])));
  }

  render() {
    const t = theme();
    if (this.popup) return RunList.render(t, this.popup.list, this.popup.runs, this.popup.overlay);
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.canvas).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(this.reactor(t))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}

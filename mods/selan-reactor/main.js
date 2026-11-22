// Selan Reactor questions waiting on you: a panel, the Dock badge, and a toast for each new one.
// Opened as a dialog with props { question } it shows that one question whole, with an answer field.
// Commands: selan-reactor.refresh reads again; selan-reactor.open opens the newest question.
// With props { hide: "<block id>" } from a layout, that block is hidden while no question waits,
// and shown again when one comes or a read fails.
// The questions come from the Selan CLI (`selan reactor questions --json`, `selan reactor answer`),
// which holds the person's sign-in; this mod never sees a token.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { exec, theme, settings, props, run, openOverlay, closeOverlay, notify, playSound, setBadge, checking, nextCommand } from "herdr";

const PERIOD_MS = 60_000;
const ANSWER_CHARS = 2000;
// One space between every part of the panel: header to label, label to row, row to row, last row to the end.
const GAP = 16;
// Reactor's mark: the blue Selan tile, as selan-reactor's Brand.tsx draws it.
const LOGO = "mods/selan-reactor/reactor.svg";

/** The Selan CLI, run as the person: one JSON object out, never a throw. */
class Selan {
  static async run(args, timeout) {
    let r;
    try {
      r = await exec("selan", ["reactor", ...args, "--json"], { timeout });
    } catch (err) {
      return { error: `selan did not run (${String(err?.message ?? err)}). Is the Selan CLI installed and on PATH?` };
    }
    try {
      return JSON.parse(r.stdout);
    } catch {
      // A selan older than `selan reactor` answers "unknown command", which is not JSON.
      return { error: "this selan has no reactor command. Run selan update: it needs selan 1.31 or later." };
    }
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

/** The questions as the helper last read them, and which of them this copy has announced. */
class Feed {
  constructor() {
    this.state = { kind: "loading" };
    this.announced = new Set(JSON.parse(localStorage.getItem("announced") ?? "[]"));
  }

  async load() {
    const out = await Selan.run(["questions"], 60_000);
    this.state = out.error
      ? { kind: "failed", reason: out.error }
      : { kind: "loaded", questions: out.questions ?? [], loadedAt: Date.now() };
  }

  /** The questions not announced yet, now marked announced. */
  takeNew() {
    if (this.state.kind !== "loaded") return [];
    const fresh = this.state.questions.filter((q) => !this.announced.has(q.id));
    this.announced = new Set(this.state.questions.map((q) => q.id));
    localStorage.setItem("announced", JSON.stringify([...this.announced]));
    return fresh;
  }
}

/** Says what is new: one toast, and the Dock badge with the count. */
class Announcer {
  static tell(feed) {
    if (feed.state.kind !== "loaded") return;
    const count = feed.state.questions.length;
    setBadge(count ? String(count) : null);
    const fresh = feed.takeNew();
    if (fresh.length === 0) return;
    playSound("blocked");
    notify(
      fresh.length === 1
        ? { title: `${fresh[0].agent} asks`, body: fresh[0].question, level: "warning", icon: LOGO, action: { name: "selan-reactor.open" } }
        : { title: `${fresh.length} new Reactor questions`, body: fresh.map((q) => q.agent).join(", "), level: "warning", icon: LOGO, action: { name: "selan-reactor.open" } },
    );
  }
}

/** The layout block the panel lives in, when a layout names one: hidden while nothing waits. */
class Hide {
  constructor(block) {
    this.block = block;
    this.applied = null;
  }

  /** Hides when the read found nothing waiting, shows when it found questions or failed.
   *  Only on a change, so a panel the person shows or hides stays until the next one. */
  follow(state) {
    if (!this.block || state.kind === "loading") return;
    const want = state.kind === "loaded" && state.questions.length === 0 ? "hidden" : "shown";
    if (want === this.applied) return;
    this.applied = want;
    run(want === "hidden" ? "layout.hide" : "layout.show", { id: this.block });
  }
}

/** One question whole, and the answer to it: Send resumes the run that asked. */
class AnswerDialog {
  constructor(question, overlay) {
    this.q = question;
    this.long = AnswerDialog.long(question);
    this.overlay = overlay;
    this.state = { kind: "editing" };
    this.input = TextareaState.new({ placeholder: "Your answer", rows: 4 });
    this.input.focus();
  }

  /** Details too long for the dialog to grow around them: about eight lines at its width. */
  static long(q) {
    const details = q.details ?? "";
    return details.length > 560 || details.split("\n").length > 8;
  }

  send(cx) {
    const text = this.input.value().trim();
    if (this.state.kind === "sending" || text.length > ANSWER_CHARS) return;
    this.state = { kind: "sending" };
    cx.notify();
    cx.spawn(async (cx) => {
      const out = await Selan.run(["answer", this.q.id, text], 330_000);
      if (out.error) {
        this.state = { kind: "failed", reason: out.error };
        cx.notify();
        return;
      }
      closeOverlay(this.overlay);
      notify({ title: `Answered ${this.q.agent}`, body: text || "done", level: "success", icon: LOGO });
      run("selan-reactor.refresh");
    });
  }

  render(t) {
    const sending = this.state.kind === "sending";
    const button = (id, label, primary, action) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8)
        .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
        .when(!sending, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
        .when(sending, (el) => el.opacity(0.6))
        .child(label);

    return v_flex()
      .id("rq-dialog")
      .size_full()
      .min_h(0)
      .p(20)
      .gap(16)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .gap(10)
          .child(image(LOGO).w(28).h(28).rounded(8).flex_none())
          .child(
            v_flex()
              .flex_1()
              .gap(3)
              .child(div().text_size(15).line_height("17px").font_semibold().text_color(t.foreground).child(this.q.agent))
              .child(div().text_size(11.5).line_height("13px").text_color(t.dim).child(`${this.q.workspace} · ${Age.since(this.q.askedAt, Date.now())}`)),
          )
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(div().font_medium().text_color(t.foreground).child(this.q.question))
      // Short details: the dialog is as tall as what it holds. Long ones scroll in a dialog of fixed height.
      .child(this.long
        ? div().flex_1().min_h(0).overflow_y_scrollbar().text_color(t.muted).child(this.q.details)
        : div().text_color(t.muted).child(this.q.details))
      .child(
        Textarea.new(this.input).px(10).py(8).rounded(9).border_1().border_color(t.input)
          .bg(t.background).text_size(12.8).text_color(t.foreground),
      )
      .when(this.state.kind === "failed", (el) =>
        el.child(div().text_size(12).text_color(t.blocked).child(`Not sent: ${this.state.reason}`)),
      )
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(button("rq-cancel", "Cancel", false, () => closeOverlay(this.overlay)))
          .child(button("rq-send", sending ? "Sending…" : "Send", true, (_e, cx) => this.send(cx))),
      );
  }
}

/** The panel: newest first, each row its question and one muted line under it. */
class QuestionList {
  static render(t, state) {
    const body =
      state.kind === "loading"
        ? [QuestionList.note(t, "Reading Reactor…")]
        : state.kind === "failed"
          ? [QuestionList.note(t, `Could not read Reactor: ${state.reason}`)]
          : state.questions.length === 0
            ? [QuestionList.note(t, "No questions waiting.")]
            : state.questions.map((q, i) => QuestionList.row(t, q, state.loadedAt, i === 0));
    const count = state.kind === "loaded" ? state.questions.length : 0;

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(
        h_flex()
          .px(16)
          .h(52)
          .flex_none()
          .items_center()
          .gap(10)
          .border_b(1)
          .border_color(t.border)
          // Reactor's brand: the mark, then "Selan" over a small mono REACTOR tag.
          .child(image(LOGO).w(24).h(24).rounded(7).flex_none())
          .child(
            v_flex()
              .flex_1()
              // Reactor's Brand.module.css: each line as tall as its type, 3 px between.
              .gap(3)
              .child(div().text_size(14).line_height("15px").font_bold().text_color(t.foreground).child("Selan"))
              .child(div().text_size(9).line_height("9px").font_semibold().font_family(settings().font_family).text_color(t.muted).child("REACTOR")),
          ),
      )
      .child(
        h_flex()
          .px(16)
          .pt(GAP)
          .flex_none()
          .items_center()
          .justify_between()
          .text_size(11.5)
          .font_medium()
          .text_color(t.dim)
          .child("Waiting questions")
          .when(count > 0, (el) => el.child(String(count))),
      )
      .child(v_flex().id("rq-list").flex_1().min_h(0).overflow_y_scrollbar().children(body));
  }

  static row(t, q, loadedAt, isFirst) {
    return v_flex()
      .id(`rq-${q.id}`)
      .px(16)
      .py(GAP)
      .gap(6)
      .when(!isFirst, (el) => el.border_t(1).border_color(t.border))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => QuestionList.open(q))
      .child(div().text_color(t.foreground).child(q.question))
      .child(div().text_size(11.5).text_color(t.dim).child(`${q.agent} · ${q.workspace} · ${Age.since(q.askedAt, loadedAt)}`));
  }

  static open(q) {
    openOverlay({ mod: "selan-reactor", kind: "dialog", width: 560, ...(AnswerDialog.long(q) ? { height: 520 } : {}), props: { question: q } });
  }

  static note(t, text) {
    return div().px(16).py(GAP).text_size(12).text_color(t.dim).child(text);
  }
}

export default class Reactor extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.question) {
      this.dialog = new AnswerDialog(p.question, p.overlay);
      return;
    }
    this.feed = new Feed();
    this.hide = new Hide(p.hide ?? null);
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(PERIOD_MS, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        // The newest question: what a toast's click opens.
        if (command === "open" && this.feed.state.kind === "loaded" && this.feed.state.questions[0]) {
          QuestionList.open(this.feed.state.questions[0]);
        }
      }
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      await this.feed.load();
      Announcer.tell(this.feed);
      this.hide.follow(this.feed.state);
      cx.notify();
    });
  }

  render(_cx) {
    const t = theme();
    return this.dialog ? this.dialog.render(t) : QuestionList.render(t, this.feed.state);
  }
}

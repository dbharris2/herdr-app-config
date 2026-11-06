import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, shared } from "herdr";
import { agenda } from "./agenda.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.events = []; this.loading = false; this.linkedAt = shared("calendar.linkedAt");
    this.refresh(cx);
    cx.timer.every(300000, cx => this.refresh(cx));
    cx.timer.every(60000, cx => cx.notify());
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        this.events = (await agenda()).events || [];
      } catch { /* Keep the last successful result until the next refresh. */ }
      finally { this.loading = false; cx.notify(); }
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

  render(cx) {
    if (this.linkedAt !== shared("calendar.linkedAt")) { this.linkedAt = shared("calendar.linkedAt"); this.refresh(cx); }
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const now = Date.now();
    const current = this.events.find(e => !e.allDay && new Date(e.start).getTime() <= now && new Date(e.end).getTime() > now);
    const next = current || this.events.find(e => !e.allDay && new Date(e.start).getTime() > now);
    const start = next && new Date(next.start);
    const time = start && `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][start.getDay()]} ${start.getHours() % 12 || 12}:${String(start.getMinutes()).padStart(2, "0")} ${start.getHours() < 12 ? "AM" : "PM"}`;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(next), el => el.child(h_flex().id("next-meeting").min_w(0).gap(6).px(6).rounded(4).items_center().bg(current ? t.selected : t.chrome).text_color(current ? t.accent : t.muted).on_click(() => { run("layout.select", { stack: "panel-body", child: "calendar" }); run("layout.show", { id: "panel" }); })
        .child(svg("mods/workspace-chrome/clock.svg").size(13)).child(div().max_w(260).truncate().child(`${current ? "Now" : time} · ${next.title}`))))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, theme, setShared, props } from "herdr";
import { agenda, invalidateAgenda } from "./agenda.js";
import Status from "./status.js";

function eventTime(event) {
  if (event.allDay) return "All day";
  const start = new Date(event.start), end = new Date(event.end), hour = start.getHours();
  const time = `${hour % 12 || 12}:${String(start.getMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  const minutes = Math.round((end - start) / 60000);
  if (minutes <= 0) return time;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return `${time} · ${hours ? `${hours}h` : ""}${hours && remainder ? " " : ""}${remainder ? `${remainder}m` : ""}`;
}

export default class Calendar extends View {
  init(_props, cx) {
    if (props()?.status) { this.status = new Status(); this.status.init(_props, cx); return; }
    this.events = []; this.loading = false; this.linked = false; this.error = null; this.day = Math.min(4, Math.max(0, (new Date().getDay() + 6) % 7));
    this.date = new Date().toDateString();
    this.refresh(cx);
    cx.timer.every(300000, cx => this.refresh(cx));
  }
  refresh(cx, force = false) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const data = await agenda(force); this.linked = !data.needsLink; this.events = data.events || []; this.error = null;
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }
  link(cx) {
    cx.spawn(async cx => {
      try {
        const r = await exec("/usr/bin/swift", [appHome() + "/mods/calendar/keychain.swift", "save"], { timeout: 600000 });
        if (r.code === 0) { invalidateAgenda(); this.refresh(cx, true); setShared("calendar.linkedAt", Date.now()); }
        else if (r.code !== 2) this.error = "Could not save the address. Enter a Google Calendar iCal URL.";
      } catch { this.error = "Could not open the Keychain setup."; }
      cx.notify();
    });
  }
  render(cx) {
    if (this.status) return this.status.render(cx);
    const today = new Date();
    if (this.date !== today.toDateString()) {
      this.date = today.toDateString();
      this.day = Math.min(4, Math.max(0, (today.getDay() + 6) % 7));
    }
    const t = theme();
    const days = Array.from({ length: 5 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7 + i); return d; });
    const day = days[this.day], end = new Date(day); end.setDate(end.getDate() + 1);
    const events = this.events.filter(e => new Date(e.start) < end && new Date(e.end) > day);
    const button = (id, text, action) => div().id(id).px(8).py(5).rounded(6).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).on_click(action).child(text);
    return v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(38).px(12).items_center().justify_between().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Calendar"))
        .child(h_flex().gap(4).child(button("link", this.linked ? "Change link" : "Link calendar", (_e, cx) => this.link(cx)))
          .when(this.linked, el => el.child(button("refresh", "Refresh", (_e, cx) => this.refresh(cx, true))))))
      .child(h_flex().px(6).py(6).gap(2).children(days.map((d, i) => {
        const today = d.toDateString() === new Date().toDateString();
        const selected = i === this.day;
        return v_flex().id(`day-${i}`).flex_1().items_center().gap(4).py(3).rounded(6).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.day = i; cx.notify(); })
          .child(div().text_size(10).text_color(today ? t.accent : t.muted).child(["MON", "TUE", "WED", "THU", "FRI"][i]))
          .child(div().size(30).flex().items_center().justify_center().rounded(15)
            .bg(today ? t.accent : selected ? t.selected : t.background)
            .text_color(today ? t.accent_foreground : t.foreground).text_size(15).child(String(d.getDate())));
      })))
      .child(v_flex().id("calendar-events").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10).text_size(12)
        .when(this.loading, el => el.child(div().text_color(t.dim).child("Loading…")))
        .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
        .when(!this.loading && !this.linked && !this.error, el => el.child(div().text_color(t.muted).child("Link a Google Calendar secret iCal address to see this week.")))
        .when(!this.loading && this.linked && !events.length && !this.error, el => el.child(div().text_color(t.dim).child("No events on this day.")))
        .children(events.map((event, i) => v_flex().id(`event-${i}`).gap(3)
          .child(div().text_color(t.muted).child(eventTime(event)))
          .child(div().text_color(t.foreground).child(event.title)))));
  }
}

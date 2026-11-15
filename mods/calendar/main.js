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

// The weekend previews the upcoming workweek.
const selectedDay = date => date.getDay() === 0 || date.getDay() === 6 ? 0 : date.getDay() - 1;
function weekStart(date) {
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + (day.getDay() === 0 ? 1 : day.getDay() === 6 ? 2 : 1 - day.getDay()));
  return day;
}

const HOUR_HEIGHT = 64, START_HOUR = 7, END_HOUR = 18;
// Connected overlaps share two columns; further simultaneous events are listed separately.
function arrange(events, day, end) {
  const minutes = (value, isEnd) => {
    const date = new Date(value);
    if (date <= day) return 0;
    if (date >= end) return 1440;
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  };
  const sorted = events.map((event, index) => ({ event, index, start: minutes(event.start), end: minutes(event.end, true) }))
    .map(item => ({ ...item, end: Math.max(item.start + 1, item.end) }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const shown = [], extra = [];
  let cluster = [], clusterEnd = -1;
  const finish = () => {
    if (!cluster.length) return;
    const ends = [-1, -1], placed = [];
    for (const item of cluster) {
      const column = ends.findIndex(value => value <= item.start);
      if (column < 0) { extra.push(item); continue; }
      ends[column] = item.end; placed.push({ ...item, column });
    }
    const two = placed.some(a => placed.some(b => a !== b && a.start < b.end && b.start < a.end));
    for (const item of placed) shown.push({ ...item, two });
    cluster = [];
  };
  for (const item of sorted) {
    if (cluster.length && item.start >= clusterEnd) finish();
    if (!cluster.length) clusterEnd = item.end;
    else clusterEnd = Math.max(clusterEnd, item.end);
    cluster.push(item);
  }
  finish();
  return { shown, extra };
}

export default class Calendar extends View {
  init(_props, cx) {
    if (props()?.status) { this.status = new Status(); this.status.init(_props, cx); return; }
    this.events = []; this.loading = false; this.linked = false; this.error = null; this.day = selectedDay(new Date());
    this.date = new Date().toDateString();
    this.refresh(cx);
    cx.timer.every(300000, cx => this.refresh(cx));
    cx.timer.every(60000, cx => cx.notify());
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
      this.day = selectedDay(today);
    }
    const t = theme();
    const days = Array.from({ length: 5 }, (_, i) => { const d = weekStart(today); d.setDate(d.getDate() + i); return d; });
    const day = days[this.day], end = new Date(day); end.setDate(end.getDate() + 1);
    const events = this.events.filter(e => new Date(e.start) < end && new Date(e.end) > day);
    const allDay = events.filter(e => e.allDay), timed = events.filter(e => !e.allDay);
    const arranged = arrange(timed, day, end);
    const shown = arranged.shown.filter(item => item.start < END_HOUR * 60 && item.end > START_HOUR * 60);
    const outside = arranged.shown.filter(item => item.start >= END_HOUR * 60 || item.end <= START_HOUR * 60);
    const extra = arranged.extra;
    const nowMinutes = today.getHours() * 60 + today.getMinutes();
    const showNow = day.toDateString() === today.toDateString() && nowMinutes >= START_HOUR * 60 && nowMinutes <= END_HOUR * 60;
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
      .when(Boolean(this.error), el => el.child(div().px(12).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .when(!this.loading && !this.linked && !this.error, el => el.child(div().p(12).text_size(12).text_color(t.muted).child("Link a Google Calendar secret iCal address to see this week.")))
      .when(this.loading && !this.linked, el => el.child(div().p(12).text_size(12).text_color(t.dim).child("Loading…")))
      .when(allDay.length > 0 || extra.length > 0 || outside.length > 0, el => el.child(v_flex().px(8).pb(6).gap(3).text_size(11)
        .children(allDay.map((event, i) => div().id(`all-day-${i}`).px(8).py(4).rounded(5).bg(t.selected).text_color(t.foreground).tooltip(event.title).child(event.title)))
        .children(outside.map(item => div().id(`outside-${item.index}`).px(8).py(4).rounded(5).bg(t.raised).text_color(t.muted).tooltip("Outside the displayed hours").child(`${eventTime(item.event)} · ${item.event.title}`)))
        .children(extra.map(item => div().id(`extra-${item.index}`).px(8).py(4).rounded(5).bg(t.raised).text_color(t.muted).tooltip("Additional overlapping event").child(`+ ${eventTime(item.event)} · ${item.event.title}`)))))
      .when(this.linked, el => el.child(v_flex().id("calendar-grid").flex_1().min_h(0).relative().overflow_y_scrollbar()
        .children(Array.from({ length: END_HOUR - START_HOUR }, (_, index) => { const hour = index + START_HOUR; return h_flex().id(`hour-${hour}`).h(HOUR_HEIGHT).flex_none().items_start()
          .child(div().w(46).flex_none().pr(6).text_right().text_size(10).text_color(t.dim).child(`${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`))
          .child(div().flex_1().h_full().border_t(1).border_color(t.border)); }))
        .child(h_flex().h(20).flex_none().child(div().w(46).pr(6).text_right().text_size(10).text_color(t.dim).child("6 PM")).child(div().flex_1().border_t(1).border_color(t.border)))
        .child(div().absolute().left(48).right(8).top(0).h(HOUR_HEIGHT * (END_HOUR - START_HOUR))
          .children(shown.map(item => v_flex().id(`event-${item.index}`).absolute().top((Math.max(item.start, START_HOUR * 60) - START_HOUR * 60) * HOUR_HEIGHT / 60).h(Math.max(20, (Math.min(item.end, END_HOUR * 60) - Math.max(item.start, START_HOUR * 60)) * HOUR_HEIGHT / 60 - 2))
            .left(item.two && item.column === 1 ? "50%" : 0).w(item.two ? "50%" : "100%").px(6).py(3).rounded(5).overflow_hidden().bg(t.accent).text_color(t.accent_foreground)
            .tooltip(`${item.event.title} · ${eventTime(item.event)}`)
            .child(div().text_size(11).font_semibold().truncate().child(item.event.title))))
          .when(showNow, el => el.child(div().id("current-time").absolute().left(0).right(0).top((nowMinutes - START_HOUR * 60) * HOUR_HEIGHT / 60).h(2).bg("#ff5f57")
            .child(div().absolute().left(0).top(-3).size(8).rounded(4).bg("#ff5f57")))))));
  }
}

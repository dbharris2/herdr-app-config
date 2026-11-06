import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Classify by common repository conventions; each file belongs to one category.
function category(path) {
  const p = path.toLowerCase(), name = p.split("/").pop();
  if (/(^|\/)(__generated__|generated|gen|dist|coverage|vendor)(\/|$)/.test(p) || /(?:^|\/)drizzle\/(?:meta\/|\d{4}_[^/]+\.sql$)/.test(p) || /(?:\.generated\.|\.min\.|\.gen\.ts$)/.test(name) || /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock)$/.test(name)) return "Generated";
  if (/(^|\/)(__tests__|tests?|specs?|fixtures?|__fixtures__)(\/|$)/.test(p) || /(?:^|[._-])(?:test|spec)\.[^.]+$/.test(name) || /_test\.[^.]+$/.test(name)) return "Tests";
  if (/(^|\/)(?:stories|storybook|\.storybook)(\/|$)/.test(p) || /\.(?:stories|story)\.[^.]+$/.test(name)) return "Stories";
  if (/(^|\/)(?:docs?|documentation)(\/|$)/.test(p) || /\.(?:md|mdx|rst|adoc|txt)$/.test(name)) return "Documentation";
  return "Implementation";
}

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.totals = null; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.showTotal = localStorage.getItem("changes.showTotal") === "true";
    this.sectionOpen = {};
    this.input = InputState.new({ placeholder: "Change description" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => {
      if (location().on || !this.watched) this.refresh(cx);
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { if (this.watched === root) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.totals = null; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    const before = JSON.stringify([this.root, this.files, this.totals, this.groupCounts, this.limited, this.error, this.open, this.rows]);
    cx.spawn(async (cx) => {
      try {
        const top = await exec("jj", ["--color=never", "root"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.totals = null; this.setLines([]); this.open = null; this.error = "Not a Jujutsu repository"; return; }
        const root = top.stdout.trim();
        const status = await exec("jj", ["--color=never", "diff", "--summary"], { cwd: root, on });
        if (status.code !== 0) throw new Error(status.stderr);
        // Use structured statistics after the summary snapshots the working copy.
        const template = 'self.diff().stat().files().map(|f| json({"path" => f.path(), "status" => f.status_char(), "add" => f.lines_added(), "del" => f.lines_removed()}) ++ "\\n").join("")';
        const stat = await exec("jj", ["--ignore-working-copy", "--no-pager", "--color=never", "log", "-r", "@", "--no-graph", "-T", template], { cwd: root, on });
        if (stat.code !== 0) throw new Error(stat.stderr || "Cannot read diff statistics");
        const entries = stat.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
        const totals = {}, groupCounts = {};
        for (const file of entries) {
          const type = category(file.path);
          groupCounts[type] = (groupCounts[type] || 0) + 1;
          for (const key of ["Total", type]) {
            totals[key] ??= { add: 0, del: 0 };
            totals[key].add += file.add; totals[key].del += file.del;
          }
        }
        totals.Total ??= { add: 0, del: 0 };
        totals.Implementation ??= { add: 0, del: 0 };
        const files = entries.slice(0, 1000);
        if (key() !== context) return;
        this.root = root; this.on = on; this.files = files; this.totals = totals; this.groupCounts = groupCounts; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = (files.find(f => category(f.path) === "Implementation") || files[0]).path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        const after = JSON.stringify([this.root, this.files, this.totals, this.groupCounts, this.limited, this.error, this.open, this.rows]);
        if (before !== after) cx.notify();
      }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    const r = await exec("jj", ["--color=never", "diff", "--git", "--", path], { cwd: root, on });
    if (r.code !== 0) throw new Error(r.stderr);
    const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    const lines = first < 0 ? ["No text diff available"] : all.slice(first);
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("jj", ["commit", "-m", message], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const count = this.totals && this.totals[this.showTotal ? "Total" : "Implementation"];
    const breakdown = this.totals && ["Implementation", "Tests", "Documentation", "Stories", "Generated", "Total"].filter(k => this.totals[k]).map(k => `${k}: +${this.totals[k].add} −${this.totals[k].del}`).join("\n");
    const filtered = this.totals && (this.totals.Total.add !== this.totals.Implementation.add || this.totals.Total.del !== this.totals.Implementation.del);
    const groups = ["Implementation", "Tests", "Documentation", "Stories", "Generated"].map(name => ({ name, files: this.files.filter(f => category(f.path) === name) })).filter(g => g.files.length);
    const groupOpen = name => this.sectionOpen[name] ?? (name === "Implementation" || (!groups.some(g => g.name === "Implementation") && name === groups[0]?.name));
    const listHeight = groups.reduce((n, g) => n + 28 + (groupOpen(g.name) ? g.files.length * 28 : 0), 12);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .when(Boolean(count), el => el.child(h_flex().id("changes-line-count").gap(5).items_center().cursor_pointer().rounded(4).hover(s => s.bg(t.hover))
          .tooltip(`${breakdown}\nClick to show ${this.showTotal ? "implementation" : "total"} line counts`)
          .on_click((_e, cx) => { this.showTotal = !this.showTotal; localStorage.setItem("changes.showTotal", String(this.showTotal)); cx.notify(); })
          .child(div().text_size(10).text_color(t.muted).child(this.showTotal ? "All" : "Impl"))
          .child(div().text_size(11).text_color(t.ansi2).child(`+${count.add}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${count.del}`))
          .when(!this.showTotal && filtered, e => e.child(div().text_size(11).text_color(t.muted).child("*"))))))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, listHeight))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(groups.flatMap(group => {
        const open = groupOpen(group.name), stats = this.totals?.[group.name];
        const header = h_flex().id(`changes-group-${group.name}`).h(28).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer().bg(t.raised).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.sectionOpen[group.name] = !open; cx.notify(); })
          .child(div().text_size(11).text_color(t.muted).child(open ? "▾" : "▸"))
          .child(div().text_size(11).text_color(t.foreground).child(group.name))
          .child(div().text_size(11).text_color(t.dim).child(String(this.groupCounts?.[group.name] ?? group.files.length)))
          .child(div().flex_1())
          .when(Boolean(stats), e => e.child(div().text_size(11).text_color(t.ansi2).child(`+${stats.add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${stats.del}`)));
        const rows = open ? group.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
        }) : [];
        return [header, ...rows];
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No changes in the working copy" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}

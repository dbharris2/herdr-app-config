import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, shared } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
function ansiColor(n, t) {
  if (n < 16) return t[`ansi${n}`] || t.foreground;
  if (n < 232) { n -= 16; const v = x => x ? 55 + x * 40 : 0; return `#${[v(Math.floor(n / 36)), v(Math.floor(n / 6) % 6), v(n % 6)].map(x => x.toString(16).padStart(2, "0")).join("")}`; }
  const v = Math.min(255, 8 + (n - 232) * 10).toString(16).padStart(2, "0"); return `#${v}${v}${v}`;
}
function parseAnsi(text) {
  const lines = [[]]; let color = null, bold = false, dim = false, at = 0;
  const re = /\x1b\[([0-9;]*)m/g; let m;
  const append = s => { for (const [i, part] of s.split("\n").entries()) { if (i) lines.push([]); if (part) lines[lines.length - 1].push({ text: part, color, bold, dim }); } };
  while ((m = re.exec(text))) {
    append(text.slice(at, m.index)); at = re.lastIndex;
    const codes = m[1].split(";").map(x => Number(x));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { color = null; bold = false; dim = false; }
      else if (c === 1) bold = true; else if (c === 2) dim = true; else if (c === 22) { bold = false; dim = false; }
      else if (c === 39) color = null; else if (c >= 30 && c <= 37) color = c - 30; else if (c >= 90 && c <= 97) color = c - 90 + 8;
      else if (c === 38 && codes[i + 1] === 5 && i + 2 < codes.length) { color = codes[i + 2]; i += 2; }
      else if (c === 38 && codes[i + 1] === 2 && i + 4 < codes.length) { color = `#${codes.slice(i + 2, i + 5).map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`; i += 4; }
    }
  }
  append(text.slice(at)); if (!lines[lines.length - 1].length) lines.pop(); return lines;
}
export default class JjLog extends View {
  init(_props, cx) {
    this.lines = []; this.changes = []; this.repositories = []; this.context = null; this.loading = false; this.pending = false;
    this.refresh(cx, true);
    cx.timer.every(30000, cx => this.refresh(cx, true));
  }
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async cx => {
      try {
        while (this.watched === root) {
          const paths = await watchFolder(root);
          if (this.watched !== root) break;
          const worktree = paths.some(p => !p.startsWith(root + "/.jj/") && !p.startsWith(root + "/.git/") && p !== root + "/.jj" && p !== root + "/.git");
          this.refresh(cx, worktree);
        }
      } catch { if (this.watched === root) this.watched = null; }
    });
  }
  refresh(cx, snapshot = false) {
    const context = key(), { cwd, on } = location();
    if (context !== this.context) { this.context = context; this.lines = []; this.changes = []; this.repositories = []; this.error = null; this.watched = null; snapshot = true; }
    if (!cwd) return;
    if (this.loading) { this.pending = true; this.pendingSnapshot ||= snapshot; return; }
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("jj", ["--ignore-working-copy", "root"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.lines = []; this.error = "Not a Jujutsu repository"; return; }
        const root = top.stdout.trim(); this.on = on; this.watch(root, cx);
        const args = ["--no-pager", "--color=always", ...(snapshot ? [] : ["--ignore-working-copy"]), "log"];
        const r = await exec("jj", args, { cwd: root, on });
        if (key() !== context) return;
        if (r.code !== 0) { this.lines = []; this.error = (r.stderr || "Cannot read Jujutsu log").trim(); }
        else {
          this.lines = parseAnsi(r.stdout); this.error = null;
          const [changes, remotes] = await Promise.all([
            exec("jj", ["--ignore-working-copy", "--no-pager", "log", "--no-graph", "-T", 'json({"change" => change_id.short(), "bookmarks" => bookmarks.map(|b| b.name())}) ++ "\\n"'], { cwd: root, on }),
            exec("git", ["--no-optional-locks", "config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: root, on }),
          ]);
          if (key() !== context) return;
          this.changes = changes.code === 0 ? changes.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
          this.repositories = (remotes.stdout ?? "").split("\n").map(line => /(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(line)?.[1]?.toLowerCase()).filter(Boolean);
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false; cx.notify();
        if (this.pending || key() !== context) { const snapshot = this.pendingSnapshot; this.pending = false; this.pendingSnapshot = false; this.refresh(cx, snapshot); }
      }
    });
  }
  render(cx) {
    if (key() !== this.context) this.refresh(cx, true);
    const t = theme();
    const prs = shared("pr-monitor.branches") ?? [];
    const byChange = new Map();
    for (const change of this.changes) {
      const matches = prs.filter(pr => this.repositories.includes(pr.repo) && change.bookmarks.includes(pr.branch));
      if (matches.length) byChange.set(change.change, matches);
    }
    return v_flex().id("jj-log").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(38).flex_none().px(14).items_center().border_b(1).border_color(t.border).text_size(13).font_semibold().child("Jujutsu log"))
      .child(div().id("jj-log-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .children(this.error ? [div().text_color(t.dim).child(this.error)] : this.lines.map((line, i) => {
          const text = line.map(span => span.text).join("");
          const change = this.changes.find(c => new RegExp(`(?:^|\\s)${c.change.slice(0, 8)}[a-z]*\\b`).test(text));
          return h_flex().id(`jj-log-${i}`).whitespace_nowrap().children(line.length ? line.map(span => div().whitespace_nowrap().text_color(typeof span.color === "number" ? ansiColor(span.color, t) : span.color || (span.dim ? t.dim : t.foreground)).when(span.bold, e => e.font_bold()).child(span.text)) : [div().child(" ")])
            .children((byChange.get(change?.change) ?? []).map(pr => div().id(`pr-${i}-${pr.number}`).ml(8).text_color(t.accent).cursor_pointer().tooltip(`Open pull request in ${shared("pr-monitor.destination") === "linear" ? "Linear" : "GitHub"}`).on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(shared("pr-monitor.destination") === "linear" ? pr.url.replace(/^https:\/\/github\.com\//, "https://linear.review/") : pr.url); }).child(`#${pr.number}`)));
        })));
  }
}

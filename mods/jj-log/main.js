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
function category(path) {
  const p = path.toLowerCase(), name = p.split("/").pop();
  if (/(^|\/)(__generated__|generated|gen|dist|coverage|vendor)(\/|$)/.test(p) || /(?:^|\/)drizzle\/(?:meta\/|\d{4}_[^/]+\.sql$)/.test(p) || /(?:\.generated\.|\.min\.|\.gen\.ts$)/.test(name) || /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock)$/.test(name)) return "Generated";
  if (/(^|\/)(__tests__|tests?|specs?|fixtures?|__fixtures__)(\/|$)/.test(p) || /(?:^|[._-])(?:test|spec)\.[^.]+$/.test(name) || /_test\.[^.]+$/.test(name)) return "Tests";
  if (/(^|\/)(?:stories|storybook|\.storybook)(\/|$)/.test(p) || /\.(?:stories|story)\.[^.]+$/.test(name)) return "Stories";
  if (/(^|\/)(?:docs?|documentation)(\/|$)/.test(p) || /\.(?:md|mdx|rst|adoc|txt)$/.test(name)) return "Documentation";
  return "Implementation";
}

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
    this.refresh(cx, true); this.refreshPrs(cx);
    cx.timer.every(30000, cx => { this.refresh(cx, true); this.refreshPrs(cx); });
  }
  refreshPrs(cx) {
    cx.spawn(async cx => {
      try {
        const query = `{ search(query: "is:pr is:open author:@me", type: ISSUE, first: 100) { nodes { ... on PullRequest { number url headRefName headRepository { nameWithOwner } } } } }`;
        const result = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: 30000 });
        if (result.code !== 0) return;
        const data = JSON.parse(result.stdout);
        if (data.errors?.length || !data.data?.search?.nodes) return;
        this.prs = data.data.search.nodes.filter(pr => pr.headRepository?.nameWithOwner && pr.headRefName).map(pr => ({ repo: pr.headRepository.nameWithOwner.toLowerCase(), branch: pr.headRefName, number: pr.number, url: pr.url }));
        cx.notify();
      } catch { /* Keep the last known PR links if GitHub is unavailable. */ }
    });
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
            exec("jj", ["--ignore-working-copy", "--no-pager", "log", "--no-graph", "-T", '"C" ++ json({"change" => change_id.short(), "commit" => commit_id, "mine" => self.contained_in("mine()"), "bookmarks" => bookmarks.map(|b| b.name())}) ++ "\\n" ++ if(self.contained_in("mine()"), self.diff().stat().files().map(|f| "F" ++ json({"path" => f.path(), "add" => f.lines_added(), "del" => f.lines_removed()}) ++ "\\n").join(""))'], { cwd: root, on }),
            exec("git", ["--no-optional-locks", "config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: root, on }),
          ]);
          if (key() !== context) return;
          this.changes = [];
          if (changes.code === 0) for (const line of changes.stdout.split("\n")) {
            if (line.startsWith("C")) this.changes.push({ ...JSON.parse(line.slice(1)), files: [] });
            else if (line.startsWith("F") && this.changes.length) this.changes[this.changes.length - 1].files.push(JSON.parse(line.slice(1)));
          }
          this.repositories = (remotes.stdout ?? "").split("\n").map(line => /(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(line)?.[1]?.toLowerCase()).filter(Boolean);
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false; cx.notify();
        if (this.pending || key() !== context) { const snapshot = this.pendingSnapshot; this.pending = false; this.pendingSnapshot = false; this.refresh(cx, snapshot); }
      }
    });
  }
  edit(change, cx) {
    if (this.editing) return;
    const { cwd, on } = location(), context = key();
    this.editing = change.commit; this.editError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("jj", ["edit", change.commit], { cwd, on });
        if (result.code !== 0) throw new Error(result.stderr || "Could not edit change");
      } catch (e) { if (key() === context) this.editError = String(e); }
      finally { this.editing = false; cx.notify(); this.refresh(cx, true); }
    });
  }
  render(cx) {
    if (key() !== this.context) this.refresh(cx, true);
    const t = theme();
    const prs = [...(this.prs ?? []), ...(shared("pr-monitor.branches") ?? [])].filter((pr, i, all) => all.findIndex(other => other.url === pr.url) === i);
    const byChange = new Map();
    for (const change of this.changes) {
      const matches = prs.filter(pr => this.repositories.includes(pr.repo) && change.bookmarks.includes(pr.branch));
      if (matches.length) byChange.set(change.change, matches);
    }
    return v_flex().id("jj-log").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(38).flex_none().px(14).items_center().border_b(1).border_color(t.border).text_size(13).font_semibold().child("Jujutsu log"))
      .when(Boolean(this.editError), el => el.child(div().px(10).text_size(12).text_color(t.blocked).child(this.editError)))
      .child(div().id("jj-log-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .children(this.error ? [div().text_color(t.dim).child(this.error)] : this.lines.map((line, i) => {
          const text = line.map(span => span.text).join("");
          const change = this.changes.find(c => new RegExp(`(?:^|\\s)${c.change.slice(0, 8)}[a-z]*\\b`).test(text));
          const files = change?.files ?? [];
          const filtered = files.filter(f => category(f.path) === "Implementation");
          const selected = shared("changes.showTotal") ? files : filtered;
          const add = selected.reduce((n, f) => n + f.add, 0), del = selected.reduce((n, f) => n + f.del, 0);
          return h_flex().id(`jj-log-${i}`).whitespace_nowrap().children(line.length ? line.map((span, n) => {
              const idStart = change ? text.indexOf(change.change.slice(0, 8)) : -1;
              const offset = line.slice(0, n).reduce((length, part) => length + part.text.length, 0);
              const idPart = idStart >= 0 && offset >= idStart && offset < idStart + 8;
              return div().id(`span-${i}-${n}`).whitespace_nowrap().text_color(typeof span.color === "number" ? ansiColor(span.color, t) : span.color || (span.dim ? t.dim : t.foreground)).when(span.bold, e => e.font_bold()).when(Boolean(idPart), e => e.cursor_pointer().tooltip("Edit this change").on_hover((on, cx) => { this.hoveredChange = on ? change.commit : null; cx.notify(); }).when(this.hoveredChange === change.commit, e => e.underline()).on_click((_e, cx) => { cx.stop_propagation(); this.edit(change, cx); })).child(span.text);
            }) : [div().child(" ")])
            .when(Boolean(change?.mine), el => el.child(div().ml(8).text_color(t.ansi2).child(`+${add}`)).child(div().ml(5).text_color(t.blocked).child(`−${del}`)).when(!shared("changes.showTotal") && files.length !== filtered.length, el => el.child(div().ml(4).text_color(t.muted).child("*"))))
            .children((byChange.get(change?.change) ?? []).map(pr => div().id(`pr-${i}-${pr.number}`).ml(8).px(5).rounded(4).border_1().border_color(t.accent).text_color(t.accent).cursor_pointer().hover(s => s.bg(t.hover)).tooltip(`Open pull request in ${shared("pr-monitor.destination") === "linear" ? "Linear" : "GitHub"}`).on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(shared("pr-monitor.destination") === "linear" ? pr.url.replace(/^https:\/\/github\.com\//, "https://linear.review/") : pr.url); }).child(`#${pr.number}`)));
        })));
  }
}

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, setShared } from "herdr";

const searches = ["is:pr is:open -is:draft review-requested:@me", "is:pr is:open author:@me", "is:pr is:open -is:draft reviewed-by:@me -author:@me"];
const query = q => `{ search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ... on PullRequest { id number title url isDraft updatedAt repository { nameWithOwner } author { login avatarUrl(size: 64) } reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 64) } ... on Team { slug name avatarUrl(size: 64) } } } } reviewDecision mergeStateStatus additions deletions changedFiles files(first: 100) { nodes { path additions deletions } pageInfo { hasNextPage endCursor } } reviews(last: 100) { nodes { state submittedAt author { login avatarUrl(size: 64) } } } } } } }`;

function approved(pr) {
  const latest = new Map();
  for (const review of pr.reviews?.nodes ?? []) {
    const login = review.author?.login;
    if (!login) continue;
    const previous = latest.get(login);
    if (!previous || !review.submittedAt || !previous.submittedAt || review.submittedAt > previous.submittedAt) latest.set(login, review);
  }
  return [...latest.values()].some(r => r.state === "APPROVED");
}
function group([requested, authored, reviewed]) {
  const sections = { "Needs my review": [], "Changes requested": [], "Approved": [], "Waiting for review": [], "Reviewed": [], "Drafts": [] };
  const changed = pr => pr.reviewDecision === "APPROVED" || pr.reviewDecision === "CHANGES_REQUESTED" || approved(pr);
  sections["Needs my review"] = requested.filter(pr => !changed(pr));
  for (const pr of authored) {
    const section = pr.isDraft ? "Drafts" : pr.reviewDecision === "APPROVED" || (pr.reviewDecision !== "CHANGES_REQUESTED" && approved(pr)) ? "Approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Waiting for review";
    sections[section].push(pr);
  }
  const seen = new Set(sections["Needs my review"].map(pr => pr.id));
  for (const pr of [...reviewed, ...requested.filter(changed)]) if (!seen.has(pr.id)) { seen.add(pr.id); sections.Reviewed.push(pr); }
  return sections;
}
function category(path) {
  const p = path.toLowerCase(), name = p.split("/").pop();
  if (/(^|\/)(__generated__|generated|gen|dist|coverage|vendor)(\/|$)/.test(p) || /(?:^|\/)drizzle\/(?:meta\/|\d{4}_[^/]+\.sql$)/.test(p) || /(?:\.generated\.|\.min\.|\.gen\.ts$)/.test(name) || /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock)$/.test(name)) return "Generated";
  if (/(^|\/)(__tests__|tests?|specs?|fixtures?|__fixtures__)(\/|$)/.test(p) || /(?:^|[._-])(?:test|spec)\.[^.]+$/.test(name) || /_test\.[^.]+$/.test(name)) return "Tests";
  if (/(^|\/)(?:stories|storybook|\.storybook)(\/|$)/.test(p) || /\.(?:stories|story)\.[^.]+$/.test(name)) return "Stories";
  if (/(^|\/)(?:docs?|documentation)(\/|$)/.test(p) || /\.(?:md|mdx|rst|adoc|txt)$/.test(name)) return "Documentation";
  return "Implementation";
}

async function implementation(pr) {
  let page = pr.files;
  if (!page?.nodes || !page.pageInfo) throw new Error("Missing changed-file details");
  const total = { add: 0, del: 0, excluded: false };
  while (true) {
    for (const file of page.nodes) {
      if (category(file.path) === "Implementation") { total.add += file.additions; total.del += file.deletions; }
      else if (file.additions || file.deletions) total.excluded = true;
    }
    if (!page.pageInfo.hasNextPage) return total;
    const cursor = page.pageInfo.endCursor;
    if (!cursor) throw new Error("Missing changed-file cursor");
    const q = `{ node(id: ${JSON.stringify(pr.id)}) { ... on PullRequest { files(first: 100, after: ${JSON.stringify(cursor)}) { nodes { path additions deletions } pageInfo { hasNextPage endCursor } } } } }`;
    const r = await exec("gh", ["api", "graphql", "-f", `query=${q}`], { timeout: 30000 });
    if (r.code !== 0) throw new Error(r.stderr || "Could not load changed files");
    const data = JSON.parse(r.stdout);
    if (data.errors?.length) throw new Error(data.errors[0].message);
    page = data.data?.node?.files;
    if (!page?.nodes || !page.pageInfo) throw new Error("Missing changed-file page");
  }
}
let cached = null, fetchedAt = 0, pending = null;
export async function fetchSections(force = false) {
  if (pending) return pending;
  if (!force && cached && Date.now() - fetchedAt < 300000) return cached;
  pending = (async () => {
    const results = await Promise.all(searches.map(async search => {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${query(search)}`], { timeout: 30000 });
      if (r.code !== 0) throw new Error(r.stderr || "Could not run gh. Check that GitHub CLI is installed and authenticated.");
      const data = JSON.parse(r.stdout);
      if (data.errors?.length) throw new Error(data.errors[0].message);
      if (!data.data?.search?.nodes) throw new Error("Unexpected response from GitHub.");
      return data.data.search.nodes.filter(pr => pr.id);
    }));
    cached = group(results); fetchedAt = Date.now();
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}
function reviewers(pr) {
  const people = new Map();
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const person = request.requestedReviewer;
    if (person?.avatarUrl) people.set(`${person.__typename}:${person.login ?? person.slug}`, person);
  }
  for (const review of pr.reviews?.nodes ?? []) {
    const person = review.author;
    if (person?.avatarUrl && !people.has(`User:${person.login}`)) people.set(`User:${person.login}`, person);
  }
  return [...people.values()];
}
const AVATAR_COLORS = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];
function avatar(person, size) {
  const name = person.login ?? person.slug ?? person.name ?? "?";
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  return h_flex().size(size).rounded(size * 0.28).flex_none().bg(AVATAR_COLORS[hash % AVATAR_COLORS.length]).items_center().justify_center().text_size(size > 20 ? 12 : 9).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?");
}
function avatarGroup(people, t) {
  const shown = people.slice(0, 5);
  return h_flex().flex_none().items_center().gap(3)
    .child(div().relative().w(16 + (shown.length - 1) * 12).h(16).flex_none()
      .children(shown.map((person, i) => div().absolute().left(i * 12).top(0).child(avatar(person, 16)))))
    .when(people.length > shown.length, el => el.child(div().text_size(11).text_color(t.muted).child(`+${people.length - shown.length}`)));
}
function statusColor(pr, t) {
  if (pr.isDraft) return t.dim;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return t.ansi1;
  if (pr.reviewDecision === "APPROVED" || approved(pr)) return t.ansi2;
  return "#f78166";
}
function age(date) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
export default class PRMonitor extends View {
  init(_props, cx) { this.sections = null; this.loading = false; this.error = null; this.folded = new Set(); this.showTotal = localStorage.getItem("pr-monitor.showTotal") === "true"; this.refresh(cx); cx.timer.every(300000, cx => this.refresh(cx)); }
  refresh(cx) {
    if (this.loading) return;
    this.loading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        this.sections = await fetchSections(true); this.error = null;
        setShared("pr-monitor.counts", { review: this.sections["Needs my review"].length, changes: this.sections["Changes requested"].length, approved: this.sections.Approved.length });
        const prs = Object.values(this.sections).flat();
        await Promise.all(prs.map(async pr => {
          try { pr.implementation = await implementation(pr); }
          catch { pr.implementationError = true; }
          cx.notify();
        }));
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }
  render(cx) {
    const t = theme();
    return v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(38).px(12).items_center().justify_between().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Pull requests"))
        .child(h_flex().items_center().gap(5)
          .child(div().id("pr-line-mode").px(8).py(5).rounded(6).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).tooltip(`Showing ${this.showTotal ? "all" : "implementation"} line counts. Click to switch.`).on_click((_e, cx) => { this.showTotal = !this.showTotal; localStorage.setItem("pr-monitor.showTotal", String(this.showTotal)); cx.notify(); }).child(this.showTotal ? "All" : "Impl"))
          .child(div().id("refresh-prs").px(8).py(5).rounded(6).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx)).child(this.loading ? "Refreshing…" : "Refresh"))))
      .child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(6)
        .when(Boolean(this.error), el => el.child(div().p(4).text_size(12).text_color(t.blocked).child(this.error)))
        .when(!this.sections && !this.error, el => el.child(div().p(4).text_size(12).text_color(t.muted).child("Loading pull requests…")))
        .when(Boolean(this.sections) && !Object.values(this.sections ?? {}).some(list => list.length), el => el.child(div().p(4).text_size(12).text_color(t.muted).child("No open pull requests.")))
        .children(Object.entries(this.sections ?? {}).filter(([, prs]) => prs.length).map(([name, prs]) => v_flex().gap(2)
          .child(h_flex().id(`section-${name}`).px(4).py(5).items_center().justify_between().rounded(5).hover(s => s.bg(t.hover)).on_click((_e, cx) => { if (this.folded.has(name)) this.folded.delete(name); else this.folded.add(name); cx.notify(); })
            .child(h_flex().items_center().gap(6).child(svg(`mods/workspace-chrome/chevron-${this.folded.has(name) ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.muted)).child(div().font_semibold().text_size(13).child(name))).child(div().text_size(11).text_color(t.muted).child(String(prs.length))))
          .when(!this.folded.has(name), el => el.children(prs.map(pr => v_flex().id(pr.id).px(8).py(6).gap(3).rounded(5).border_l(3).border_color(statusColor(pr, t)).hover(s => s.bg(t.hover)).on_click(() => { exec("/usr/bin/open", [pr.url]); })
            .child(h_flex().gap(8).items_center()
              .when(Boolean(pr.author?.avatarUrl), el => el.child(avatar(pr.author, 28)))
              .child(div().flex_1().min_w(0).text_size(12).child(pr.title)))
            .child(h_flex().items_center().gap(6).text_size(11).text_color(t.muted)
              .child(h_flex().flex_1().min_w(0).items_center().gap(6)
                .child(div().min_w(0).truncate().child(`${pr.repository.nameWithOwner.split("/").pop()} #${pr.number}`))
                .child(div().flex_none().text_color(t.ansi2).child(this.showTotal ? `+${pr.additions}` : pr.implementation ? `+${pr.implementation.add}` : pr.implementationError ? "—" : "…"))
                .child(div().flex_none().text_color(t.blocked).child(this.showTotal ? `−${pr.deletions}` : pr.implementation ? `−${pr.implementation.del}` : pr.implementationError ? "—" : "…"))
                .when(!this.showTotal && pr.implementation?.excluded, el => el.child(div().flex_none().text_color(t.muted).child("*")))
                .child(h_flex().flex_none().items_center().gap(3).child(svg("mods/files/file.svg").size(12).flex_none()).child(div().child(String(pr.changedFiles))))
                .child(div().flex_none().child(age(pr.updatedAt))))
              .when(reviewers(pr).length > 0, el => el.child(avatarGroup(reviewers(pr), t))))
            .when(pr.mergeStateStatus === "DIRTY", el => el.child(div().text_size(11).text_color(t.blocked).child("Merge conflict")))))))));
  }
}

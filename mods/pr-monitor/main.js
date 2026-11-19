import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, shared, setShared, appHome, checking } from "herdr";

const searches = ["is:pr is:open -is:draft review-requested:@me", "is:pr is:open author:@me", "is:pr is:open -is:draft reviewed-by:@me -author:@me"];
const query = q => `{ viewer { login } search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ... on PullRequest { id number title url isDraft updatedAt headRefName headRepository { nameWithOwner } repository { nameWithOwner } author { login avatarUrl(size: 64) } reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 64) } ... on Team { slug name avatarUrl(size: 64) } } } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } reviewDecision mergeStateStatus stack { size } stackEntry { position } additions deletions changedFiles files(first: 100) { nodes { path additions deletions } pageInfo { hasNextPage endCursor } } reviews(last: 100) { nodes { state submittedAt author { __typename login avatarUrl(size: 64) } } } } } } }`;

function approved(pr) {
  const latest = new Map();
  for (const review of pr.reviews?.nodes ?? []) {
    const login = review.author?.login;
    if (!login || review.state === "COMMENTED" || review.state === "PENDING") continue;
    const previous = latest.get(login);
    if (!previous || !review.submittedAt || !previous.submittedAt || review.submittedAt > previous.submittedAt) latest.set(login, review);
  }
  return [...latest.values()].some(r => r.state === "APPROVED");
}
const sectionIcons = { "Needs my review": "code-review", "Changes requested": "file-diff", "Approved": "issue-closed", "Waiting for review": "git-pull-request", "Reviewed": "code-review", "Drafts": "git-pull-request" };
const sectionColors = { "Approved": "#34d058", "Reviewed": "#ffab40", "Changes requested": "#ff5f57" };
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
      return data.data.search.nodes.filter(pr => pr.id).map(pr => ({ ...pr, viewerLogin: data.data.viewer?.login }));
    }));
    cached = group(results); fetchedAt = Date.now();
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}
function checks(pr) {
  const state = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (!state) return null;
  return { color: state === "SUCCESS" ? "#34d058" : state === "FAILURE" || state === "ERROR" ? "#ff5f57" : "#ffab40", label: `Checks: ${state.toLowerCase()}` };
}
function reviewers(pr) {
  const people = new Map();
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const person = request.requestedReviewer;
    if (person?.avatarUrl && person.__typename !== "Bot") people.set(`${person.__typename}:${person.login ?? person.slug}`, person);
  }
  for (const review of pr.reviews?.nodes ?? []) {
    const person = review.author;
    if (person?.avatarUrl && person.__typename !== "Bot" && !people.has(`User:${person.login}`)) people.set(`User:${person.login}`, person);
  }
  return [...people.values()];
}
// URL-derived filenames keep changed GitHub avatars separate from older cached images.
const avatarPaths = new Map();
function avatarFile(url) {
  let hash = 2166136261;
  for (const ch of url) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
  return `pr-avatars/${hash.toString(16)}-${url.length}.img`;
}
async function cacheAvatars(prs, cx) {
  if (checking()) return;
  const people = prs.flatMap(pr => [pr.author, ...reviewers(pr)]).filter(p => p?.avatarUrl);
  const urls = [...new Set(people.map(p => p.avatarUrl))].filter(url => /^https:\/\//i.test(url) && !avatarPaths.has(url));
  if (!urls.length) return;
  const dir = `${appHome()}/pr-avatars`;
  const made = await exec("mkdir", ["-p", dir]);
  if (made.code !== 0) return;
  await Promise.all(urls.map(async url => {
    const relative = avatarFile(url), path = `${appHome()}/${relative}`;
    try {
      const exists = await exec("test", ["-s", path]);
      if (exists.code !== 0) {
        const temporary = `${path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        const download = await exec("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "20", "--max-filesize", "1048576", "--output", temporary, url]);
        if (download.code !== 0) { await exec("rm", ["-f", temporary]); return; }
        const move = await exec("mv", [temporary, path]);
        if (move.code !== 0) return;
      }
      avatarPaths.set(url, relative); cx.notify();
    } catch { /* Keep the initials if an avatar cannot be cached. */ }
  }));
}
const AVATAR_COLORS = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];
function avatar(person, size) {
  const name = person.login ?? person.slug ?? person.name ?? "?";
  const path = avatarPaths.get(person.avatarUrl);
  if (path) return image(path).size(size).flex_none().rounded(person.__typename === "Team" ? size * 0.28 : size / 2);
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  return h_flex().size(size).rounded(person.__typename === "Team" ? size * 0.28 : size / 2).flex_none().bg(AVATAR_COLORS[hash % AVATAR_COLORS.length]).items_center().justify_center().text_size(size > 20 ? 12 : 9).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?");
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
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "#ff5f57";
  if (pr.reviewDecision === "APPROVED" || approved(pr)) return "#34d058";
  return "#f78166";
}
function age(date) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
export default class PRMonitor extends View {
  init(_props, cx) { this.sections = null; this.menu = null; this.busy = false; this.actionError = null; this.editing = false; this.editingGroup = null;
    try { this.groups = JSON.parse(localStorage.getItem("pr-monitor.reviewerGroups") || "[]"); if (!Array.isArray(this.groups)) this.groups = []; } catch { this.groups = []; }
    this.groupName = InputState.new({ placeholder: "Group name" });
    this.groupUsers = InputState.new({ placeholder: "Users or org/team, comma separated" });
    this.loading = false; this.error = null; this.folded = new Set(); this.showTotal = localStorage.getItem("pr-monitor.showTotal") === "true"; this.refresh(cx); cx.timer.every(300000, cx => this.refresh(cx)); }
  refresh(cx) {
    if (this.loading) return;
    this.loading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        this.sections = await fetchSections(true); this.error = null;
        setShared("pr-monitor.counts", { review: this.sections["Needs my review"].length, changes: this.sections["Changes requested"].length, approved: this.sections.Approved.length });
        setShared("pr-monitor.branches", Object.values(this.sections).flat().filter(pr => pr.headRepository?.nameWithOwner && pr.headRefName).map(pr => ({ repo: pr.headRepository.nameWithOwner.toLowerCase(), branch: pr.headRefName, number: pr.number, url: pr.url })));
        const prs = Object.values(this.sections).flat();
        await Promise.all([cacheAvatars(prs, cx), Promise.all(prs.map(async pr => {
          try { pr.implementation = await implementation(pr); }
          catch { pr.implementationError = true; }
          cx.notify();
        }))]);
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); if (this.refreshAfterAction) { this.refreshAfterAction = false; this.refresh(cx); } }
    });
  }
  saveGroup(cx) {
    const name = this.groupName.value().trim();
    const users = [...new Map(this.groupUsers.value().split(/[\s,]+/).map(s => s.replace(/^@/, "").trim()).filter(Boolean).map(s => [s.toLowerCase(), s])).values()];
    if (!name || !users.length) { this.actionError = "Enter a group name and at least one username or org/team."; cx.notify(); return; }
    if (users.some(u => !/^[a-z0-9-]+(?:\/[a-z0-9][a-z0-9_-]*)?$/i.test(u))) { this.actionError = "Use GitHub usernames or organization/team-slug entries."; cx.notify(); return; }
    this.groups = this.groups.filter(g => g.name !== this.editingGroup && g.name.toLowerCase() !== name.toLowerCase());
    this.groups.push({ name, users }); this.groups.sort((a, b) => a.name.localeCompare(b.name));
    localStorage.setItem("pr-monitor.reviewerGroups", JSON.stringify(this.groups));
    this.groupName.set_value(""); this.groupUsers.set_value(""); this.editing = false; this.editingGroup = null; this.actionError = null; cx.notify();
  }
  action(pr, args, cx) {
    if (this.busy) return;
    this.busy = true; this.menu = null; this.actionError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec("gh", args, { timeout: 30000 });
        if (r.code !== 0) throw new Error(r.stderr || "GitHub action failed");
      } catch (e) { this.actionError = `#${pr.number}: ${String(e)}`; }
      finally { this.busy = false; cx.notify(); if (this.loading) this.refreshAfterAction = true; else this.refresh(cx); }
    });
  }
  requestGroup(pr, group, cx) {
    const owner = pr.repository.nameWithOwner.split("/")[0];
    const wrong = group.users.find(entry => entry.includes("/") && entry.split("/")[0].toLowerCase() !== owner.toLowerCase());
    if (wrong) { this.menu = null; this.actionError = `#${pr.number}: ${wrong} belongs to a different organization than ${owner}.`; cx.notify(); return; }
    const fields = group.users.flatMap(entry => entry.includes("/") ? ["-f", `team_reviewers[]=${entry.split("/")[1]}`] : ["-f", `reviewers[]=${entry}`]);
    this.action(pr, ["api", "--method", "POST", `repos/${pr.repository.nameWithOwner}/pulls/${pr.number}/requested_reviewers`, ...fields], cx);
  }
  actionMenu(pr, t) {
    const button = (id, label, fn) => div().id(id).px(8).py(5).rounded(5).text_size(12).hover(s => s.bg(t.hover)).on_click((e, cx) => { cx.stop_propagation(); fn(cx); }).child(label);
    return v_flex().p(6).gap(2).rounded(6).border_1().border_color(t.border).bg(t.background)
      .when(Boolean(pr.viewerLogin && pr.author?.login === pr.viewerLogin), el => el.child(button(`draft-${pr.id}`, pr.isDraft ? "Mark ready for review" : "Convert to draft", cx => this.action(pr, ["pr", "ready", String(pr.number), "--repo", pr.repository.nameWithOwner, ...(pr.isDraft ? [] : ["--undo"])], cx))))
      .children((pr.reviewRequests?.nodes?.length ? [] : this.groups).map((g, i) => button(`review-${pr.id}-${i}`, `Request ${g.name}`, cx => this.requestGroup(pr, g, cx))))
      .when(!pr.reviewRequests?.nodes?.length && !this.groups.length, el => el.child(button(`setup-groups-${pr.id}`, "Set up reviewer groups…", cx => { this.menu = null; this.editing = true; cx.notify(); })))
      .child(button(`close-menu-${pr.id}`, "Cancel", cx => { this.menu = null; cx.notify(); }));
  }
  render(cx) {
    const t = theme();
    return v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(38).px(12).items_center().justify_between().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Pull requests"))
        .child(h_flex().items_center().gap(5)
          .child(div().id("pr-destination").px(8).py(5).rounded(6).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).tooltip(`Opening in ${shared("pr-monitor.destination") === "linear" ? "Linear" : "GitHub"}; click to switch`).on_click((_e, cx) => { setShared("pr-monitor.destination", shared("pr-monitor.destination") === "linear" ? "github" : "linear"); cx.notify(); }).child(shared("pr-monitor.destination") === "linear" ? image("mods/pr-monitor/linear.png").size(14) : svg("mods/pr-monitor/github.svg").size(14)))
          .child(div().id("pr-line-mode").px(8).py(5).rounded(6).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).tooltip(`Showing ${this.showTotal ? "all" : "implementation"} line counts. Click to switch.`).on_click((_e, cx) => { this.showTotal = !this.showTotal; localStorage.setItem("pr-monitor.showTotal", String(this.showTotal)); cx.notify(); }).child(this.showTotal ? "All" : "Impl"))
          .child(div().id("reviewer-groups").px(8).py(5).rounded(6).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.editing = !this.editing; this.menu = null; cx.notify(); }).child("Groups"))
          .child(div().id("refresh-prs").px(8).py(5).rounded(6).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx)).child(this.loading ? "Refreshing…" : "Refresh"))))
      .when(this.editing, el => el.child(v_flex().p(8).gap(6).border_1().border_color(t.border).rounded(6)
          .child(div().text_size(12).child("Reviewer groups (usernames or org/team-slug)"))
          .children(this.groups.map((g, i) => h_flex().gap(6).items_center().child(div().flex_1().text_size(12).child(`${g.name}: ${g.users.join(", ")}`)).child(div().id(`edit-group-${i}`).text_size(12).on_click((_e, cx) => { this.editingGroup = g.name; this.groupName.set_value(g.name); this.groupUsers.set_value(g.users.join(", ")); cx.notify(); }).child("Edit")).child(div().id(`delete-group-${i}`).text_size(12).on_click((_e, cx) => { this.groups.splice(i, 1); localStorage.setItem("pr-monitor.reviewerGroups", JSON.stringify(this.groups)); cx.notify(); }).child("Delete"))))
          .child(div().h(30).px(6).border_1().border_color(t.border).child(Input.new(this.groupName).h_full().text_size(12)))
          .child(div().h(30).px(6).border_1().border_color(t.border).child(Input.new(this.groupUsers).h_full().text_size(12)))
          .child(div().id("save-group").p(5).text_size(12).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.saveGroup(cx)).child("Save group"))))
      .child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(6)
        .when(Boolean(this.actionError), el => el.child(div().p(4).text_size(12).text_color(t.blocked).child(this.actionError)))
        .when(this.busy, el => el.child(div().p(4).text_size(12).text_color(t.muted).child("Updating pull request…")))
        .when(Boolean(this.error), el => el.child(div().p(4).text_size(12).text_color(t.blocked).child(this.error)))
        .when(!this.sections && !this.error, el => el.child(div().p(4).text_size(12).text_color(t.muted).child("Loading pull requests…")))
        .when(Boolean(this.sections) && !Object.values(this.sections ?? {}).some(list => list.length), el => el.child(div().p(4).text_size(12).text_color(t.muted).child("No open pull requests.")))
        .children(Object.entries(this.sections ?? {}).filter(([, prs]) => prs.length).map(([name, prs]) => v_flex().gap(2)
          .child(h_flex().id(`section-${name}`).px(4).py(5).items_center().justify_between().rounded(5).hover(s => s.bg(t.hover)).on_click((_e, cx) => { if (this.folded.has(name)) this.folded.delete(name); else this.folded.add(name); cx.notify(); })
            .child(h_flex().items_center().gap(6).child(svg(`mods/workspace-chrome/chevron-${this.folded.has(name) ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.muted)).child(svg(`mods/pr-monitor/${sectionIcons[name]}-16.svg`).size(14).flex_none().text_color(sectionColors[name] ?? t.muted)).child(div().font_semibold().text_size(13).child(name))).child(div().text_size(11).text_color(sectionColors[name] ?? t.muted).child(String(prs.length))))
          .when(!this.folded.has(name), el => el.children(prs.map(pr => v_flex().id(pr.id).px(8).py(6).gap(3).rounded(5).border_l(3).border_color(statusColor(pr, t)).hover(s => s.bg(t.hover)).on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (!pr.viewerLogin || pr.author?.login !== pr.viewerLogin) return; this.menu = this.menu === pr.id ? null : pr.id; cx.notify(); }).on_click((_e, cx) => { cx.open_url(shared("pr-monitor.destination") === "linear" ? pr.url.replace(/^https:\/\/github\.com\//, "https://linear.review/") : pr.url); })
            .child(h_flex().gap(8).items_center()
              .when(Boolean(pr.author?.avatarUrl), el => el.child(avatar(pr.author, 28)))
              .child(div().flex_1().min_w(0).text_size(12).child(pr.title))
              .child(div().flex_none().text_size(11).text_color(t.muted).child(age(pr.updatedAt))))
            .child(h_flex().items_center().gap(6).text_size(11).text_color(t.muted)
              .child(h_flex().flex_1().min_w(0).items_center().gap(6)
                .child(div().min_w(0).truncate().child(`${pr.repository.nameWithOwner.split("/").pop()} #${pr.number}`))
                .child(div().flex_none().text_color(t.ansi2).child(this.showTotal ? `+${pr.additions}` : pr.implementation ? `+${pr.implementation.add}` : pr.implementationError ? "—" : "…"))
                .child(div().flex_none().text_color(t.blocked).child(this.showTotal ? `−${pr.deletions}` : pr.implementation ? `−${pr.implementation.del}` : pr.implementationError ? "—" : "…"))
                .when(!this.showTotal && pr.implementation?.excluded, el => el.child(div().flex_none().text_color(t.muted).child("*")))
                .child(h_flex().flex_none().items_center().gap(3).child(svg("mods/files/file.svg").size(12).flex_none()).child(div().child(String(pr.changedFiles))))
                .when(Boolean(pr.stack && pr.stackEntry), el => el.child(h_flex().flex_none().items_center().gap(3).text_color(t.muted).tooltip("Position in GitHub stack").child(svg("mods/pr-monitor/stack.svg").size(12).flex_none()).child(div().child(`${pr.stackEntry.position}/${pr.stack.size}`)))))
              .when(pr.mergeStateStatus === "DIRTY", el => el.child(svg("mods/pr-monitor/alert-16.svg").size(14).flex_none().text_color(t.blocked).tooltip("Merge conflict")))
              .when(Boolean(checks(pr)), el => el.child(svg("mods/pr-monitor/beaker-16.svg").size(14).flex_none().text_color(checks(pr).color).tooltip(checks(pr).label)))
              .when(reviewers(pr).length > 0, el => el.child(avatarGroup(reviewers(pr), t))))
            .when(this.menu === pr.id && !this.busy, el => el.child(this.actionMenu(pr, t)))))))));
  }
}

import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, exec } from "herdr";

const searches = ["is:pr is:open -is:draft review-requested:@me", "is:pr is:open author:@me", "is:pr is:open -is:draft reviewed-by:@me -author:@me"];
const query = q => `{ search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ... on PullRequest { id number title url isDraft updatedAt repository { nameWithOwner } author { login avatarUrl(size: 64) } reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 64) } ... on Team { slug name avatarUrl(size: 64) } } } } reviewDecision mergeStateStatus additions deletions changedFiles reviews(last: 100) { nodes { state submittedAt author { login avatarUrl(size: 64) } } } } } } }`;

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
let cached = null, fetchedAt = 0, pending = null;
async function fetchSections(force = false) {
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


function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.refreshPRCounts(cx);
    cx.timer.every(300000, cx => this.refreshPRCounts(cx));
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  refreshPRCounts(cx) {
    cx.spawn(async cx => {
      try {
        const sections = await fetchSections();
        setShared("pr-monitor.counts", { review: sections["Needs my review"].length, changes: sections["Changes requested"].length, approved: sections.Approved.length });
        cx.notify();
      } catch { /* Keep the last successful counts. */ }
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "calendar", "pr-monitor"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(id === "pr-monitor" ? image(icon).size(14) : svg(icon).size(14)).child(label)
        .when(id === "pr-monitor" && Boolean(shared("pr-monitor.counts")), el => {
          const counts = shared("pr-monitor.counts");
          return el.children([[counts.review, "#f78166"], [counts.changes, t.ansi1], [counts.approved, t.ansi2]]
            .filter(([count]) => count > 0).map(([count, color]) => div().text_size(11).font_semibold().text_color(color).child(count > 99 ? "99+" : String(count))));
        });
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(panelButton("calendar", "Calendar", "mods/workspace-chrome/clock.svg"))
      .child(panelButton("pr-monitor", "Pull requests", "mods/pr-monitor/icon.png"))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}

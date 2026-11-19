import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, run } from "herdr";
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
export default class SidebarTabs extends View {
  render() {
    const t = theme(), active = find(layout(), "sidebar-views")?.active ?? "agents";
    return h_flex().size_full().px(8).gap(4).items_center().bg(t.chrome).children(["agents", "spaces"].map(id =>
      div().id(`sidebar-tab-${id}`).flex_1().h(27).rounded(6).flex().items_center().justify_center().text_size(12)
        .text_color(active === id ? t.foreground : t.dim).when(active === id, e => e.bg(t.selected))
        .hover(e => e.bg(t.hover)).cursor_pointer().on_click(() => run("layout.select", { stack: "sidebar-views", child: id }))
        .child(id === "agents" ? "Agents" : "Spaces")));
  }
}

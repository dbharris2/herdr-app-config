import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, pickFolder, run, closeOverlay, props, spaces, panes, shared, setShared, home } from "herdr";

const name = path => path.replace(/\/+$/, "").split("/").pop() || path;
export default class AgentStarter extends View {
  init() {
    this.recent = shared("agent-starter.recent") ?? JSON.parse(localStorage.getItem("recent") || "[]");
    const old = localStorage.getItem("folder");
    if (old && !this.recent.includes(old)) this.recent.push(old);
    this.favorites = shared("agent-starter.favorites") ?? JSON.parse(localStorage.getItem("favorites") || "[]");
    const models = shared("agent-starter.models") ?? JSON.parse(localStorage.getItem("models") || "{}");
    this.models = {};
    for (const agent of ["codex", "claude"]) {
      this.models[agent] = InputState.new({ placeholder: "Default" });
      this.models[agent].set_value(models[agent] || (agent === "codex" ? "gpt-6.1-terra" : ""));
      this.models[agent].on("change", () => this.saveModels());
    }
  }
  saveModels() {
    setShared("agent-starter.models", Object.fromEntries(Object.entries(this.models).map(([k, v]) => [k, v.value().trim()])));
  }
  remember(folder) {
    this.recent = [folder, ...this.recent.filter(p => p !== folder)].slice(0, 20);
    setShared("agent-starter.recent", this.recent);
  }
  launch(folder, agent) {
    this.remember(folder); this.saveModels();
    const model = this.models[agent].value().trim();
    const argv = [agent, ...(model ? ["--model", model] : []), ...(agent === "codex" ? ["-c", "model_reasoning_effort=low"] : [])];
    const space = this.localSpaces().find(s => s.folder === folder);
    if (space) run("tab.new", { space: space.id, folder, argv });
    else run("space.new", { folder, machine: "", argv });
    closeOverlay(props().overlay);
  }
  localSpaces() {
    const ps = panes();
    return spaces().filter(s => !s.machine).map(s => ({ ...s, folder: ps.find(p => s.tabs?.some(t => t.id === p.tab) && p.cwd)?.cwd || s.folder }));
  }
  render() {
    const t = theme();
    const paths = [...new Set([...this.favorites, ...this.recent, ...this.localSpaces().map(s => s.folder).filter(Boolean)])];
    const icons = shared("agent-repo-icons") ?? {};
    const homeDir = home().replace(/\/$/, "");
    const displayPath = path => path === homeDir ? "~" : path.startsWith(homeDir + "/") ? "~" + path.slice(homeDir.length) : path;
    const button = (id, label, action) => div().id(id).px(10).py(6).rounded(6).bg(t.raised).cursor_pointer().hover(e => e.bg(t.hover)).on_click(action).child(label);
    return v_flex().id("agent-starter").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8).child(div().flex_1().text_size(16).font_semibold().child("Start an agent"))
        .child(button("add-folder", "+ Add folder", (_e, cx) => cx.spawn(async cx => { const folder = await pickFolder(); if (folder) this.remember(folder); cx.notify(); })))
        .child(button("close", "×", () => closeOverlay(props().overlay))))
      .child(h_flex().gap(10).children(["codex", "claude"].map(agent => h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().text_color(t.muted).child(agent === "codex" ? "Codex" : "Claude"))
        .child(div().flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).child(Input.new(this.models[agent]).h_full().text_size(12).text_color(t.foreground))))))
      .child(div().text_size(11).text_color(t.dim).child("Models are remembered. Codex uses low reasoning effort."))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(7)
        .when(!paths.length, e => e.child(div().py(16).text_color(t.dim).child("Add a folder to get started.")))
        .children(paths.map((path, i) => h_flex().id(`repo-${i}`).p(10).gap(8).items_center().rounded(8).border_1().border_color(t.border)
          .when(Boolean(icons[path]), el => el.child(image(icons[path]).size(28).flex_none().rounded(5)))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().font_semibold().truncate().child(name(path))).child(div().text_size(11).text_color(t.dim).truncate().tooltip(path).child(displayPath(path))))
          .child(button(`favorite-${i}`, this.favorites.includes(path) ? "★" : "☆", (_e, cx) => { this.favorites = this.favorites.includes(path) ? this.favorites.filter(p => p !== path) : [...this.favorites, path]; setShared("agent-starter.favorites", this.favorites); cx.notify(); }))
          .child(button(`codex-${i}`, h_flex().gap(6).items_center().child(image("icons/codex.svg").size(16)).child("Codex"), () => this.launch(path, "codex")))
          .child(button(`claude-${i}`, h_flex().gap(6).items_center().child(image("icons/claude.svg").size(16)).child("Claude"), () => this.launch(path, "claude"))))));
  }
}

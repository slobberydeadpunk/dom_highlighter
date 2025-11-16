(function flowWindow() {
  const channel = new BroadcastChannel("dom-highlighter-flow");
  const canvas = document.getElementById("flow-canvas");
  const sceneNameEl = document.getElementById("scene-name");
  const requestSyncButton = document.getElementById("request-sync");

  let actions = [];

  channel.onmessage = (event) => {
    const data = event && event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.type === "actions" && Array.isArray(data.actions)) {
      actions = data.actions.slice();
      render();
      if (typeof data.sceneName === "string") {
        sceneNameEl.textContent = data.sceneName;
      }
    }
  };

  requestSyncButton.addEventListener("click", () => {
    channel.postMessage({ type: "request-actions" });
  });

  channel.postMessage({ type: "request-actions" });

  function render() {
    canvas.innerHTML = "";
    if (!actions.length) {
      const empty = document.createElement("div");
      empty.className = "flow-empty";
      empty.textContent = "暂无动作，请在主窗口添加后再次同步。";
      canvas.appendChild(empty);
      return;
    }

    const list = document.createElement("ul");
    list.className = "flow-list";

    actions.forEach((action, index) => {
      const item = document.createElement("li");
      item.className = "flow-node";
      item.dataset.type = action.type || "highlight";
      item.dataset.order = index + 1;
      item.dataset.status = action.status || "pending";

      const content = document.createElement("div");
      content.className = "content";

      const title = document.createElement("p");
      title.className = "title";
      title.textContent = `[${describeType(action.type)}] ${action.description || "动作"}`;

      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent =
        action.type === "wait"
          ? `等待 ${action.durationMs || action.delayMs || 400}ms`
          : action.selector || "<无选择器>";

      const note = document.createElement("p");
      note.className = "note";
      note.textContent = action.annotation || "无备注";

      content.appendChild(title);
      content.appendChild(meta);
      content.appendChild(note);

      const controls = document.createElement("div");
      controls.className = "controls";

      const up = document.createElement("button");
      up.textContent = "上移";
      up.addEventListener("click", () => move(index, -1));

      const down = document.createElement("button");
      down.textContent = "下移";
      down.addEventListener("click", () => move(index, 1));

      controls.appendChild(up);
      controls.appendChild(down);

      item.appendChild(content);
      item.appendChild(controls);
      list.appendChild(item);
    });

    canvas.appendChild(list);
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= actions.length) {
      return;
    }
    const tmp = actions[target];
    actions[target] = actions[index];
    actions[index] = tmp;
    channel.postMessage({
      type: "reorder",
      order: actions.map((item) => item.id),
    });
    render();
  }

  function describeType(type) {
    switch (type) {
      case "click":
        return "点击";
      case "input":
        return "输入";
      case "wait":
        return "等待";
      case "highlight":
      default:
        return "高亮";
    }
  }
})();

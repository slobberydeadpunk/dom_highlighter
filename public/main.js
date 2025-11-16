const MESSAGE_FLAG = "__domHighlighter";
const SCENE_VERSION = 1;

function getElectronBridge() {
  return window.domHighlighterBridge || null;
}

function shouldUseElectron() {
  return Boolean(getElectronBridge()) || /\bElectron\//i.test(navigator.userAgent);
}

const form = document.getElementById("preview-form");
const input = document.getElementById("url-input");
const iframe = document.getElementById("preview-frame");
const webview = document.getElementById("preview-webview");

let frame = iframe;
let usingElectron = false;
let electronBridgeReady = false;
let pendingElectronAssetPush = false;
let cachedElectronAssets = null;
let cachedElectronAssetsPromise = null;
let electronAssetsInjected = false;
let electronAssetsLoading = false;

configurePreviewSurface();
if (shouldUseElectron()) {
  setTimeout(configurePreviewSurface, 50);
}

window.addEventListener("message", handleFrameEvent);
if (webview) {
  webview.addEventListener("ipc-message", handleWebviewMessage);
  webview.addEventListener("did-fail-load", handleWebviewFailure);
  webview.addEventListener("dom-ready", handleWebviewDomReady);
}

function configurePreviewSurface() {
  const bridge = getElectronBridge();
  const electron = shouldUseElectron();

  if (electron && webview) {
    const preloadPath =
      bridge && typeof bridge.getWebviewPreloadPath === "function"
        ? bridge.getWebviewPreloadPath()
        : null;
    if (preloadPath && webview.getAttribute("preload") !== preloadPath) {
      webview.setAttribute("preload", preloadPath);
    }
    webview.style.display = "flex";
    webview.style.flex = "1 1 auto";
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.minHeight = "0";
    if (iframe) {
      iframe.style.display = "none";
    }
    frame = webview;
    usingElectron = true;
  } else {
    if (webview) {
      webview.style.display = "none";
      webview.style.flex = "";
      webview.style.width = "";
      webview.style.height = "";
    }
    if (iframe) {
      iframe.style.display = "block";
      iframe.style.flex = "1 1 auto";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.minHeight = "0";
    }
    frame = iframe;
    usingElectron = false;
  }
}

const highlightsList = document.getElementById("highlights-list");
const highlightsEmpty = document.getElementById("highlights-empty");
const exportButton = document.getElementById("export-json");
const importInput = document.getElementById("import-json");
const replayButton = document.getElementById("replay-sequence");
const addActionButton = document.getElementById("add-action");
const addWaitButton = document.getElementById("add-wait");
const openFlowButton = document.getElementById("open-flow");

const state = {
  sceneName: "未命名场景",
  highlights: [],
  frameReady: false,
  messageQueue: [],
  isReplaying: false,
};
const pendingActionResolvers = new Map();
const flowChannel = new BroadcastChannel("dom-highlighter-flow");
let flowWindow = null;

function loadElectronAssets() {
  if (cachedElectronAssets) {
    return Promise.resolve(cachedElectronAssets);
  }
  if (cachedElectronAssetsPromise) {
    return cachedElectronAssetsPromise;
  }
  const bridge = getElectronBridge();
  if (bridge && typeof bridge.getInjectedAssets === "function") {
    cachedElectronAssetsPromise = Promise.resolve(
      bridge.getInjectedAssets()
    ).then((assets) => {
      if (
        assets &&
        typeof assets.css === "string" &&
        typeof assets.js === "string"
      ) {
        cachedElectronAssets = assets;
        return assets;
      }
      return null;
    });
    return cachedElectronAssetsPromise;
  }
  return Promise.resolve(null);
}

function deliverAssetsToWebview() {
  if (!usingElectron || !frame || typeof frame.send !== "function") {
    return;
  }

  if (!electronBridgeReady) {
    pendingElectronAssetPush = true;
    return;
  }

  if (electronAssetsInjected || electronAssetsLoading) {
    pendingElectronAssetPush = false;
    return;
  }

  electronAssetsLoading = true;
  loadElectronAssets()
    .then((assets) => {
      electronAssetsLoading = false;
      if (!assets) {
        pendingElectronAssetPush = true;
        return;
      }
      pendingElectronAssetPush = false;
      electronAssetsInjected = true;
      if (usingElectron && frame && typeof frame.send === "function") {
        frame.send("dom-highlighter", {
          __domHighlighter: true,
          type: "inject-assets",
          css: assets.css,
          js: assets.js,
          config: {
            assetOrigin: "electron-inline",
          },
        });
      }
    })
    .catch(() => {
      electronAssetsLoading = false;
      pendingElectronAssetPush = true;
    });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value.trim();

  if (!value) {
    return;
  }

  const targetUrl = normalizeUrl(value);
  navigatePreview(targetUrl);
});

exportButton.addEventListener("click", handleExport);
replayButton.addEventListener("click", handleReplay);
importInput.addEventListener("change", handleImport);
addActionButton.addEventListener("click", () => {
  addManualAction("highlight");
});
addWaitButton.addEventListener("click", () => {
  addManualAction("wait");
});
openFlowButton.addEventListener("click", openFlowWindow);
flowChannel.onmessage = handleFlowChannel;

function navigatePreview(url) {
  resetHighlights(true);
  state.frameReady = false;
  state.messageQueue = [];
  pendingActionResolvers.forEach((resolver) =>
    resolver({ status: "error", code: "navigation" })
  );
  pendingActionResolvers.clear();
  configurePreviewSurface();
  if (!frame) {
    return;
  }
  if (usingElectron) {
    electronBridgeReady = false;
    pendingElectronAssetPush = true;
    electronAssetsInjected = false;
    frame.setAttribute("src", url);
  } else {
    electronBridgeReady = false;
    pendingElectronAssetPush = false;
    electronAssetsInjected = false;
    frame.src = `/render?url=${encodeURIComponent(url)}`;
  }
}

function handleFrameEvent(event) {
  if (usingElectron) {
    return;
  }
  if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) {
    return;
  }
  processPreviewPayload(event.data);
}

function handleWebviewMessage(event) {
  if (!usingElectron) {
    return;
  }
  if (!event || event.channel !== "dom-highlighter") {
    return;
  }
  if (!Array.isArray(event.args) || !event.args.length) {
    return;
  }
  processPreviewPayload(event.args[0]);
}

function handleWebviewFailure(event) {
  if (!usingElectron || !event || event.errorCode === -3) {
    return;
  }
  handlePreviewError({
    message:
      event.errorDescription ||
      `无法加载 ${event.validatedURL || "请求的页面"}。`,
  });
}

function handleWebviewDomReady() {
  if (!usingElectron) {
    return;
  }
  deliverAssetsToWebview();
}

function processPreviewPayload(data) {
  if (!data || typeof data !== "object" || data[MESSAGE_FLAG] !== true) {
    return;
  }

  console.debug("[DOM Highlighter] preview payload:", data);

  switch (data.type) {
    case "bridge-ready":
      electronBridgeReady = true;
      console.debug("[DOM Highlighter] webview bridge ready");
      if (pendingElectronAssetPush) {
        deliverAssetsToWebview();
      }
      break;
    case "injection-complete":
      electronAssetsInjected = true;
      console.debug("[DOM Highlighter] assets injected");
      break;
    case "ready":
      state.frameReady = true;
      flushMessageQueue();
      syncOrdersToIframe();
      break;
    case "action-complete":
      handleActionComplete(data);
      break;
    case "action-error":
      handleActionError(data);
      break;
    case "lock":
      handleLockMessage(data);
      break;
    case "unlock":
      handleUnlockMessage(data);
      break;
    case "replay-applied":
      handleReplayApplied(data);
      break;
    case "error":
      if (typeof data.id === "string") {
        handleFrameError(data);
      } else {
        handlePreviewError(data);
      }
      break;
    default:
      break;
  }
}

function handleLockMessage(payload) {
  if (!payload || !payload.id) {
    return;
  }

  let existing = state.highlights.find((item) => item.id === payload.id);
  if (existing) {
    existing.active = true;
    existing.status = "active";
    renderHighlights();
    syncOrdersToIframe();
    return;
  }

  const entry = {
    id: payload.id,
    type: "highlight",
    selector: payload.selector || "",
    description: payload.description || payload.selector || "元素",
    annotation: "",
    active: true,
    status: "active",
  };

  state.highlights.push(entry);
  renderHighlights();
  syncOrdersToIframe();
  focusHighlight(entry.id);
}

function handleUnlockMessage(payload) {
  if (!payload || !payload.id) {
    return;
  }
  removeHighlightById(payload.id, { notifyIframe: false });
}

function handleReplayApplied(payload) {
  if (!payload || !payload.id) {
    return;
  }
  const entry = state.highlights.find((item) => item.id === payload.id);
  if (!entry) {
    return;
  }
  entry.active = true;
  entry.status = "active";
  resolvePendingAction(entry.id, { status: "applied", type: "highlight" });
  renderHighlights();
  syncOrdersToIframe();
  sendFlowSnapshot();
}

function handleActionComplete(payload) {
  if (!payload || !payload.id) {
    return;
  }
  const entry = state.highlights.find((item) => item.id === payload.id);
  if (entry) {
    entry.status = "done";
    if (entry.type === "highlight") {
      entry.active = true;
    }
  }
  resolvePendingAction(payload.id, {
    status: "complete",
    type: (entry && entry.type) || payload.type,
  });
  renderHighlights();
  syncOrdersToIframe();
  sendFlowSnapshot();
}

function handleActionError(payload) {
  if (!payload || !payload.id) {
    return;
  }
  const entry = state.highlights.find((item) => item.id === payload.id);
  if (entry) {
    entry.active = false;
    entry.status = payload.code || "action-failed";
  }
  resolvePendingAction(payload.id, {
    status: "error",
    type: (entry && entry.type) || payload.type,
    code: payload.code || "action-failed",
  });
  renderHighlights();
  sendFlowSnapshot();
}

function handleFrameError(payload) {
  if (!payload || !payload.id) {
    return;
  }
  const entry = state.highlights.find((item) => item.id === payload.id);
  if (!entry) {
    return;
  }
  entry.active = false;
  entry.status = payload.code || "error";
  resolvePendingAction(entry.id, {
    status: "error",
    code: payload.code || "error",
    type: entry.type || "highlight",
  });
  renderHighlights();
  sendFlowSnapshot();
}

function handlePreviewError(payload) {
  state.frameReady = false;
  state.messageQueue = [];
  pendingActionResolvers.forEach((resolver) =>
    resolver({ status: "error", code: "preview-error" })
  );
  pendingActionResolvers.clear();
  if (usingElectron) {
    electronAssetsInjected = false;
    if (!electronBridgeReady) {
      pendingElectronAssetPush = true;
    }
  }
  const message =
    payload && typeof payload.message === "string"
      ? payload.message
      : "预览加载失败。请检查开发者工具控制台以获取详细信息。";
  console.error("[DOM Highlighter] Preview error:", payload);
  alert(message);
}

function resetHighlights(clearList) {
  if (clearList) {
    state.highlights = [];
  } else {
    state.highlights.forEach((entry) => {
      entry.active = false;
      entry.status = "pending";
    });
  }
  renderHighlights();
}

function renderHighlights() {
  highlightsList.innerHTML = "";

  if (state.highlights.length === 0) {
    highlightsEmpty.classList.remove("is-hidden");
    sendFlowSnapshot();
    return;
  }

  highlightsEmpty.classList.add("is-hidden");

  state.highlights.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = "highlight-item";
    item.dataset.id = entry.id;
    item.dataset.status = entry.status || "active";
    item.dataset.active = entry.active ? "true" : "false";

    const header = document.createElement("div");
    header.className = "highlight-header";
    const label = document.createElement("span");
    const typeLabel = describeActionType(entry.type);
    label.textContent = `${index + 1}. [${typeLabel}]`;
    const fields = document.createElement("div");
    fields.className = "action-fields";

    const selector = document.createElement("input");
    selector.type = "text";
    selector.className = "action-selector";
    selector.placeholder =
      entry.type === "wait" ? "等待动作无需选择器" : "CSS 选择器";
    selector.value = entry.selector || "";
    selector.disabled = entry.type === "wait";
    selector.addEventListener("change", (event) => {
      handleSelectorChange(entry.id, event.target.value);
    });
    fields.appendChild(selector);

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.className = "action-value";
    valueInput.placeholder = "输入内容（仅输入动作）";
    valueInput.value = entry.value || "";
    valueInput.style.display = entry.type === "input" ? "block" : "none";
    valueInput.addEventListener("change", (event) => {
      handleValueChange(entry.id, event.target.value);
    });
    fields.appendChild(valueInput);

    const delayInput = document.createElement("input");
    delayInput.type = "number";
    delayInput.className = "action-delay";
    delayInput.placeholder =
      entry.type === "wait" ? "等待时长(ms)" : "步骤间延时(ms)";
    delayInput.value =
      typeof entry.delayMs === "number" ? String(entry.delayMs) : "";
    delayInput.addEventListener("change", (event) => {
      handleDelayChange(entry.id, event.target.valueAsNumber || event.target.value);
    });
    fields.appendChild(delayInput);
    const typeSelect = document.createElement("select");
    typeSelect.className = "action-type";
    ["highlight", "click", "input", "wait"].forEach((optionType) => {
      const option = document.createElement("option");
      option.value = optionType;
      option.textContent = describeActionType(optionType);
      if (optionType === entry.type) {
        option.selected = true;
      }
      typeSelect.appendChild(option);
    });
    typeSelect.addEventListener("change", (event) => {
      handleTypeChange(entry.id, event.target.value);
    });
    const labelRow = document.createElement("div");
    labelRow.className = "action-labels";
    labelRow.appendChild(label);
    labelRow.appendChild(typeSelect);
    header.appendChild(labelRow);
    header.appendChild(fields);

    const textarea = document.createElement("textarea");
    textarea.className = "highlight-annotation";
    textarea.placeholder = "添加备注或说明...";
    textarea.value = entry.annotation;
    textarea.addEventListener("change", (event) => {
      handleAnnotationChange(entry.id, event.target.value);
    });

    const status = document.createElement("div");
    status.className = "highlight-status";
    status.textContent = describeStatus(entry);

    const actions = document.createElement("div");
    actions.className = "highlight-actions";

    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "highlight-update";
    runButton.textContent = "执行";
    runButton.addEventListener("click", () => {
      executeSingleAction(entry);
    });

    const moveUp = document.createElement("button");
    moveUp.type = "button";
    moveUp.textContent = "上移";
    moveUp.addEventListener("click", () => {
      moveAction(entry.id, -1);
    });

    const moveDown = document.createElement("button");
    moveDown.type = "button";
    moveDown.textContent = "下移";
    moveDown.addEventListener("click", () => {
      moveAction(entry.id, 1);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "highlight-remove";
    removeButton.textContent = "删除";
    removeButton.addEventListener("click", () => {
      removeHighlightById(entry.id, { notifyIframe: true });
    });

    actions.appendChild(runButton);
    actions.appendChild(moveUp);
    actions.appendChild(moveDown);
    actions.appendChild(removeButton);

    item.appendChild(header);
    item.appendChild(textarea);
    item.appendChild(status);
    item.appendChild(actions);

    highlightsList.appendChild(item);
  });

  sendFlowSnapshot();
}

function describeStatus(entry) {
  if (entry.status === "running") {
    return "执行中...";
  }
  if (entry.status === "done" || entry.status === "complete") {
    return "已完成。";
  }
  if (entry.status === "not-found") {
    return "页面中未找到该元素。";
  }
  if (entry.status === "lock-failed") {
    return "无法高亮此元素。";
  }
  if (entry.status === "timeout") {
    return "等待结果超时。";
  }
  if (entry.status === "action-failed") {
    return "动作执行失败。";
  }
  if (!entry.active) {
    return "已本地保存，重播后生效。";
  }
  return "预览中已应用。";
}

function describeActionType(type) {
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

function handleAnnotationChange(id, value) {
  const entry = state.highlights.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  entry.annotation = value.trim();
  syncOrdersToIframe();
  sendFlowSnapshot();
}

function handleSelectorChange(id, value) {
  const entry = state.highlights.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  entry.selector = value.trim();
  sendFlowSnapshot();
}

function handleValueChange(id, value) {
  const entry = state.highlights.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  entry.value = value;
  sendFlowSnapshot();
}

function handleDelayChange(id, value) {
  const entry = state.highlights.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  const numeric = Number(value);
  entry.delayMs = Number.isFinite(numeric) ? numeric : undefined;
  sendFlowSnapshot();
}

function handleTypeChange(id, type) {
  const entry = state.highlights.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  entry.type = coerceActionType(type);
  if (entry.type === "wait") {
    entry.selector = "";
  }
  if (entry.type !== "input") {
    entry.value = "";
  }
  entry.status = "pending";
  renderHighlights();
  sendFlowSnapshot();
}

function addManualAction(type) {
  const actionType = coerceActionType(type);
  const entry = {
    id: generateEntryId(),
    type: actionType,
    selector: "",
    description: describeActionType(actionType),
    annotation: "",
    value: "",
    delayMs: actionType === "wait" ? 400 : undefined,
    active: false,
    status: "pending",
  };
  state.highlights.push(entry);
  renderHighlights();
  focusHighlight(entry.id);
  sendFlowSnapshot();
}

function removeHighlightById(id, { notifyIframe }) {
  const index = state.highlights.findIndex((item) => item.id === id);
  if (index === -1) {
    return;
  }
  const [removed] = state.highlights.splice(index, 1);
  renderHighlights();
  if (notifyIframe && removed && removed.active && removed.type === "highlight") {
    postToFrame({
      type: "remove-highlight",
      id,
    });
  }
  syncOrdersToIframe();
  sendFlowSnapshot();
}

function moveAction(id, direction) {
  const index = state.highlights.findIndex((item) => item.id === id);
  if (index === -1) {
    return;
  }
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= state.highlights.length) {
    return;
  }
  const tmp = state.highlights[targetIndex];
  state.highlights[targetIndex] = state.highlights[index];
  state.highlights[index] = tmp;
  renderHighlights();
  sendFlowSnapshot();
}

function handleExport() {
  if (state.highlights.length === 0) {
    alert("暂无可导出的高亮。");
    return;
  }
  const payload = buildScenePayload();

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dom-scene-${Date.now()}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function handleImport(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) {
    return;
  }
  try {
    const contents = await file.text();
    const parsed = JSON.parse(contents);
    const imported = extractActionsFromImport(parsed);
    if (!imported || !imported.actions.length) {
      throw new Error("高亮数据无效。");
    }

    state.sceneName =
      typeof imported.name === "string" && imported.name.trim().length
        ? imported.name.trim()
        : state.sceneName;
    state.highlights = imported.actions.map((item, index) =>
      normalizeImportedAction(item, index)
    );
    renderHighlights();
  } catch (error) {
    alert("导入高亮失败，请检查 JSON 文件。");
  } finally {
    event.target.value = "";
  }
}

function buildScenePayload() {
  const actions = state.highlights.map((entry, index) =>
    serializeActionForExport(entry, index)
  );

  const highlightCompat = actions
    .filter((item) => item.type === "highlight")
    .map((item) => ({
      order: item.order,
      selector: item.selector,
      description: item.description,
      annotation: item.annotation,
    }));

  return {
    version: SCENE_VERSION,
    name: state.sceneName || "未命名场景",
    generatedAt: new Date().toISOString(),
    actions,
    highlights: highlightCompat,
  };
}

function serializeActionForExport(entry, index) {
  const type = coerceActionType(entry.type);
  const payload = {
    id: entry.id,
    type,
    order: index + 1,
    selector: entry.selector || "",
    description:
      entry.description || entry.selector || describeActionType(type) || "动作",
    annotation: entry.annotation || "",
  };
  if (type === "input" && typeof entry.value === "string") {
    payload.value = entry.value;
  }
  if (typeof entry.delayMs === "number") {
    payload.delayMs = entry.delayMs;
  }
  if (typeof entry.durationMs === "number") {
    payload.durationMs = entry.durationMs;
  }
  return payload;
}

function extractActionsFromImport(parsed) {
  if (!parsed) {
    return { actions: [] };
  }
  if (Array.isArray(parsed)) {
    return { actions: parsed, name: "未命名场景" };
  }
  if (Array.isArray(parsed.actions)) {
    return { actions: parsed.actions, name: parsed.name || parsed.title };
  }
  if (Array.isArray(parsed.highlights)) {
    return {
      actions: parsed.highlights.map((item) =>
        Object.assign({}, item, { type: item.type || "highlight" })
      ),
      name: parsed.name || parsed.title,
    };
  }
  return { actions: [] };
}

function normalizeImportedAction(item, index) {
  const type = coerceActionType(item.type);
  return {
    id: generateEntryId(),
    type,
    selector: item.selector || "",
    description:
      item.description || item.selector || describeActionType(type) || "动作",
    annotation:
      typeof item.annotation === "string"
        ? item.annotation
        : typeof item.note === "string"
        ? item.note
        : "",
    value: typeof item.value === "string" ? item.value : "",
    delayMs: normalizeDuration(item.delayMs, item.durationMs),
    active: false,
    status: "pending",
    order: typeof item.order === "number" ? item.order : index + 1,
  };
}

async function handleReplay() {
  if (state.highlights.length === 0) {
    alert("请先添加至少一个动作再进行重播。");
    return;
  }
  if (state.isReplaying) {
    return;
  }
  if (!state.frameReady) {
    alert("预览仍在加载，请稍后再试。");
    return;
  }

  state.isReplaying = true;
  replayButton.disabled = true;

  state.highlights.forEach((entry) => {
    entry.active = false;
    entry.status = "pending";
  });
  renderHighlights();

  await runActionSequence(state.highlights, { clearBefore: true });

  state.isReplaying = false;
  replayButton.disabled = false;
}

async function executeSingleAction(entry) {
  if (!entry) {
    return;
  }
  if (!state.frameReady) {
    alert("预览尚未就绪。");
    return;
  }
  await runActionSequence([entry], { clearBefore: false });
}

async function runActionSequence(actions, { clearBefore = false } = {}) {
  if (!actions || actions.length === 0) {
    return;
  }

  if (clearBefore) {
    postToFrame({ type: "clear-all" });
    await delay(200);
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const order = i + 1;
    action.active = false;
    action.status = "running";
    renderHighlights();

    const payload = buildActionPayload(action, order);
    if (!payload) {
      action.status = "action-failed";
      renderHighlights();
      continue;
    }

    const resultPromise = waitForActionResult(action.id);
    postToFrame({ type: "perform-action", action: payload });

    const result = await resultPromise;
    applyActionResult(action, result);
    renderHighlights();

    const waitMs =
      typeof action.delayMs === "number" && action.delayMs >= 0
        ? action.delayMs
        : 400;
    await delay(waitMs);
  }
}

function buildActionPayload(action, order) {
  if (!action) {
    return null;
  }
  const type = action.type || "highlight";

  if (type === "wait") {
    return {
      id: action.id,
      type,
      durationMs:
        typeof action.durationMs === "number"
          ? action.durationMs
          : typeof action.delayMs === "number"
          ? action.delayMs
          : 400,
      order,
    };
  }

  if (!action.selector) {
    return null;
  }

  return {
    id: action.id,
    type,
    selector: action.selector,
    annotation: action.annotation,
    value: action.value,
    order,
  };
}

function applyActionResult(action, result) {
  if (!action) {
    return;
  }
  if (!result) {
    action.status = "timeout";
    return;
  }
  if (result.status === "timeout") {
    action.status = "timeout";
    return;
  }
  if (result.status === "error") {
    action.status = result.code || "action-failed";
    return;
  }
  if (result.status === "applied") {
    action.status = "active";
    action.active = true;
    return;
  }
  if (result.status === "complete" || result.status === "done") {
    action.status = "done";
    return;
  }
  action.status = result.status || "pending";
}

function waitForActionResult(id, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!id) {
      resolve({ status: "invalid" });
      return;
    }
    const timer = setTimeout(() => {
      resolve({ status: "timeout" });
      pendingActionResolvers.delete(id);
    }, timeoutMs);
    pendingActionResolvers.set(id, (payload) => {
      clearTimeout(timer);
      pendingActionResolvers.delete(id);
      resolve(payload);
    });
  });
}

function resolvePendingAction(id, payload) {
  if (!id) {
    return;
  }
  const resolver = pendingActionResolvers.get(id);
  if (resolver) {
    pendingActionResolvers.delete(id);
    resolver(payload);
  }
}

function normalizeDuration(delayMs, durationMs) {
  if (typeof delayMs === "number" && Number.isFinite(delayMs)) {
    return delayMs;
  }
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    return durationMs;
  }
  return undefined;
}

function coerceActionType(type) {
  if (type === "click" || type === "input" || type === "wait") {
    return type;
  }
  return "highlight";
}

function syncOrdersToIframe() {
  if (!state.frameReady) {
    return;
  }
  state.highlights.forEach((entry, index) => {
    if (!entry.active || entry.type !== "highlight") {
      return;
    }
    postToFrame(
      {
        type: "set-annotation",
        id: entry.id,
        annotation: entry.annotation,
        order: index + 1,
      },
      { queue: false }
    );
  });
}

function focusHighlight(id) {
  window.requestAnimationFrame(() => {
    const item = highlightsList.querySelector(`[data-id="${id}"] textarea`);
    if (item) {
      item.focus({ preventScroll: false });
      item.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

function postToFrame(message, { queue = true } = {}) {
  const payload = Object.assign({}, message, {
    [MESSAGE_FLAG]: true,
  });

  if (!state.frameReady && queue) {
    state.messageQueue.push(payload);
    return;
  }

  if (usingElectron && frame && typeof frame.send === "function") {
    frame.send("dom-highlighter", payload);
  } else if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(payload, window.location.origin);
  }
}

function flushMessageQueue() {
  if (!state.frameReady || !frame) {
    return;
  }
  while (state.messageQueue.length) {
    const payload = state.messageQueue.shift();
    if (usingElectron && frame && typeof frame.send === "function") {
      frame.send("dom-highlighter", payload);
    } else if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(payload, window.location.origin);
    }
  }
}

function sendFlowSnapshot() {
  flowChannel.postMessage({
    type: "actions",
    actions: state.highlights.map((item, index) => ({
      id: item.id,
      type: item.type || "highlight",
      selector: item.selector || "",
      description:
        item.description || item.selector || describeActionType(item.type),
      annotation: item.annotation || "",
      status: item.status || "pending",
      order: index + 1,
    })),
    sceneName: state.sceneName,
  });
}

function handleFlowChannel(event) {
  const data = event && event.data;
  if (!data || typeof data !== "object") {
    return;
  }
  if (data.type === "request-actions") {
    sendFlowSnapshot();
  } else if (data.type === "reorder" && Array.isArray(data.order)) {
    applyExternalOrder(data.order);
  }
}

function applyExternalOrder(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return;
  }
  const newList = [];
  const lookup = new Map(state.highlights.map((item) => [item.id, item]));
  orderIds.forEach((id) => {
    if (lookup.has(id)) {
      newList.push(lookup.get(id));
      lookup.delete(id);
    }
  });
  for (const leftover of lookup.values()) {
    newList.push(leftover);
  }
  if (newList.length) {
    state.highlights = newList;
    renderHighlights();
    syncOrdersToIframe();
    sendFlowSnapshot();
  }
}

function openFlowWindow() {
  if (flowWindow && !flowWindow.closed) {
    flowWindow.focus();
    return;
  }
  const url = new URL("flow.html", window.location.href);
  flowWindow = window.open(url.toString(), "dom-highlighter-flow");
  setTimeout(sendFlowSnapshot, 100);
}
function normalizeUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function generateEntryId() {
  return `client_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

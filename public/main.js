const MESSAGE_FLAG = "__domHighlighter";

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

const state = {
  highlights: [],
  frameReady: false,
  messageQueue: [],
  isReplaying: false,
};

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

function navigatePreview(url) {
  resetHighlights(true);
  state.frameReady = false;
  state.messageQueue = [];
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
  renderHighlights();
  syncOrdersToIframe();
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
  renderHighlights();
}

function handlePreviewError(payload) {
  state.frameReady = false;
  state.messageQueue = [];
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
    label.textContent = `${index + 1}. ${entry.description}`;
    const selector = document.createElement("span");
    selector.textContent = entry.selector || "<无选择器>";
    header.appendChild(label);
    header.appendChild(selector);

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

    const highlightButton = document.createElement("button");
    highlightButton.type = "button";
    highlightButton.className = "highlight-update";
    highlightButton.textContent = "高亮";
    highlightButton.addEventListener("click", () => {
      replaySingleHighlight(entry);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "highlight-remove";
    removeButton.textContent = "删除";
    removeButton.addEventListener("click", () => {
      removeHighlightById(entry.id, { notifyIframe: true });
    });

    actions.appendChild(highlightButton);
    actions.appendChild(removeButton);

    item.appendChild(header);
    item.appendChild(textarea);
    item.appendChild(status);
    item.appendChild(actions);

    highlightsList.appendChild(item);
  });
}

function describeStatus(entry) {
  if (entry.status === "not-found") {
    return "页面中未找到该元素。";
  }
  if (entry.status === "lock-failed") {
    return "无法高亮此元素。";
  }
  if (!entry.active) {
    return "已本地保存，重播后生效。";
  }
  return "预览中已应用。";
}

function handleAnnotationChange(id, value) {
  const entry = state.highlights.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  entry.annotation = value.trim();
  syncOrdersToIframe();
}

function removeHighlightById(id, { notifyIframe }) {
  const index = state.highlights.findIndex((item) => item.id === id);
  if (index === -1) {
    return;
  }
  const [removed] = state.highlights.splice(index, 1);
  renderHighlights();
  if (notifyIframe && removed && removed.active) {
    postToFrame({
      type: "remove-highlight",
      id,
    });
  }
  syncOrdersToIframe();
}

function handleExport() {
  if (state.highlights.length === 0) {
    alert("暂无可导出的高亮。");
    return;
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    highlights: state.highlights.map((entry, index) => ({
      order: index + 1,
      selector: entry.selector,
      description: entry.description,
      annotation: entry.annotation,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dom-highlights-${Date.now()}.json`;
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
    const highlights = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.highlights)
      ? parsed.highlights
      : null;
    if (!highlights) {
      throw new Error("高亮数据无效。");
    }

    state.highlights = highlights.map((item) => ({
      id: generateEntryId(),
      selector: item.selector || "",
      description: item.description || item.selector || "元素",
      annotation: item.annotation || "",
      active: false,
      status: "pending",
    }));
    renderHighlights();
  } catch (error) {
    alert("导入高亮失败，请检查 JSON 文件。");
  } finally {
    event.target.value = "";
  }
}

async function handleReplay() {
  if (state.highlights.length === 0) {
    alert("请先添加至少一个高亮再进行重播。");
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

  postToFrame({ type: "clear-all" });
  await delay(200);

  for (let i = 0; i < state.highlights.length; i++) {
    const entry = state.highlights[i];
    postToFrame({
      type: "replay-highlight",
      id: entry.id,
      selector: entry.selector,
      annotation: entry.annotation,
      order: i + 1,
    });
    await delay(400);
  }

  state.isReplaying = false;
  replayButton.disabled = false;
}

function replaySingleHighlight(entry) {
  if (!entry.selector) {
    alert("该高亮没有可用于重播的选择器。");
    return;
  }
  if (!state.frameReady) {
    alert("预览尚未就绪。");
    return;
  }
  postToFrame({
    type: "replay-highlight",
    id: entry.id,
    selector: entry.selector,
    annotation: entry.annotation,
    order: state.highlights.indexOf(entry) + 1,
  });
}

function syncOrdersToIframe() {
  if (!state.frameReady) {
    return;
  }
  state.highlights.forEach((entry, index) => {
    if (!entry.active) {
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

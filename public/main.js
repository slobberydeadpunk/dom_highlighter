const MESSAGE_FLAG = "__domHighlighter";

const form = document.getElementById("preview-form");
const input = document.getElementById("url-input");
const frame = document.getElementById("preview-frame");

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

window.addEventListener("message", handleFrameMessage);

function navigatePreview(url) {
  resetHighlights(true);
  state.frameReady = false;
  state.messageQueue = [];
  frame.src = `/render?url=${encodeURIComponent(url)}`;
}

function handleFrameMessage(event) {
  if (event.source !== frame.contentWindow) {
    return;
  }
  const data = event.data;
  if (!data || typeof data !== "object" || data[MESSAGE_FLAG] !== true) {
    return;
  }

  switch (data.type) {
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
      handleFrameError(data);
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
    description: payload.description || payload.selector || "Element",
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
    selector.textContent = entry.selector || "<no selector>";
    header.appendChild(label);
    header.appendChild(selector);

    const textarea = document.createElement("textarea");
    textarea.className = "highlight-annotation";
    textarea.placeholder = "Add notes or annotations...";
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
    highlightButton.textContent = "Highlight";
    highlightButton.addEventListener("click", () => {
      replaySingleHighlight(entry);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "highlight-remove";
    removeButton.textContent = "Remove";
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
    return "Element not found on the page.";
  }
  if (entry.status === "lock-failed") {
    return "Failed to highlight this element.";
  }
  if (!entry.active) {
    return "Stored locally. Replay to apply.";
  }
  return "Active on preview.";
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
    alert("No highlights to export yet.");
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
      throw new Error("Invalid highlight data.");
    }

    state.highlights = highlights.map((item) => ({
      id: generateEntryId(),
      selector: item.selector || "",
      description: item.description || item.selector || "Element",
      annotation: item.annotation || "",
      active: false,
      status: "pending",
    }));
    renderHighlights();
  } catch (error) {
    alert("Failed to import highlights. Please check the JSON file.");
  } finally {
    event.target.value = "";
  }
}

async function handleReplay() {
  if (state.highlights.length === 0) {
    alert("Add at least one highlight before replaying.");
    return;
  }
  if (state.isReplaying) {
    return;
  }
  if (!state.frameReady) {
    alert("Preview is still loading. Try again in a moment.");
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
    alert("This highlight does not have a selector to replay.");
    return;
  }
  if (!state.frameReady) {
    alert("Preview is not ready yet.");
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
  if (!frame.contentWindow) {
    return;
  }

  const payload = Object.assign({}, message, {
    [MESSAGE_FLAG]: true,
  });

  if (!state.frameReady && queue) {
    state.messageQueue.push(payload);
    return;
  }

  frame.contentWindow.postMessage(payload, window.location.origin);
}

function flushMessageQueue() {
  if (!state.frameReady || !frame.contentWindow) {
    return;
  }
  while (state.messageQueue.length) {
    const payload = state.messageQueue.shift();
    frame.contentWindow.postMessage(payload, window.location.origin);
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

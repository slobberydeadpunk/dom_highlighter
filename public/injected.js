(function domHighlighter() {
  if (window.__DOM_HIGHLIGHTER_INITIALIZED__) {
    return;
  }
  window.__DOM_HIGHLIGHTER_INITIALIZED__ = true;

  const HOVER_CLASS = "__dh-hover";
  const LOCKED_CLASS = "__dh-locked";
  const NOTE_ROOT_ID = "__dh-note-root";
  const NOTE_CLASS = "__dh-note";
  const NOTE_LOCKED_CLASS = "__dh-note--locked";
  const NOTE_EMPTY_CLASS = "__dh-note--empty";
  const NOTE_HIDDEN_ATTR = "data-hidden";
  const STYLE_ID = "__dh-style-link";

  const CONFIG = window.__DOM_HIGHLIGHTER_CONFIG__ || {};
  const ASSET_ORIGIN =
    typeof CONFIG.assetOrigin === "string" && CONFIG.assetOrigin.length
      ? CONFIG.assetOrigin
      : window.location.origin;
  const bridge =
    typeof window.__DOM_HIGHLIGHTER_BRIDGE__ === "object"
      ? window.__DOM_HIGHLIGHTER_BRIDGE__
      : null;

  const lockedEntries = new Map(); // Element -> entry
  const idToEntry = new Map(); // id -> entry

  let hoverTarget = null;
  let pendingTarget = null;
  let hasPendingHover = false;
  let hoverRafId = null;
  let notesRafId = null;

  ensureStyles();
  const noteRoot = ensureNoteRoot();
  observeDomMutations();
  bindEvents();
  beginHoverPoller();
  window.addEventListener("message", handleMessageEvent, false);
  if (bridge && typeof bridge.onMessage === "function") {
    bridge.onMessage((payload) => {
      handleParentPayload(payload, window.location.origin);
    });
  }
  notifyParent("ready", { href: window.location.href });
  console.log("[DOM Highlighter] injector initialised", window.location.href);

  function bindEvents() {
    const pointerOptions = { capture: true, passive: true };
    const nonPassiveCapture = { capture: true };

    const pointerHandler = (event) => {
      queueCandidate(event.target);
    };

    document.addEventListener("pointermove", pointerHandler, pointerOptions);
    document.addEventListener("pointerover", pointerHandler, pointerOptions);
    document.addEventListener("mousemove", pointerHandler, pointerOptions);

    document.addEventListener(
      "pointerleave",
      (event) => {
        if (!event.relatedTarget) {
          queueCandidate(null);
        }
      },
      nonPassiveCapture
    );

    document.addEventListener(
      "mouseleave",
      (event) => {
        if (!event.relatedTarget) {
          queueCandidate(null);
        }
      },
      nonPassiveCapture
    );

    document.addEventListener("click", handleClickLock, nonPassiveCapture);
    document.addEventListener(
      "dblclick",
      (event) => {
        const candidate = resolveTarget(event.target);
        if (!candidate) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        clearLock(candidate, { reason: "dblclick" });
      },
      nonPassiveCapture
    );

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          clearAllLocks();
        }
      },
      nonPassiveCapture
    );

    window.addEventListener(
      "scroll",
      () => {
        scheduleNotesUpdate();
      },
      true
    );

    window.addEventListener(
      "resize",
      () => {
        scheduleNotesUpdate();
      },
      true
    );
  }

  function beginHoverPoller() {
    let lastCandidate = null;

    const tick = () => {
      try {
        const hovered = document.querySelectorAll(":hover");
        const candidate =
          hovered.length > 0 ? hovered[hovered.length - 1] : null;
        if (candidate !== lastCandidate) {
          lastCandidate = candidate;
          queueCandidate(candidate);
        }
      } finally {
        window.requestAnimationFrame(tick);
      }
    };

    window.requestAnimationFrame(tick);
  }

  function handleClickLock(event) {
    const candidate = resolveTarget(event.target);
    if (!candidate) {
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    toggleLock(candidate);
  }

  function queueCandidate(target) {
    pendingTarget = resolveTarget(target);
    hasPendingHover = true;
    scheduleHoverUpdate();
  }

  function scheduleHoverUpdate() {
    if (hoverRafId !== null) {
      return;
    }
    hoverRafId = window.requestAnimationFrame(() => {
      hoverRafId = null;
      if (!hasPendingHover) {
        return;
      }
      hasPendingHover = false;
      applyHover(pendingTarget);
    });
  }

  function applyHover(target) {
    if (target === hoverTarget) {
      return;
    }

    if (hoverTarget && !idToEntry.has(getEntryId(hoverTarget))) {
      hoverTarget.classList.remove(HOVER_CLASS);
    } else if (hoverTarget && idToEntry.has(getEntryId(hoverTarget))) {
      hoverTarget.classList.add(HOVER_CLASS);
    }

    hoverTarget = target;

    if (hoverTarget) {
      hoverTarget.classList.add(HOVER_CLASS);
    }
  }

  function toggleLock(element) {
    const existing = lockedEntries.get(element);
    if (existing) {
      clearLock(existing, { reason: "toggle" });
      return;
    }
    lockElement(element);
  }

  function lockElement(
    element,
    {
      id,
      annotation = "",
      order = null,
      silent = false,
      selector: selectorOverride,
    } = {}
  ) {
    if (!(element instanceof Element)) {
      return null;
    }

    const current = lockedEntries.get(element);
    if (current) {
      if (annotation) {
        setAnnotationForEntry(current, annotation, order);
      }
      return current;
    }

    const existingById = id ? idToEntry.get(id) : null;
    if (existingById && existingById.element !== element) {
      clearLock(existingById, { silent: true, reason: "id-reuse" });
    }

    const entryId = id || generateId();
    const selector = selectorOverride || buildSelector(element);
    const description = describeElement(element);
    const noteEl = createNoteElement(entryId);
    const entry = {
      id: entryId,
      element,
      selector,
      description,
      annotation,
      order: typeof order === "number" ? order : null,
      noteEl,
    };

    lockedEntries.set(element, entry);
    idToEntry.set(entryId, entry);
    element.classList.add(LOCKED_CLASS);
    noteRoot.appendChild(noteEl);
    updateNoteContent(entry);
    updateNotePosition(entry);

    if (!silent) {
      notifyParent("lock", {
        id: entryId,
        selector,
        description,
      });
    }

    scheduleNotesUpdate();
    return entry;
  }

  function clearLock(target, { silent = false, reason = "removed" } = {}) {
    const entry = resolveEntry(target);
    if (!entry) {
      return;
    }

    lockedEntries.delete(entry.element);
    idToEntry.delete(entry.id);

    entry.element.classList.remove(LOCKED_CLASS);
    if (entry.element !== hoverTarget) {
      entry.element.classList.remove(HOVER_CLASS);
    }

    if (entry.noteEl && entry.noteEl.parentNode) {
      entry.noteEl.parentNode.removeChild(entry.noteEl);
    }

    if (!silent) {
      notifyParent("unlock", { id: entry.id, reason });
    }
  }

  function clearAllLocks() {
    for (const entry of Array.from(idToEntry.values())) {
      clearLock(entry, { reason: "clear-all" });
    }
  }

  function setAnnotationForEntry(entry, annotation, order) {
    if (!entry) {
      return;
    }
    entry.annotation = annotation || "";
    if (typeof order === "number" && Number.isFinite(order)) {
      entry.order = order;
    }
    updateNoteContent(entry);
    updateNotePosition(entry);
  }

  function createNoteElement(id) {
    const note = document.createElement("div");
    note.className = NOTE_CLASS;
    note.setAttribute("data-note-id", id);
    note.setAttribute("data-dh-ignore", "true");
    note.setAttribute(NOTE_HIDDEN_ATTR, "true");

    const orderEl = document.createElement("div");
    orderEl.className = "__dh-note-order";
    note.appendChild(orderEl);

    const textEl = document.createElement("div");
    textEl.className = "__dh-note-text";
    note.appendChild(textEl);

    return note;
  }

  function updateNoteContent(entry) {
    if (!entry || !entry.noteEl) {
      return;
    }
    const { noteEl } = entry;
    const orderEl = noteEl.querySelector(".__dh-note-order");
    const textEl = noteEl.querySelector(".__dh-note-text");

    const annotation = (entry.annotation || "").trim();
    const hasAnnotation = annotation.length > 0;

    if (!hasAnnotation) {
      if (orderEl) {
        orderEl.textContent = "";
      }
      if (textEl) {
        textEl.textContent = "";
      }
      noteEl.classList.remove(NOTE_LOCKED_CLASS);
      noteEl.classList.add(NOTE_EMPTY_CLASS);
      noteEl.setAttribute(NOTE_HIDDEN_ATTR, "true");
      return;
    }

    if (orderEl) {
      orderEl.textContent =
        typeof entry.order === "number" && entry.order > 0
          ? `#${entry.order}`
          : "#";
    }

    if (textEl) {
      textEl.textContent = annotation;
    }

    noteEl.classList.add(NOTE_LOCKED_CLASS);
    noteEl.classList.remove(NOTE_EMPTY_CLASS);
    noteEl.setAttribute(NOTE_HIDDEN_ATTR, "false");
  }

  function updateNotePosition(entry) {
    if (!entry || !entry.noteEl) {
      return;
    }

    if (!document.contains(entry.element)) {
      clearLock(entry, { reason: "detached" });
      return;
    }

    const annotation = (entry.annotation || "").trim();
    if (!annotation) {
      entry.noteEl.setAttribute(NOTE_HIDDEN_ATTR, "true");
      return;
    }

    const rect = entry.element.getBoundingClientRect();
    const hidden =
      !rect || rect.width === 0 || rect.height === 0 || !isFinite(rect.top);

    if (hidden) {
      entry.noteEl.setAttribute(NOTE_HIDDEN_ATTR, "true");
      return;
    }

    const top = rect.top + window.scrollY;
    const left = rect.left + window.scrollX;

    entry.noteEl.style.transform = `translate(${left}px, ${Math.max(
      0,
      top - entry.noteEl.offsetHeight - 8
    )}px)`;
    entry.noteEl.setAttribute(NOTE_HIDDEN_ATTR, "false");
  }

  function scheduleNotesUpdate() {
    if (notesRafId !== null) {
      return;
    }
    notesRafId = window.requestAnimationFrame(() => {
      notesRafId = null;
      for (const entry of idToEntry.values()) {
        updateNotePosition(entry);
      }
    });
  }

  function ensureStyles() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) {
      return;
    }
    const link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = `${ASSET_ORIGIN}/injected.css`;
    link.type = "text/css";
    link.setAttribute("data-dh-ignore", "true");
    (document.head || document.documentElement).appendChild(link);
  }

  function ensureNoteRoot() {
    let root = document.getElementById(NOTE_ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = NOTE_ROOT_ID;
      root.setAttribute("data-dh-ignore", "true");
      root.style.position = "absolute";
      root.style.top = "0";
      root.style.left = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483647";
      (document.body || document.documentElement).appendChild(root);
    }
    return root;
  }

  function observeDomMutations() {
    const observer = new MutationObserver((mutations) => {
      let stylesRemoved = false;

      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          stylesRemoved =
            stylesRemoved ||
            Array.from(mutation.removedNodes).some((node) => {
              if (!(node instanceof Element)) {
                return false;
              }
              if (node.id === STYLE_ID) {
                return true;
              }
              return !!node.querySelector && !!node.querySelector(`#${STYLE_ID}`);
            });
        }

        for (const removedNode of mutation.removedNodes) {
          if (removedNode instanceof Element) {
            handleNodeRemoval(removedNode);
          }
        }
      }

      if (stylesRemoved) {
        ensureStyles();
      }
    });

    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  }

  function handleNodeRemoval(node) {
    const affected = [];
    for (const entry of idToEntry.values()) {
      if (!document.contains(entry.element)) {
        affected.push(entry);
        continue;
      }
      if (node === entry.element || node.contains(entry.element)) {
        affected.push(entry);
      }
    }
    for (const entry of affected) {
      clearLock(entry, { reason: "detached" });
    }
  }

  function handleMessageEvent(event) {
    if (!event) {
      return;
    }
    handleParentPayload(event.data, event.origin);
  }

  function handleParentPayload(data, origin) {
    if (!data || typeof data !== "object" || data.__domHighlighter !== true) {
      return;
    }

    switch (data.type) {
      case "set-annotation":
        handleSetAnnotationMessage(data);
        break;
      case "remove-highlight":
        handleRemoveHighlightMessage(data);
        break;
      case "clear-all":
        handleClearAllMessage();
        break;
      case "replay-highlight":
        handleReplayHighlightMessage(data);
        break;
      default:
        break;
    }
  }

  function handleSetAnnotationMessage(message) {
    if (!message || !message.id) {
      return;
    }
    const entry = idToEntry.get(message.id);
    if (!entry) {
      return;
    }
    setAnnotationForEntry(
      entry,
      typeof message.annotation === "string" ? message.annotation : "",
      typeof message.order === "number" ? message.order : entry.order
    );
  }

  function handleRemoveHighlightMessage(message) {
    if (!message || !message.id) {
      return;
    }
    const entry = idToEntry.get(message.id);
    if (!entry) {
      return;
    }
    clearLock(entry, { silent: true, reason: "parent-remove" });
  }

  function handleClearAllMessage() {
    for (const entry of Array.from(idToEntry.values())) {
      clearLock(entry, { silent: true, reason: "parent-clear" });
    }
  }

  function handleReplayHighlightMessage(message) {
    if (!message || !message.selector || !message.id) {
      return;
    }

    const element = safeQuerySelector(message.selector);
    if (!element) {
      notifyParent("error", {
        id: message.id,
        code: "not-found",
        selector: message.selector,
      });
      return;
    }

    const entry = lockElement(element, {
      id: message.id,
      annotation:
        typeof message.annotation === "string" ? message.annotation : "",
      order:
        typeof message.order === "number" ? message.order : undefined,
      selector: message.selector,
      silent: true,
    });

    if (!entry) {
      notifyParent("error", {
        id: message.id,
        code: "lock-failed",
        selector: message.selector,
      });
      return;
    }

    setAnnotationForEntry(
      entry,
      typeof message.annotation === "string" ? message.annotation : "",
      typeof message.order === "number" ? message.order : entry.order
    );
    applyHover(entry.element);
    notifyParent("replay-applied", {
      id: message.id,
      selector: message.selector,
    });
  }

  function safeQuerySelector(selector) {
    try {
      return document.querySelector(selector);
    } catch (error) {
      return null;
    }
  }

  function resolveTarget(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    if (node.hasAttribute("data-dh-ignore")) {
      return null;
    }

    const forbidden = new Set([
      "html",
      "head",
      "meta",
      "title",
      "script",
      "style",
      "link",
      "base",
    ]);

    let current = node;
    while (current && current !== document.documentElement) {
      if (current.hasAttribute("data-dh-ignore")) {
        return null;
      }
      const tag = current.tagName.toLowerCase();
      if (!forbidden.has(tag)) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  function resolveEntry(target) {
    if (!target) {
      return null;
    }
    if (typeof target === "string") {
      return idToEntry.get(target) || null;
    }
    if (lockedEntries.has(target)) {
      return lockedEntries.get(target);
    }
    if (typeof target === "object" && target.element && lockedEntries.has(target.element)) {
      return lockedEntries.get(target.element);
    }
    return null;
  }

  function buildSelector(element) {
    if (!element || !(element instanceof Element)) {
      return "";
    }

    if (element.id && isCssIdentSafe(element.id)) {
      return `#${cssEscape(element.id)}`;
    }

    const parts = [];
    let node = element;

    while (node && node !== document.documentElement) {
      let selector = node.tagName.toLowerCase();

      if (!selector) {
        break;
      }

      if (node.id && isCssIdentSafe(node.id)) {
        selector += `#${cssEscape(node.id)}`;
        parts.unshift(selector);
        break;
      }

      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(
            (child) => child.tagName === node.tagName
          )
        : [];

      if (siblings.length > 1) {
        const index =
          siblings.indexOf(node) >= 0 ? siblings.indexOf(node) + 1 : 1;
        selector += `:nth-of-type(${index})`;
      }

      parts.unshift(selector);
      node = node.parentElement;
    }

    return parts.length ? parts.join(" > ") : element.tagName.toLowerCase();
  }

  function describeElement(element) {
    if (!element || !(element instanceof Element)) {
      return "";
    }
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const className = element.classList.length
      ? "." + Array.from(element.classList).slice(0, 3).join(".")
      : "";
    const rect = element.getBoundingClientRect();
    const size =
      rect && rect.width && rect.height
        ? ` (${Math.round(rect.width)}×${Math.round(rect.height)})`
        : "";
    return `${tag}${id}${className}${size}`;
  }

  function generateId() {
    return `dh_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function notifyParent(type, payload) {
    const message = Object.assign({}, payload, {
      __domHighlighter: true,
      type,
    });
    try {
      if (bridge && typeof bridge.send === "function") {
        bridge.send(message);
        return;
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, "*");
      }
    } catch (error) {
      // Swallow cross-origin errors silently.
    }
  }

  function getEntryId(element) {
    const entry = lockedEntries.get(element);
    return entry ? entry.id : null;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }

  function isCssIdentSafe(value) {
    return !/[\s"'`]/.test(value);
  }
})();

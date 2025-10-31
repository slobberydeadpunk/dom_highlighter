(function domHighlighter() {
  if (window.__DOM_HIGHLIGHTER_INITIALIZED__) {
    return;
  }
  window.__DOM_HIGHLIGHTER_INITIALIZED__ = true;

  const HOVER_CLASS = "__dh-hover";
  const LOCKED_CLASS = "__dh-locked";

  const STYLE_ID = "__dh-style-link";
  const CONFIG = window.__DOM_HIGHLIGHTER_CONFIG__ || {};
  const ASSET_ORIGIN =
    typeof CONFIG.assetOrigin === "string" && CONFIG.assetOrigin.length
      ? CONFIG.assetOrigin
      : window.location.origin;
  const lockedElements = new Set();
  let hoverTarget = null;
  let pendingTarget = null;
  let hasPendingQueued = false;
  let rafId = null;

  ensureStyles();
  const removalObserver = new MutationObserver(handleMutations);
  observeRemovals();
  bindEvents();
  beginHoverPoller();

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
    document.addEventListener("dblclick", handleDoubleClickUnlock, nonPassiveCapture);

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          clearLocks();
        }
      },
      nonPassiveCapture
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

  function handleDoubleClickUnlock(event) {
    const candidate = resolveTarget(event.target);
    if (!candidate) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    clearLock(candidate);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
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

  function queueCandidate(target) {
    pendingTarget = resolveTarget(target);
    hasPendingQueued = true;
    scheduleHoverUpdate();
  }

  function scheduleHoverUpdate() {
    if (rafId !== null) {
      return;
    }
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      if (!hasPendingQueued) {
        return;
      }
      hasPendingQueued = false;
      applyHover(pendingTarget);
  });
  }

  function applyHover(target) {
    if (target === hoverTarget) {
      return;
    }

    if (hoverTarget) {
      hoverTarget.classList.remove(HOVER_CLASS);
    }

    hoverTarget = target;

    if (hoverTarget) {
      hoverTarget.classList.add(HOVER_CLASS);
    }
  }

  function toggleLock(element) {
    if (lockedElements.has(element)) {
      clearLock(element);
      return;
    }

    lockedElements.add(element);
    element.classList.add(LOCKED_CLASS);
  }

  function clearLock(element) {
    if (!lockedElements.has(element)) {
      return;
    }
    lockedElements.delete(element);
    element.classList.remove(LOCKED_CLASS);
    if (element === hoverTarget) {
      element.classList.add(HOVER_CLASS);
    } else {
      element.classList.remove(HOVER_CLASS);
    }
  }

  function clearLocks() {
    for (const element of lockedElements) {
      element.classList.remove(LOCKED_CLASS);
      if (element === hoverTarget) {
        element.classList.add(HOVER_CLASS);
      } else {
        element.classList.remove(HOVER_CLASS);
      }
    }
    lockedElements.clear();
  }

  function resolveTarget(node) {
    const forbiddenTags = new Set([
      "html",
      "head",
      "title",
      "meta",
      "script",
      "style",
      "link",
      "base",
    ]);

    const initial = node;
    let current = node instanceof Element ? node : null;

    while (current && current !== document.documentElement) {
      if (current.hasAttribute("data-dh-ignore")) {
        return null;
      }

      const tag = current.tagName.toLowerCase();
      if (!forbiddenTags.has(tag)) {
        return current;
      }

      current = current.parentElement;
    }

    if (initial === document.body) {
      return document.body;
    }
    return null;
  }

  function observeRemovals() {
    removalObserver.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  }

  function handleMutations(mutations) {
    let styleRemoved = false;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        styleRemoved =
          styleRemoved ||
          Array.from(mutation.removedNodes).some(
            (node) =>
              node instanceof Element &&
              (node.id === STYLE_ID ||
                !!(node.querySelector && node.querySelector(`#${STYLE_ID}`)))
          );
      }
      for (const removedNode of mutation.removedNodes) {
        if (removedNode instanceof Element) {
          cleanRemoved(removedNode);
        }
      }
    }
    if (styleRemoved) {
      ensureStyles();
    }
  }

  function cleanRemoved(node) {
    if (lockedElements.has(node)) {
      node.classList.remove(LOCKED_CLASS);
      lockedElements.delete(node);
    }
    if (node === hoverTarget) {
      node.classList.remove(HOVER_CLASS);
      hoverTarget = null;
    }

    const descendants =
      node.querySelectorAll &&
      node.querySelectorAll(`.${HOVER_CLASS},.${LOCKED_CLASS}`);
    if (!descendants) {
      return;
    }
    for (const descendant of descendants) {
      descendant.classList.remove(HOVER_CLASS);
      descendant.classList.remove(LOCKED_CLASS);
      lockedElements.delete(descendant);
      if (descendant === hoverTarget) {
        hoverTarget = null;
      }
    }
  }
})();

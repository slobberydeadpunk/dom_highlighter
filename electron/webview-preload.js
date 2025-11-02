const { contextBridge, ipcRenderer, webFrame } = require("electron");

const HOST_CHANNEL = "dom-highlighter";

const hostMessageListeners = new Set();

/**
 * Expose a very small bridge for the injected highlighter script so it can
 * communicate with the host renderer when running inside Electron.
 */
contextBridge.exposeInMainWorld("__DOM_HIGHLIGHTER_BRIDGE__", {
  send(message) {
    ipcRenderer.sendToHost(HOST_CHANNEL, message);
  },
  onMessage(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    hostMessageListeners.add(callback);
    return () => {
      hostMessageListeners.delete(callback);
    };
  },
});

ipcRenderer.sendToHost(HOST_CHANNEL, {
  __domHighlighter: true,
  type: "bridge-ready",
});

ipcRenderer.on(HOST_CHANNEL, (_event, payload) => {
  if (payload && payload.__domHighlighter === true) {
    if (payload.type === "inject-assets") {
      injectAssets(payload).catch(() => {
        // Errors are reported inside injectAssets.
      });
      return;
    }
  }

  dispatchToBridgeListeners(payload);
  dispatchToWindow(payload);
});

/**
 * For the legacy message-based path we still dispatch a synthetic message
 * event so the existing handler in the injected script remains unchanged.
 * @param {unknown} payload
 */
function dispatchToWindow(payload) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: payload,
      origin: window.location.origin,
      source: window.parent || window,
    })
  );
}

/**
 * Invokes any bridge-specific listeners the injected script might have
 * registered (used to avoid relying solely on postMessage semantics).
 * @param {unknown} payload
 */
function dispatchToBridgeListeners(payload) {
  for (const listener of hostMessageListeners) {
    try {
      listener(payload);
    } catch (error) {
      // Suppress individual listener failures—logging here would be noisy.
    }
  }
}

/**
 * Injects the highlighter stylesheet and script bundle into the guest page.
 * @param {{css?: string, js?: string, config?: Record<string, unknown>}} payload
 */
async function injectAssets(payload) {
  if (!payload || typeof payload.css !== "string" || typeof payload.js !== "string") {
    ipcRenderer.sendToHost(HOST_CHANNEL, {
      __domHighlighter: true,
      type: "error",
      message: "Host did not provide preview assets.",
    });
    return;
  }

  try {
    const jsConfig = JSON.stringify(payload.config || {});
    const cssText = JSON.stringify(payload.css);

    await webFrame.executeJavaScript(
      `(() => {
        const existing = document.getElementById('__dh-style-link');
        if (!existing) {
          const style = document.createElement('style');
          style.id = '__dh-style-link';
          style.setAttribute('data-dh-ignore', 'true');
          style.textContent = ${cssText};
          const target = document.head || document.documentElement;
          if (target) {
            target.appendChild(style);
          }
        }
      })();`,
      true
    );

    await webFrame.executeJavaScript(
      `(() => {
        const incoming = ${jsConfig};
        if (incoming && typeof incoming === 'object') {
          window.__DOM_HIGHLIGHTER_CONFIG__ = Object.assign({}, window.__DOM_HIGHLIGHTER_CONFIG__ || {}, incoming);
        }
      })();`,
      true
    );

    await webFrame.executeJavaScript(payload.js, true);

    ipcRenderer.sendToHost(HOST_CHANNEL, {
      __domHighlighter: true,
      type: "injection-complete",
    });
  } catch (error) {
    ipcRenderer.sendToHost(HOST_CHANNEL, {
      __domHighlighter: true,
      type: "error",
      message: "Failed to inject preview helpers.",
    });
  }
}

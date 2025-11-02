const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");

const webviewPreloadPath = path.join(__dirname, "webview-preload.js");

contextBridge.exposeInMainWorld("domHighlighterBridge", {
  isElectron: true,
  /**
   * Provides the absolute path that the <webview> element should use for its
   * preload script. Returning a function keeps the value stringified only when
   * needed, which avoids serialisation quirks across platforms.
   * @returns {string}
   */
  getWebviewPreloadPath() {
    return webviewPreloadPath;
  },
  async getInjectedAssets() {
    try {
      const assets = await ipcRenderer.invoke("dom-highlighter:get-assets");
      return assets || null;
    } catch (_error) {
      return null;
    }
  },
});

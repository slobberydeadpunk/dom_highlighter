const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

let cachedInjectedAssets = null;

function loadInjectedAssets() {
  if (cachedInjectedAssets) {
    return cachedInjectedAssets;
  }
  const projectRoot = path.join(__dirname, "..");
  const publicDir = path.join(projectRoot, "public");
  const cssPath = path.join(publicDir, "injected.css");
  const jsPath = path.join(publicDir, "injected.js");

  cachedInjectedAssets = {
    css: fs.readFileSync(cssPath, "utf8"),
    js: fs.readFileSync(jsPath, "utf8"),
  };

  return cachedInjectedAssets;
}

/**
 * Creates the main renderer window, which hosts the DOM Highlighter UI
 * alongside an embedded Chromium-powered preview surface.
 */
function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      webviewTag: true,
      sandbox: false,
    },
  });

  window.loadFile(path.join(__dirname, "..", "public", "index.html"));
  window.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  ipcMain.handle("dom-highlighter:get-assets", () => loadInjectedAssets());

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

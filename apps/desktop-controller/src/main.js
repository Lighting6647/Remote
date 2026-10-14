import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

ipcMain.handle("clipboard:read", async () => (await clipboard.readText()).slice(0, 1_000_000));
ipcMain.handle("clipboard:write", async (_event, text) => {
  await clipboard.writeText(String(text).slice(0, 1_000_000));
  return true;
});

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: "IT Remote Support Console",
    icon: path.join(directory, "app-icon.png"),
    backgroundColor: "#080c14",
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadFile(path.join(directory, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

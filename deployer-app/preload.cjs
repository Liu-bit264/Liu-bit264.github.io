const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deployer", {
  getState: () => ipcRenderer.invoke("get-state"),
  setRepo: () => ipcRenderer.invoke("set-repo"),
  pickDir: () => ipcRenderer.invoke("pick-dir"),
  parsePosts: (p) => ipcRenderer.invoke("parse-posts", p),
  deploy: (p) => ipcRenderer.invoke("deploy", p),
  waitDeploy: (p) => ipcRenderer.invoke("wait-deploy", p),
  onLog: (cb) => ipcRenderer.on("deploy-log", (_e, line) => cb(line)),
});

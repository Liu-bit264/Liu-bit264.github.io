import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import {
  scanDirectory,
  deployPosts,
  waitForWorkflow,
  parseFrontmatter,
  buildFrontmatter,
  findImageRefs,
  resolveImageRef,
  slugify,
  pathExists,
} from "./core.mjs";

// ESM 主进程没有 __dirname，手动推导（打包后位于 app.asar 内）
const APP_DIR = dirname(fileURLToPath(import.meta.url));

// 未捕获异常写入日志，避免窗口静默创建失败
process.on("uncaughtException", (err) => {
  try {
    appendFileSync(
      join(app.getPath("userData"), "error.log"),
      `${new Date().toISOString()}\n${err.stack || err}\n\n`,
    );
  } catch {
    /* 忽略日志失败 */
  }
});

const DEFAULT_REPO = "E:\\Repositories\\Liu-bit264.github.io";
const GH_REPO = "Liu-bit264/Liu-bit264.github.io";

// 仓库路径：优先用户配置，其次默认路径；打包后配置存 userData 持久化
async function loadRepoPath() {
  try {
    const cfg = JSON.parse(
      await readFile(join(app.getPath("userData"), "config.json"), "utf8"),
    );
    if (cfg.repoPath && (await pathExists(cfg.repoPath))) return cfg.repoPath;
  } catch {
    /* 首次运行无配置 */
  }
  if (await pathExists(join(DEFAULT_REPO, ".git"))) return DEFAULT_REPO;
  return null;
}

async function saveRepoPath(p) {
  const file = join(app.getPath("userData"), "config.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ repoPath: p }, null, 2));
  return p;
}

let repoRoot = null;

function ipc(channel, handler) {
  ipcMain.handle(channel, (_e, payload) => handler(payload));
}

ipc("get-state", async () => {
  repoRoot ??= await loadRepoPath();
  return {
    repoRoot,
    liveUrl: "https://liu-bit264.github.io/",
    repoUrl: `https://github.com/${GH_REPO}`,
  };
});

ipc("set-repo", async () => {
  const r = await dialog.showOpenDialog({
    title: "选择博客仓库根目录（包含 .git 与 src）",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  repoRoot = await saveRepoPath(r.filePaths[0]);
  return repoRoot;
});

ipc("pick-dir", async () => {
  const r = await dialog.showOpenDialog({
    title: "选择包含 .md 文章（及图片）的文件夹",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  const { mdFiles, files } = await scanDirectory(dir);
  return { dir, mdFiles, fileCount: files.length };
});

ipc("parse-posts", async ({ dir, rels }) => {
  const { files } = await scanDirectory(dir);
  const out = [];
  for (const rel of rels) {
    const md = await readFile(join(dir, rel), "utf8");
    const { fm, body } = parseFrontmatter(md);
    const { title, description } = buildFrontmatter(
      fm,
      body,
      rel.split("/").pop(),
    );
    const mdDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const images = findImageRefs(md).map((ref) => ({
      ref,
      resolved: resolveImageRef(ref, mdDir, files),
    }));
    out.push({
      rel,
      slug: slugify(rel),
      title,
      description,
      date: fm.pubDatetime || "（发布时自动填写）",
      tags: Array.isArray(fm.tags) ? fm.tags : null,
      category: fm.category || null,
      images,
    });
  }
  return out;
});

ipc("deploy", async ({ dir, rels }) => {
  const io = {
    log: (line) => mainWindow?.webContents.send("deploy-log", line),
  };
  const result = await deployPosts(repoRoot, { dir, rels }, io);
  return result;
});

ipc("wait-deploy", ({ sha }) => waitForWorkflow(sha, GH_REPO));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    backgroundColor: "#18181b",
    webPreferences: {
      preload: join(APP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadFile(join(APP_DIR, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

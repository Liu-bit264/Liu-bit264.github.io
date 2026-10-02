/**
 * 文章部署器（本地运行）
 *
 * 用法：pnpm deploy  （或 node scripts/deployer.mjs）
 * 然后浏览器打开 http://localhost:8787 ，选择包含 .md 文章与图片的文件夹，
 * 勾选文章并部署。工具会：
 *   1. 解析/补全 frontmatter（title、pubDatetime、description、tags、category）
 *   2. 把文中引用的本地图片拷入 public/images/<slug>/ 并改写为根路径
 *   3. git 提交并推送到 main，自动触发 deploy-pages.yml 构建部署
 *   4. 轮询 Actions 运行状态并给出结果链接
 *
 * 仅使用 Node 内置模块；git 与 gh CLI 需在 PATH 中。
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { dirname, join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const PORT = Number(process.env.DEPLOYER_PORT || 8787);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = join(REPO_ROOT, "src", "content", "posts");
const IMAGES_DIR = join(REPO_ROOT, "public", "images");
const BRANCH = "main";
const WORKFLOW = "deploy-pages.yml";
const MAX_BODY = 80 * 1024 * 1024; // 80MB

// ---------------------------------------------------------------- utilities

function slugify(name) {
  let s = name.replace(/\.(md|markdown|mdx)$/i, "").trim();
  s = s.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-");
  // 与 Astro 内容 slug 一致：ASCII 字母转小写
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return s || `post-${Date.now()}`;
}

function yamlEscape(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function nowIsoShanghai() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace("Z", "+08:00");
}

/** 解析现有 frontmatter（够用即可，不做完整 YAML） */
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  let curKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s+-\s+/.test(line) && curKey) {
      (fm[curKey] ??= []).push(line.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "").trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      curKey = kv[1];
      let v = kv[2].trim();
      if (v === "") fm[curKey] = null;
      else fm[curKey] = v.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: md.slice(m[0].length) };
}

function buildFrontmatter(fm, body, filename) {
  const title = fm.title || (body.match(/^#\s+(.+)$/m) || [])[1]?.trim() ||
    filename.replace(/\.(md|markdown|mdx)$/i, "");
  const pubDatetime = fm.pubDatetime || nowIsoShanghai();
  let description = fm.description || "";
  if (!description) {
    const line = body
      .split("\n")
      .map((l) => l.trim())
      .find(
        (l) =>
          l &&
          !l.startsWith("#") &&
          !l.startsWith("!") &&
          !l.startsWith("[") &&
          !l.startsWith("|") &&
          !l.includes("$") &&
          !l.includes("\\") &&
          l !== "---",
      );
    description = line ? line.replace(/[*`]/g, "").slice(0, 90) : title;
  }
  const tags = Array.isArray(fm.tags) && fm.tags.length ? fm.tags : ["others"];
  const category = fm.category || "未分类";
  const out = [
    "---",
    `title: ${yamlEscape(title)}`,
    `pubDatetime: ${pubDatetime}`,
    `description: ${yamlEscape(description)}`,
    `category: ${yamlEscape(category)}`,
    `tags:`,
    ...tags.map((t) => `  - ${t}`),
    "---",
    "",
  ];
  return { frontmatter: out.join("\n"), title };
}

function safeSlug(s) {
  if (!/^[^/\\]+$/.test(s) || s.includes("..")) return null;
  return s;
}

async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, {
    cwd: REPO_ROOT,
    timeout: opts.timeout ?? 120000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- git & deploy

async function gitPushAndReport(titles) {
  await run("git", ["add", "-A"]);
  const { stdout: status } = await run("git", ["status", "--porcelain"]);
  if (!status) return { pushed: false, reason: "没有需要提交的变更" };
  const msg = `Publish: ${titles.join("、")} (via deployer)`;
  await run("git", ["commit", "-m", msg]);
  await run("git", ["push", "origin", BRANCH], { timeout: 180000 });
  const { stdout: sha } = await run("git", ["rev-parse", "HEAD"]);
  return { pushed: true, sha: sha.trim(), message: msg };
}

async function waitForWorkflow(sha, maxMs = 8 * 60 * 1000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const { stdout } = await run(
        "gh",
        [
          "run", "list",
          "--repo", "Liu-bit264/Liu-bit264.github.io",
          "--workflow", WORKFLOW,
          "--limit", "5",
          "--json", "headSha,status,conclusion,url,displayTitle",
        ],
        { timeout: 30000 },
      );
      const runs = JSON.parse(stdout || "[]");
      const mine = runs.find((r) => r.headSha === sha);
      if (mine) {
        if (mine.status === "completed") {
          return {
            done: true,
            ok: mine.conclusion === "success",
            conclusion: mine.conclusion,
            url: mine.url,
          };
        }
        return { done: false, url: mine.url };
      }
    } catch {
      // gh 偶发失败时继续轮询
    }
  }
  return { done: false, url: null, timeout: true };
}

// ---------------------------------------------------------------- http server

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function handleDeploy(body, res) {
  const posts = Array.isArray(body?.posts) ? body.posts : [];
  if (!posts.length) return json(res, 400, { error: "没有文章" });
  const titles = [];
  const slugs = [];
  try {
    for (const p of posts) {
      const slug = safeSlug(String(p.slug || ""));
      if (!slug) return json(res, 400, { error: `非法 slug: ${p.slug}` });
      const md = String(p.md || "");
      if (!md.trim()) return json(res, 400, { error: "文章内容为空" });
      const { fm, body: rawBody } = parseFrontmatter(md);
      const { frontmatter, title } = buildFrontmatter(fm, rawBody, slug + ".md");
      // 写图片
      for (const img of Array.isArray(p.images) ? p.images : []) {
        const target = safeSlug(String(img.target || ""));
        if (!target) throw new Error(`非法图片路径: ${img.target}`);
        const buf = Buffer.from(String(img.b64 || ""), "base64");
        const dest = join(IMAGES_DIR, slug, target);
        if (!dest.startsWith(IMAGES_DIR)) throw new Error("图片路径越界");
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, buf);
      }
      const file = join(POSTS_DIR, `${slug}.md`);
      await mkdir(POSTS_DIR, { recursive: true });
      await writeFile(file, frontmatter + "\n" + rawBody.replace(/^\s+/, "") , "utf8");
      titles.push(title);
      slugs.push(slug);
    }
    const result = await gitPushAndReport(titles);
    if (!result.pushed) {
      return json(res, 200, { ...result, posts: slugs });
    }
    json(res, 200, { ...result, posts: slugs, liveUrl: "https://liu-bit264.github.io/" });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
}

const UI_HTML = `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>文章部署器 · Liu-bit264</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 780px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; } .muted { color: #888; font-size: 13px; }
  button { padding: 8px 16px; border-radius: 8px; border: 1px solid #8884; cursor: pointer; }
  button.primary { background: #2563eb; color: #fff; border: none; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .post { border: 1px solid #8884; border-radius: 10px; padding: 12px 16px; margin: 10px 0; }
  .post h3 { margin: 0 0 6px; font-size: 15px; }
  .imgs { font-size: 12px; color: #888; }
  .img-ok { color: #16a34a; } .img-miss { color: #dc2626; }
  pre { background: #8881; padding: 10px; border-radius: 8px; overflow: auto; font-size: 12px; }
  #log { min-height: 20px; white-space: pre-wrap; }
  a { color: #2563eb; }
</style>
</head>
<body>
<h1>文章部署器</h1>
<p class="muted">选择包含 .md 文章（及文中引用图片）的文件夹 → 勾选文章 → 部署。发布后自动提交推送并触发博客构建。</p>
<p><button id="pick">① 选择文章文件夹</button> <span id="dirname" class="muted"></span></p>
<div id="list"></div>
<p><button id="deploy" class="primary" disabled>② 部署选中的文章</button></p>
<pre id="log"></pre>
<p id="result"></p>
<script type="module">
const logEl = document.getElementById('log');
const log = (s) => { logEl.textContent += s + "\\n"; };
let dirHandle = null, dirFiles = new Map(); // relpath -> handle
let scanned = [];

const isMd = (n) => /\\.(md|markdown)$/i.test(n);

async function iterDir(handle, prefix, depth) {
  if (depth > 3) return;
  for await (const entry of handle.values()) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.kind === 'file') {
      dirFiles.set(rel, entry);
      if (isMd(entry.name)) scanned.push({ rel, handle: entry });
    } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
      await iterDir(entry, rel, depth + 1);
    }
  }
}

async function readText(handle) { return await (await handle.getFile()).text(); }
async function readB64(handle) {
  const buf = await (await handle.getFile()).arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function findRefByName(name) {
  const lower = name.toLowerCase();
  for (const [rel, h] of dirFiles) if (rel.toLowerCase().endsWith('/' + lower) || rel.toLowerCase() === lower) return { rel, h };
  return null;
}

function normalizeRef(ref, mdDir) {
  try { ref = decodeURIComponent(ref); } catch {}
  ref = ref.replace(/\\\\/g, '/').replace(/^\\.\\//, '');
  if (mdDir && !ref.startsWith('../')) return mdDir + '/' + ref;
  // 处理 ../：逐段回退
  const parts = (mdDir ? mdDir.split('/') : []).concat(ref.split('/'));
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

async function parsePost(item) {
  const md = await readText(item.handle);
  const mdDir = item.rel.includes('/') ? item.rel.slice(0, item.rel.lastIndexOf('/')) : '';
  const refs = [...md.matchAll(/!\\[[^\\]]*\\]\\(\\s*([^)\\s]+)/g)].map(m => m[1])
    .concat([...md.matchAll(/<img[^>]+src=["']([^"']+)["']/g)].map(m => m[1]));
  const images = [], status = [];
  for (const raw of [...new Set(refs)]) {
    if (/^(https?:|data:|mailto:)/i.test(raw) || raw.startsWith('/')) {
      status.push({ ref: raw, ok: null, note: '外链/站点路径，原样保留' });
      continue;
    }
    const rel = normalizeRef(raw, mdDir);
    let hit = dirFiles.get(rel) || findRefByName(rel.split('/').pop());
    if (!hit) { status.push({ ref: raw, ok: false, note: '未在所选文件夹中找到' }); continue; }
    images.push({ name: hit.rel, b64: await readB64(hit.h) });
    status.push({ ref: raw, ok: true, note: hit.rel });
  }
  const fmMatch = md.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);
  const fm = {};
  if (fmMatch) for (const line of fmMatch[1].split(/\\r?\\n/)) {
    const kv = line.match(/^([A-Za-z_][\\w-]*):\\s*(.*)$/);
    if (kv && kv[2].trim()) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  const title = fm.title || (md.match(/^#\\s+(.+)$/m) || [])[1]?.trim() || item.rel.split('/').pop();
  const date = fm.pubDatetime || '（发布时自动填写）';
  return { item, md, title, date, images, status };
}

function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  scanned.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'post';
    div.innerHTML = \`<h3><input type="checkbox" data-i="\${i}" checked> \${item.rel}</h3>
      <div class="imgs" id="st-\${i}">解析中…</div>\`;
    list.appendChild(div);
  });
  document.getElementById('deploy').disabled = scanned.length === 0;
}

async function parseAll() {
  window.parsed = [];
  for (let i = 0; i < scanned.length; i++) {
    const p = await parsePost(scanned[i]);
    window.parsed.push(p);
    document.getElementById('st-' + i).innerHTML = p.status.map(s =>
      \`<div class="\${s.ok === true ? 'img-ok' : s.ok === false ? 'img-miss' : ''}">\${s.ok===true?'✓':s.ok===false?'✗':'•'} \${s.ref} → \${s.note}</div>\`
    ).join('') + \`<div>标题：\${p.title} · 日期：\${p.date} · 图片 \${p.images.length} 张</div>\`;
  }
}

document.getElementById('pick').onclick = async () => {
  scanned = []; dirFiles = new Map();
  if (window.showDirectoryPicker) {
    try { dirHandle = await window.showDirectoryPicker(); } catch { return; }
    await iterDir(dirHandle, '', 0);
    document.getElementById('dirname').textContent =
      \`（扫描到 \${scanned.length} 篇 .md、\${dirFiles.size} 个文件）\`;
  } else {
    alert('浏览器不支持文件夹选择 API，请使用 Chrome / Edge 打开本页');
    return;
  }
  renderList();
  await parseAll();
};

document.getElementById('deploy').onclick = async () => {
  const btn = document.getElementById('deploy');
  btn.disabled = true; logEl.textContent = ''; document.getElementById('result').textContent = '';
  const chosen = window.parsed.filter((_, i) =>
    document.querySelector(\`input[data-i="\${i}"]\`)?.checked);
  if (!chosen.length) { log('未选择文章'); btn.disabled = false; return; }
  log(\`准备部署 \${chosen.length} 篇文章…\`);
  const payload = { posts: chosen.map(p => ({
    slug: p.item.rel.split('/').pop().replace(/\\.(md|markdown)$/i, ''),
    md: p.md,
    images: p.images.map(im => ({ target: im.name.split('/').pop(), b64: im.b64 })),
  }))};
  try {
    const r = await fetch('/api/deploy', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (data.error) { log('部署失败：' + data.error); btn.disabled = false; return; }
    if (!data.pushed) { log(data.reason || '无变更'); return; }
    log(\`已提交 \${data.sha.slice(0, 7)} 并推送，等待 Actions 构建部署…\`);
    const r2 = await fetch('/api/wait', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: data.sha }) });
    const w = await r2.json();
    if (w.done && w.ok) {
      document.getElementById('result').innerHTML =
        \`✅ 部署成功！<a href="https://liu-bit264.github.io/" target="_blank">打开博客</a> · <a href="\${w.url}" target="_blank">构建记录</a>\`;
    } else if (w.done) {
      document.getElementById('result').innerHTML =
        \`❌ 构建失败（\${w.conclusion}），<a href="\${w.url}" target="_blank">查看日志</a>\`;
    } else {
      document.getElementById('result').innerHTML =
        \`⏳ 仍在构建，稍后查看：<a href="\${w.url || 'https://github.com/Liu-bit264/Liu-bit264.github.io/actions'}" target="_blank">Actions</a>\`;
    }
  } catch (e) { log('请求失败：' + e); }
  btn.disabled = false;
};
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  // 仅响应 Host 为 localhost/127.0.0.1 的本机请求
  const host = String(req.headers.host || "").split(":")[0];
  if (!["localhost", "127.0.0.1"].includes(host)) {
    return json(res, 403, { error: "forbidden host" });
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(UI_HTML);
  }
  if (req.method === "POST" && req.url === "/api/deploy") {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return json(res, 413, { error: "payload too large" });
      chunks.push(c);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return await handleDeploy(body, res);
    } catch (e) {
      return json(res, 400, { error: "bad json: " + e.message });
    }
  }
  if (req.method === "POST" && req.url === "/api/wait") {
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; chunks.push(c); }
    try {
      const { sha } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const r = await waitForWorkflow(sha);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`文章部署器已启动：http://localhost:${PORT}`);
  console.log(`仓库：${REPO_ROOT}`);
});

/**
 * 部署器核心逻辑：供 Electron 主进程（deployer-app）与本地 Web 版
 * （scripts/deployer.mjs）共用。全部函数以 repoRoot 为参数，不持有全局状态。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------- 文本工具

export function slugify(name) {
  let s = name.replace(/\.(md|markdown|mdx)$/i, "").trim();
  s = s.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-");
  // 与 Astro 内容 slug 一致：ASCII 字母转小写
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return s || `post-${Date.now()}`;
}

function yamlEscape(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function nowIsoShanghai() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace(/\.\d+Z/, "+08:00");
}

export function safeSlug(s) {
  if (!/^[^/\\]+$/.test(s) || s.includes("..")) return null;
  return s;
}

/** 解析现有 frontmatter（够用即可，不做完整 YAML） */
export function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  let curKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s+-\s+/.test(line) && curKey) {
      (fm[curKey] ??= []).push(
        line
          .replace(/^\s+-\s+/, "")
          .replace(/^["']|["']$/g, "")
          .trim(),
      );
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      curKey = kv[1];
      const v = kv[2].trim();
      fm[curKey] = v === "" ? null : v.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: md.slice(m[0].length) };
}

export function buildFrontmatter(fm, body, filename) {
  const title =
    fm.title ||
    (body.match(/^#\s+(.+)$/m) || [])[1]?.trim() ||
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
  const frontmatter = [
    "---",
    `title: ${yamlEscape(title)}`,
    `pubDatetime: ${pubDatetime}`,
    `description: ${yamlEscape(description)}`,
    `category: ${yamlEscape(category)}`,
    `tags:`,
    ...tags.map((t) => `  - ${t}`),
    "---",
    "",
  ].join("\n");
  return { frontmatter, title, description, tags, category };
}

// ---------------------------------------------------------------- 图片引用

export function normalizeRef(ref, mdDir) {
  try {
    ref = decodeURIComponent(ref);
  } catch {
    /* 保留原样 */
  }
  ref = ref.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = (mdDir ? mdDir.split("/") : []).concat(ref.split("/"));
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

export function findImageRefs(md) {
  const refs = new Set();
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) refs.add(m[1]);
  for (const m of md.matchAll(/<img[^>]+src=["']([^"']+)["']/g)) refs.add(m[1]);
  return [...refs].filter((ref) => {
    if (/^(https?:|data:|mailto:)/i.test(ref)) return false;
    if (ref.startsWith("/")) return false; // 站点根路径，假定已在 public/
    return true;
  });
}

/**
 * 在已扫描的文件清单中解析图片引用：
 * 先按相对路径精确匹配，再按文件名在整个文件夹中搜索。
 */
export function resolveImageRef(ref, mdDir, allFiles) {
  const rel = normalizeRef(ref, mdDir);
  if (allFiles.includes(rel)) return rel;
  // 按文件名在整个文件夹中搜索
  const base = rel.split("/").pop().toLowerCase();
  const byName = allFiles.find(
    (f) => f.toLowerCase() === base || f.toLowerCase().endsWith("/" + base),
  );
  return byName || null;
}

// ---------------------------------------------------------------- 目录扫描

export async function scanDirectory(dir, maxDepth = 4) {
  const mdFiles = [];
  const files = [];
  async function walk(rel, depth) {
    if (depth > maxDepth) return;
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child, depth + 1);
      else if (/\.(md|markdown)$/i.test(e.name)) mdFiles.push(child);
      else files.push(child);
    }
  }
  await walk("", 0);
  return { mdFiles, files };
}

// ---------------------------------------------------------------- 部署

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, {
    timeout: opts.timeout ?? 120000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...opts.execOpts,
  });
  return { stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
}

/**
 * 发布一批文章：
 * 读取 md → 补全 frontmatter → 拷贝引用图片到 public/images/<slug>/ 并改写
 * 正文引用 → 写入 src/content/posts/<slug>.md → git 提交推送。
 */
export async function deployPosts(repoRoot, selected, io) {
  const { dir, rels } = selected;
  const { files } = await scanDirectory(dir);
  const POSTS_DIR = join(repoRoot, "src", "content", "posts");
  const IMAGES_DIR = join(repoRoot, "public", "images");
  const titles = [];
  const slugs = [];

  for (const rel of rels) {
    const slug = slugify(rel.split("/").pop());
    const md = await readFile(join(dir, rel), "utf8");
    const { fm, body } = parseFrontmatter(md);
    const { frontmatter, title } = buildFrontmatter(
      fm,
      body,
      rel.split("/").pop(),
    );
    let out = body;
    const mdDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    let copied = 0;
    let missing = 0;

    for (const ref of findImageRefs(md)) {
      const resolved = resolveImageRef(ref, mdDir, files);
      if (!resolved) {
        missing++;
        io?.log?.(`  ✗ 未找到图片：${ref}`);
        continue;
      }
      const target = safeSlug(resolved.split("/").pop());
      if (!target) throw new Error(`非法图片名：${resolved}`);
      const buf = await readFile(join(dir, resolved));
      const dest = join(IMAGES_DIR, slug, target);
      if (!dest.startsWith(IMAGES_DIR)) throw new Error("图片路径越界");
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      const sitePath = `/images/${slug}/${target}`;
      const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // (?=\)) 只吞左括号内的内容，保留原有的右括号，避免出现双括号
      out = out
        .replace(
          new RegExp(`\\]\\(\\s*${esc}\\s*(?=\\))`, "g"),
          `](${sitePath}`,
        )
        .replace(new RegExp(`src=["']${esc}["']`, "g"), `src="${sitePath}"`);
      copied++;
      io?.log?.(`  ✓ ${ref} → ${sitePath}`);
    }

    const file = join(POSTS_DIR, `${slug}.md`);
    await mkdir(POSTS_DIR, { recursive: true });
    await writeFile(file, frontmatter + "\n" + out.replace(/^\s+/, ""), "utf8");
    titles.push(title);
    slugs.push(slug);
    io?.log?.(
      `✓ ${title}（图片 ${copied} 张${missing ? `，缺失 ${missing} 张` : ""}）`,
    );
  }

  await run("git", ["add", "-A"], { execOpts: { cwd: repoRoot } });
  const { stdout: status } = await run("git", ["status", "--porcelain"], {
    execOpts: { cwd: repoRoot },
  });
  if (!status) return { pushed: false, reason: "没有需要提交的变更", slugs };
  const msg = `Publish: ${titles.join("、")} (via BlogDeployer)`;
  await run("git", ["commit", "-m", msg], { execOpts: { cwd: repoRoot } });
  await run("git", ["push", "origin", "main"], {
    timeout: 180000,
    execOpts: { cwd: repoRoot },
  });
  const { stdout: sha } = await run("git", ["rev-parse", "HEAD"], {
    execOpts: { cwd: repoRoot },
  });
  return { pushed: true, sha: sha.trim(), titles, slugs, message: msg };
}

// ---------------------------------------------------------------- 构建状态

export async function waitForWorkflow(sha, repo, maxMs = 8 * 60 * 1000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const { stdout } = await run(
        "gh",
        [
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          "deploy-pages.yml",
          "--limit",
          "5",
          "--json",
          "headSha,status,conclusion,url",
        ],
        { timeout: 30000 },
      );
      const mine = (JSON.parse(stdout || "[]") || []).find(
        (r) => r.headSha === sha,
      );
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

export { pathExists };

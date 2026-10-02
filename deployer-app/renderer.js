/* 渲染进程：通过 preload 暴露的 window.deployer 与主进程通信 */
const $ = (id) => document.getElementById(id);
const logEl = $("log");
const log = (s) => {
  logEl.textContent += s + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};
window.deployer.onLog(log);

let state = null;
let dir = null;
let mdFiles = [];
let parsed = [];

async function refreshState() {
  state = await window.deployer.getState();
  $("repo").innerHTML = state.repoRoot
    ? `仓库：${state.repoRoot} · <a id="chg">更换</a>`
    : `⚠ 尚未指定博客仓库，<a id="chg">立即选择</a>`;
  $("chg").onclick = async () => {
    const p = await window.deployer.setRepo();
    if (p) await refreshState();
  };
}

$("pick").onclick = async () => {
  if (!state?.repoRoot) {
    alert("请先指定博客仓库位置");
    return;
  }
  const r = await window.deployer.pickDir();
  if (!r) return;
  dir = r.dir;
  mdFiles = r.mdFiles;
  $("dirname").textContent =
    `（${dir}，扫描到 ${mdFiles.length} 篇 .md、${r.fileCount} 个文件）`;
  renderList();
  parsed = await window.deployer.parsePosts({ dir, rels: mdFiles });
  renderInfo();
};

function renderList() {
  $("list").innerHTML = mdFiles
    .map(
      (rel, i) =>
        `<div class="post" id="p-${i}"><h3><input type="checkbox" data-i="${i}" checked> ${rel}</h3><div class="imgs">解析中…</div></div>`,
    )
    .join("");
  $("deploy").disabled = mdFiles.length === 0;
}

function renderInfo() {
  parsed.forEach((p, i) => {
    const imgs = p.images
      .map((im) =>
        im.resolved
          ? `<div class="img-ok">✓ ${im.ref} → /images/${p.slug}/${im.resolved.split("/").pop()}</div>`
          : `<div class="img-miss">✗ ${im.ref}（未在所选文件夹中找到）</div>`,
      )
      .join("");
    $("p-" + i).querySelector(".imgs").innerHTML =
      imgs +
      `<div class="meta">标题：${p.title} · 日期：${p.date} · 分类：${p.category || "（自动）"} · slug：${p.slug}</div>`;
  });
}

$("deploy").onclick = async () => {
  const btn = $("deploy");
  btn.disabled = true;
  logEl.textContent = "";
  $("result").textContent = "";
  const rels = mdFiles.filter(
    (_, i) => document.querySelector(`input[data-i="${i}"]`)?.checked,
  );
  if (!rels.length) {
    log("未选择文章");
    btn.disabled = false;
    return;
  }
  log(`准备部署 ${rels.length} 篇文章…`);
  try {
    const d = await window.deployer.deploy({ dir, rels });
    if (!d.pushed) {
      log(d.reason || "无变更");
      btn.disabled = false;
      return;
    }
    log(
      `已提交 ${d.sha.slice(0, 7)} 并推送，等待 Actions 构建部署…（最长约 8 分钟）`,
    );
    const w = await window.deployer.waitDeploy({ sha: d.sha });
    if (w.done && w.ok) {
      $("result").innerHTML =
        `✅ 部署成功！<a href="${state.liveUrl}">打开博客</a> · <a href="${w.url}">构建记录</a>`;
    } else if (w.done) {
      $("result").innerHTML =
        `❌ 构建失败（${w.conclusion}），<a href="${w.url}">查看日志</a>`;
    } else {
      $("result").innerHTML =
        `⏳ 仍在构建，稍后查看：<a href="${state.repoUrl}/actions">Actions</a>`;
    }
  } catch (e) {
    log("部署失败：" + (e?.message || e));
  }
  btn.disabled = false;
};

refreshState();

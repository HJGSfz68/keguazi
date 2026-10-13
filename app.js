/* 嗑瓜子 SPA — hash 路由 */
/* BUILD: gz-20261014-b2 */
window.APP_BUILD = window.APP_BUILD || "gz-20261014-b2";
const $app = document.getElementById("app");
const $input = document.getElementById("searchInput");
const $form = document.getElementById("searchForm");

/* ---------- API 封装（自动重试一次） ---------- */
async function apiOnce(path, payload) {
  let r;
  try {
    r = await fetch("api/video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, payload }),
    });
  } catch (e) {
    throw new Error("网络请求失败：" + e.message);
  }
  let j;
  try {
    j = await r.json();
  } catch (e) {
    if (r.status === 404 || r.status === 405) {
      throw new Error("Functions 未生效(HTTP " + r.status + ")：Dashboard 拖拽上传不包含 Functions，请用 wrangler pages deploy . 或 Git 连接重新部署");
    }
    throw new Error("接口返回异常(HTTP " + r.status + ")，响应不是有效JSON");
  }
  if (j && j.code === 200) return j.data;
  throw new Error(j.msg || j.error || "接口错误 " + (j.code || ""));
}

async function api(path, payload) {
  try {
    return await apiOnce(path, payload);
  } catch (e) {
    // 网络级失败自动重试一次
    await new Promise((r) => setTimeout(r, 800));
    return apiOnce(path, payload);
  }
}

const searchVideos = (kw, page) =>
  api("/Pc/Search/GetConditionList", { tid: 0, area: 0, year: 0, sort: "d_id", keywords: kw, page, pageSize: 24 });
const showHots = () => api("/Pc/Search/ShowHots", {});
const getVodInfo = (vodId) => api("/Pc/Resource/GetVodInfo", { vod_id: String(vodId) });
const getPlayList = (vurlId, vodId) => api("/Pc/Resource/GetOnePlayList", { vurl_id: String(vurlId), vod_id: String(vodId), pageSize: 999 });

const imgProxy = (u) => u ? "api/img?u=" + encodeURIComponent(u) : "";
const proxy = (u) => "api/proxy?url=" + encodeURIComponent(u);

/* ---------- 工具 ---------- */
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function loading(text) {
  return `<div class="center"><div class="spinner"></div>${text || "加载中…"}</div>`;
}

function errorBox(msg, backHash) {
  return `<div class="center"><div class="empty-art">😵</div><p>${msg}</p>
    ${backHash ? `<p style="margin-top:14px"><a class="hot-tag" href="${backHash}">返回</a></p>` : ""}</div>`;
}

function vodCard(v) {
  const score = v.vod_scroe && v.vod_scroe !== "0" ? v.vod_scroe : "";
  const tag = (v.tags && v.tags[0]) || v.vod_area || "";
  return `<a class="vcard" href="#/p/${v.vod_id}">
    <div class="poster">
      <img loading="lazy" src="${imgProxy(v.vod_pic)}" onerror="this.style.opacity=0">
      ${score ? `<span class="badge">${score}</span>` : ""}
      ${v.new_continue ? `<span class="cnt">${v.new_continue}</span>` : ""}
    </div>
    <div class="info">
      <div class="name">${(v.vod_name || "").trim()}</div>
      <div class="meta">${tag ? `<span class="tag">${tag}</span>` : ""}${v.vod_year ? `<span>${v.vod_year}</span>` : ""}</div>
    </div>
  </a>`;
}

/* ---------- 路由 ---------- */
function parseHash() {
  const h = location.hash.slice(1) || "/";
  const [path, qs] = h.split("?");
  const q = Object.fromEntries(new URLSearchParams(qs || ""));
  return { path, q };
}

window.addEventListener("hashchange", render);
$form.addEventListener("submit", (e) => {
  e.preventDefault();
  const kw = $input.value.trim();
  if (!kw) return toast("请输入搜索内容");
  location.hash = "#/s/" + encodeURIComponent(kw);
});

let hls = null;
function destroyPlayer() {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
}

let pageState = { destroy: null };

async function render() {
  destroyPlayer();
  if (pageState.destroy) { try { pageState.destroy(); } catch {} pageState.destroy = null; }
  const { path, q } = parseHash();
  window.scrollTo(0, 0);

  if (path === "/" || path === "") return viewHome();
  if (path.startsWith("/s/")) return viewSearch(decodeURIComponent(path.slice(3)), Number(q.p || 1));
  if (path.startsWith("/p/")) {
    const parts = path.slice(3).split("/");
    return viewPlay(parts[0], parts[1] || "", q.ep);
  }
  $app.innerHTML = errorBox("页面不存在", "#/");
}

/* ---------- 首页 ---------- */
async function viewHome() {
  $app.innerHTML = `<div class="center"><div class="empty-art">🎬</div>
    <h2 style="color:var(--text);margin-bottom:8px">搜你想看的</h2>
    <p>电影 · 电视剧 · 动漫 · 综艺 · 短剧</p></div><div id="hotArea"></div>`;
  try {
    const hots = await showHots();
    const tags = (Array.isArray(hots) ? hots : [])
      .map((h) => `<span class="hot-tag" data-kw="${h.vod_keyword || h.vod_show}">${h.vod_keyword || h.vod_show}</span>`)
      .join("");
    document.getElementById("hotArea").innerHTML =
      `<div class="hot-wrap" style="justify-content:center"><span class="hot-label">🔥 热搜</span>${tags}</div>`;
    document.querySelectorAll(".hot-tag[data-kw]").forEach((el) =>
      el.addEventListener("click", () => (location.hash = "#/s/" + encodeURIComponent(el.dataset.kw))));
  } catch {}
}

/* ---------- 搜索结果 ---------- */
async function viewSearch(kw, page) {
  $input.value = kw;
  document.title = kw + " - 搜索结果";
  $app.innerHTML = loading("正在搜索「" + kw + "」…");
  let data;
  try {
    data = await searchVideos(kw, page);
  } catch (e) {
    return ($app.innerHTML = errorBox("搜索失败：" + e.message, "#/"));
  }
  const list = data.list || [];
  const total = Number(data.total || 0);
  if (!list.length) {
    return ($app.innerHTML = `<div class="center"><div class="empty-art">🔍</div><p>没有找到与「${kw}」相关的内容</p></div>`);
  }
  const totalPages = Math.min(Math.ceil(total / 24), 200);
  $app.innerHTML = `
    <div class="hot-wrap"><span class="hot-label">「${kw}」</span><span style="color:var(--muted);font-size:13px">共 ${total} 条结果</span></div>
    <div class="grid">${list.map(vodCard).join("")}</div>
    <div class="pager">
      <button id="pgPrev" ${page <= 1 ? "disabled" : ""}>上一页</button>
      <span class="cur">${page} / ${totalPages}</span>
      <button id="pgNext" ${page >= totalPages ? "disabled" : ""}>下一页</button>
    </div>`;
  document.getElementById("pgPrev").onclick = () => (location.hash = `#/s/${encodeURIComponent(kw)}?p=${page - 1}`);
  document.getElementById("pgNext").onclick = () => (location.hash = `#/s/${encodeURIComponent(kw)}?p=${page + 1}`);

  // 预热: 静默拉前 8 个结果的详情缓存, 点击进播放页秒开
  list.slice(0, 8).forEach((v) => {
    getVodInfo(v.vod_id).catch(() => {});
  });
}

/* ---------- 播放页 ---------- */
async function viewPlay(vodId, vurlId, epQ) {
  document.title = "播放中…";
  $app.innerHTML = loading("正在加载影片…");
  let info;
  try {
    info = await getVodInfo(vodId);
  } catch (e) {
    return ($app.innerHTML = errorBox("加载失败：" + e.message, "#/"));
  }
  const v = info.vodInfo || {};
  const defaultVurl = v.vurl_id || (v.vurlList && v.vurlList[0] && v.vurlList[0].vurl_id) || "";

  let eps = [];
  try {
    let pl = await getPlayList(defaultVurl, vodId);
    // 兼容两种上游结构: data.urls 或 data.vod_play_vurl
    const rawList = pl.urls || pl.vod_play_vurl || [];
    let urls = rawList.map((u) => ({ name: u.name || u.vod_name, vurl_id: u.vurl_id, url: u.url || u.vod_play_url }));
    // 防御: 接口若忽略 pageSize 仍分页, 按 page 逐页补拉
    const total = Number(pl.total_vod_vurl || 0);
    const pgSize = Number(pl.page_size || 24) || 24;
    if (total > urls.length && urls.length >= pgSize) {
      const pages = Math.min(Math.ceil(total / pgSize), 40);
      for (let p = 2; p <= pages; p++) {
        try {
          const np = await api("/Pc/Resource/GetOnePlayList", { vurl_id: String(defaultVurl), vod_id: String(vodId), page: p });
          const more = (np.urls || np.vod_play_vurl || []).map((u) => ({ name: u.name || u.vod_name, vurl_id: u.vurl_id, url: u.url || u.vod_play_url }));
          if (!more.length) break;
          urls = urls.concat(more);
          if (urls.length >= total) break;
        } catch { break; }
      }
    }
    // 去重 + 按集数排序
    const seen = new Set();
    urls = urls.filter((u) => (seen.has(u.vurl_id) ? false : (seen.add(u.vurl_id), true)));
    const num = (n) => (String(n).match(/\d+/) ? parseInt(String(n).match(/\d+/)[0]) : 0);
    urls.sort((a, b) => num(a.name) - num(b.name));
    eps = urls;
  } catch (e) {
    if (v.play_url) eps = [{ name: "正片", vurl_id: defaultVurl, url: v.play_url }];
  }

  // 确定当前集：优先 ep 序号，其次 vurlId
  let curIdx = 0;
  if (epQ) curIdx = Math.max(0, Math.min(eps.length - 1, Number(epQ) - 1));
  else if (vurlId) {
    const i = eps.findIndex((e) => String(e.vurl_id) === String(vurlId));
    if (i >= 0) curIdx = i;
  }
  const cur = eps[curIdx] || {};

  document.title = (v.vod_name || "播放") + (cur.name ? ` 第${cur.name}集` : "");
  const actors = v.vod_actor ? v.vod_actor.split(",").slice(0, 6).join(" / ") : "";
  $app.innerHTML = `
    <div class="play-layout">
      <div>
        <div class="player-box">
          <video id="player" controls autoplay playsinline></video>
          <div class="player-tip" id="playerTip">视频加载中…</div>
        </div>
        <div class="detail">
          <h1>${(v.vod_name || "").trim()} ${cur.name ? `<span style="color:var(--accent);font-size:15px">第 ${cur.name} 集</span>` : ""}</h1>
          <div class="sub">
            ${v.vod_scroe ? `<b>评分</b> ${v.vod_scroe}　` : ""}${v.vod_year ? `<b>年份</b> ${v.vod_year}　` : ""}${v.vod_area ? `<b>地区</b> ${v.vod_area}　` : ""}
            ${v.new_continue ? `<b>进度</b> ${v.new_continue}` : ""}
            ${actors ? `<br><b>主演</b> ${actors}` : ""}
            ${v.vod_director ? `<br><b>导演</b> ${v.vod_director}` : ""}
          </div>
        </div>
        ${eps.length > 1 ? `<div class="section-title">选集（共 ${eps.length} 集）</div>
        <div class="ep-list">${eps.map((e, i) =>
          `<span class="ep ${i === curIdx ? "active" : ""}" data-i="${i}">${e.name}</span>`).join("")}</div>` : ""}
      </div>
      <div>
        <div class="section-title" style="margin-top:0">猜你喜欢</div>
        <div class="reco-grid">${(info.recommendVod || []).slice(0, 12).map(vodCard).join("")}</div>
      </div>
    </div>`;

  // 换集
  document.querySelectorAll(".ep").forEach((el) =>
    el.addEventListener("click", () => {
      const i = Number(el.dataset.i);
      location.hash = `#/p/${vodId}/${eps[i].vurl_id}`;
    }));

  // 播放
  if (!cur.url) return;
  const video = document.getElementById("player");
  const tip = document.getElementById("playerTip");
  const src = proxy(cur.url);
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30 });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { tip.style.display = "none"; video.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        tip.textContent = "视频加载失败，请稍后重试或换一集";
        tip.style.display = "flex";
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = src;
    video.addEventListener("loadedmetadata", () => { tip.style.display = "none"; });
  } else {
    tip.textContent = "当前浏览器不支持 HLS 播放";
  }
}

render();

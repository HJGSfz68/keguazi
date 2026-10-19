/* 嗑瓜子 SPA — hash 路由 */
/* BUILD: gz-20261019-b7 */
window.APP_BUILD = window.APP_BUILD || "gz-20261019-b7";
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

/* ---------- 观看记录（浏览器本地 localStorage） ---------- */
const HISTORY_KEY = "gz_watch_history";
const HISTORY_MAX = 50;

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function saveHistory(vodId, name, pic, ep) {
  let list = getHistory().filter((h) => String(h.vod_id) !== String(vodId));
  list.unshift({ vod_id: String(vodId), name: name || "", pic: pic || "", ep: ep || null, ts: Date.now() });
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch {}
}

function removeHistory(vodId) {
  const target = getHistory().find((h) => String(h.vod_id) === String(vodId));
  if (target && target.pic) picDelete(target.pic); // 同步清封面缓存
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(getHistory().filter((h) => String(h.vod_id) !== String(vodId)))); } catch {}
}

function clearHistory() {
  getHistory().forEach((h) => { if (h.pic) picDelete(h.pic); }); // 同步清封面缓存
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + "分钟前";
  if (s < 86400) return Math.floor(s / 3600) + "小时前";
  if (s < 86400 * 7) return Math.floor(s / 86400) + "天前";
  const d = new Date(ts);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

/* ---------- 封面缓存（IndexedDB 存 Blob，本地离线可读） ---------- */
const PIC_DB = "gz_cache";
const PIC_STORE = "posters";
const PIC_TTL = 30 * 24 * 3600 * 1000; // 30 天
const PIC_MAX_SIZE = 2 * 1024 * 1024;  // 超过 2MB 的异常图不入缓存

function picDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(PIC_DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(PIC_STORE)) r.result.createObjectStore(PIC_STORE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function picGet(url) {
  try {
    const db = await picDB();
    return await new Promise((res) => {
      const rq = db.transaction(PIC_STORE).objectStore(PIC_STORE).get(url);
      rq.onsuccess = () => res(rq.result && Date.now() - rq.result.t < PIC_TTL ? rq.result.v : null);
      rq.onerror = () => res(null);
    });
  } catch { return null; }
}

async function picSet(url, blob) {
  try {
    const db = await picDB();
    db.transaction(PIC_STORE, "readwrite").objectStore(PIC_STORE).put({ v: blob, t: Date.now() }, url);
  } catch {}
}

async function picDelete(url) {
  try {
    const db = await picDB();
    db.transaction(PIC_STORE, "readwrite").objectStore(PIC_STORE).delete(url);
  } catch {}
}

/* 拿封面 Blob：命中缓存直接回；未命中走图片代理拉取并补存。失败返回 null（调用方兜底走代理地址） */
async function picBlob(url) {
  if (!url) return null;
  const hit = await picGet(url);
  if (hit) return hit;
  try {
    const r = await fetch(imgProxy(url));
    if (r.ok) {
      const b = await r.blob();
      if (b.size && b.size < PIC_MAX_SIZE) { picSet(url, b); return b; }
    }
  } catch {}
  return null;
}

/* 清理过期封面（数量级 ≤50，首页渲染时顺带跑一次） */
async function picCleanup() {
  try {
    const db = await picDB();
    const rq = db.transaction(PIC_STORE, "readwrite").objectStore(PIC_STORE).openCursor();
    rq.onsuccess = () => {
      const c = rq.result;
      if (!c) return;
      if (!c.value || Date.now() - c.value.t > PIC_TTL) c.delete();
      c.continue();
    };
  } catch {}
}

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
  const cont = v.new_continue || v.vod_continu || ""; // 详情/列表字段名不同，兜底
  const tag = (v.tags && v.tags[0]) || v.vod_area || "";
  return `<a class="vcard" href="#/p/${v.vod_id}">
    <div class="poster">
      <img loading="lazy" src="${imgProxy(v.vod_pic)}" onerror="this.style.opacity=0">
      ${score ? `<span class="badge">${score}</span>` : ""}
      ${cont ? `<span class="cnt">${cont}</span>` : ""}
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
let liveObjectURLs = []; // 本页创建的 blob: URL，切页时统一回收

async function render() {
  liveObjectURLs.forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
  liveObjectURLs = [];
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

/* 封面填充：优先 IndexedDB 缓存直出，未命中走图片代理并补存 */
async function fillPoster(img) {
  const u = img.dataset.pic;
  if (!u) return;
  const b = await picBlob(u);
  if (b) { const o = URL.createObjectURL(b); liveObjectURLs.push(o); img.src = o; }
  else img.src = imgProxy(u);
}

/* ---------- 首页 ---------- */
async function viewHome() {
  // 继续观看（本地观看记录）
  const hist = getHistory();
  let histHtml = "";
  if (hist.length) {
    histHtml = `
      <div class="section-title" style="margin-top:0">继续观看<span class="hist-clear" id="histClear">清空</span></div>
      <div class="hist-grid">${hist.map((h) => `
        <div class="hist-card">
          <a href="#/p/${h.vod_id}${h.ep && h.ep.vurl_id ? "/" + h.ep.vurl_id : ""}">
            <div class="poster"><img loading="lazy" data-pic="${escHtml(h.pic || "")}" data-vid="${h.vod_id}" onerror="this.style.opacity=0"></div>
            <div class="hist-info">
              <div class="hist-name">${escHtml(h.name)}</div>
              <div class="hist-meta">${h.ep ? "看到第 " + escHtml(h.ep.epName) + " 集 · " : ""}${timeAgo(h.ts)}</div>
            </div>
          </a>
          <span class="hist-del" data-vid="${h.vod_id}" title="删除这条记录">✕</span>
        </div>`).join("")}</div>`;
  }
  $app.innerHTML = `<div class="center"><div class="empty-art">🎬</div>
    <h2 style="color:var(--text);margin-bottom:8px">搜你想看的</h2>
    <p>电影 · 电视剧 · 动漫 · 综艺 · 短剧</p></div>${histHtml}<div id="hotArea"></div>`;

  // 历史区交互：单条删除 / 清空
  document.querySelectorAll(".hist-del").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      removeHistory(el.dataset.vid);
      render();
    }));
  const clearBtn = document.getElementById("histClear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    if (confirm("确定清空全部观看记录？")) { clearHistory(); render(); }
  });

  // 封面：优先读 IndexedDB 本地缓存，未命中走图片代理拉取并补存
  document.querySelectorAll("img[data-pic]").forEach(fillPoster);

  // 旧记录自愈：升级前存的记录 pic 为空（旧字段名 bug），后台补拉详情把海报补上
  hist.forEach(async (h) => {
    if (h.pic) return;
    try {
      const info = await getVodInfo(h.vod_id);
      const nv = (info.vodInfo || {}).pic || (info.vodInfo || {}).vod_pic;
      if (!nv) return;
      const list = getHistory();
      const it = list.find((x) => String(x.vod_id) === String(h.vod_id));
      if (it && !it.pic) {
        it.pic = nv;
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch {}
      }
      const img = document.querySelector(`img[data-vid="${h.vod_id}"]`);
      if (img && !img.dataset.pic) { img.dataset.pic = nv; fillPoster(img); }
    } catch {}
  });
  picCleanup();

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

  // 写入观看记录（浏览器本地）：记下最后看到的一集，供首页"继续观看"回跳
  // 注意：详情接口海报字段是 pic（搜索列表才叫 vod_pic），两者兜底
  try {
    saveHistory(vodId, v.vod_name, v.pic || v.vod_pic || "",
      cur.vurl_id ? { vurl_id: String(cur.vurl_id), epName: cur.name || "正片" } : null);
  } catch {}
  // 顺手把封面拉进本地缓存（IndexedDB），下次回首页秒出图
  const histPic = v.pic || v.vod_pic;
  if (histPic) picBlob(histPic).catch(() => {});
  const actors = v.vod_actor ? v.vod_actor.split(",").slice(0, 6).join(" / ") : "";
  $app.innerHTML = `
    <div class="play-layout">
      <div>
        <div class="player-box">
          <video id="player" controls autoplay playsinline></video>
          <div class="player-tip" id="playerTip">视频加载中…</div>
        </div>
        <div class="player-bar">
          <select id="qualitySel" style="display:none" title="清晰度"><option value="-1">自动</option></select>
          <select id="speedSel" title="倍速播放">
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1">1.0x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2.0x</option>
          </select>
        </div>
        <div class="detail">
          <h1>${(v.vod_name || "").trim()} ${cur.name ? `<span style="color:var(--accent);font-size:15px">第 ${cur.name} 集</span>` : ""}</h1>
          <div class="sub">
            ${v.vod_scroe ? `<b>评分</b> ${v.vod_scroe}　` : ""}${v.vod_year ? `<b>年份</b> ${v.vod_year}　` : ""}${v.vod_area ? `<b>地区</b> ${v.vod_area}　` : ""}
            ${(v.new_continue || v.vod_continu) ? `<b>进度</b> ${v.new_continue || v.vod_continu}　` : ""}
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

  // 播放（含清晰度切换 + 倍速记忆）
  if (!cur.url) return;
  const video = document.getElementById("player");
  const tip = document.getElementById("playerTip");
  const qualitySel = document.getElementById("qualitySel");
  const speedSel = document.getElementById("speedSel");
  const src = proxy(cur.url);

  const SPEED_KEY = "gz_playback_rate";
  const levelLabel = (l) => (l.height ? l.height + "p" : Math.round((l.bitrate || 0) / 1000) + "kbps");
  const applyRate = () => { video.playbackRate = Number(localStorage.getItem(SPEED_KEY)) || 1; };

  // 倍速：记住用户选择，换集后依然生效
  speedSel.value = localStorage.getItem(SPEED_KEY) || "1";
  speedSel.addEventListener("change", () => {
    const r = Number(speedSel.value) || 1;
    localStorage.setItem(SPEED_KEY, String(r));
    video.playbackRate = r;
  });
  applyRate();

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30 });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      tip.style.display = "none";
      applyRate();
      video.play().catch(() => {});
      // 多码率源才显示清晰度菜单；单码率源（当前源）保持隐藏
      const lv = hls.levels || [];
      if (lv.length > 1) {
        qualitySel.innerHTML = '<option value="-1">自动</option>' +
          lv.map((l, i) => `<option value="${i}">${levelLabel(l)}</option>`).join("");
        qualitySel.style.display = "";
      }
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
      // 自动档时在"自动"选项里实时显示当前正在播的档位
      const l = hls.levels && hls.levels[d.level];
      if (l && hls.autoLevelEnabled && qualitySel.options[0]) {
        qualitySel.options[0].textContent = "自动(" + levelLabel(l) + ")";
      }
    });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        tip.textContent = "视频加载失败，请稍后重试或换一集";
        tip.style.display = "flex";
      }
    });
    qualitySel.addEventListener("change", () => {
      hls.currentLevel = Number(qualitySel.value); // -1 = 回到自动档
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari 原生 HLS：清晰度由系统接管（菜单保持隐藏），倍速仍可用
    video.src = src;
    video.addEventListener("loadedmetadata", () => { tip.style.display = "none"; applyRate(); });
  } else {
    tip.textContent = "当前浏览器不支持 HLS 播放";
  }
}

render();

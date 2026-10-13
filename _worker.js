// Cloudflare Pages _worker.js（高级模式）— 单文件版 API 代理
// /api/video (POST)   白名单接口: AES加密转发 -> 解密返回
//                     缓存: 新鲜30min直接回 | 陈旧6h内立即回+后台刷新 | 未命中快速重试
// /api/proxy (GET)    m3u8 重写 / ts 透传
// /api/img   (GET)    图片代理
//
// ╔══════════════════════════════════════════════════════════════╗
// ║  换源配置区 —— 上游网站更换时【只改这一块】，其余代码不动      ║
// ║  详细步骤见 README.md「换源指南」                              ║
// ╚══════════════════════════════════════════════════════════════╝
// [1] 上游 API 网关地址（换源时替换为新域名，保留 https:// 前缀，结尾不带 / ）
const UPSTREAM = "https://haiwaiapi.1fc8ab0.com";
// [2] AES-128-CBC 加解密参数（从源头站前端 JS 里扒出来的 hex 字符串）
const AES_KEY = "181cc88340ae5b2b";   // 16 字节 hex
const AES_IV  = "4423d1e2773476ce";   // 16 字节 hex
// [3] 接口白名单：只放行这些上游路径（换源后若路径不同，同步增删）
const ALLOW = new Set([
  "/Pc/Search/GetConditionList",   // 搜索列表
  "/Pc/Search/ShowHots",           // 首页热搜词
  "/Pc/Search/GetCondition",       // 筛选条件（预留）
  "/Pc/Resource/GetVodInfo",       // 详情 + 第1集播放地址
  "/Pc/Resource/GetOnePlayList",   // 全集列表
  "/Pc/Resource/VodComment",       // 评论（预留）
  "/Pc/Index/latestVideo",         // 最新上线（预留）
]);
// ╔══════════════ 换源配置区结束（以下是通用逻辑，无需改动）══════════════╗

const FRESH_TTL = 30 * 60 * 1000;   // 30 分钟内视为新鲜
const STALE_TTL = 6 * 60 * 60 * 1000; // 6 小时内可作为兜底返回
const MAX_CACHE = 300;

const te = new TextEncoder();
const td = new TextDecoder();

// ---------- 内存缓存（isolate 级, 秒级命中） ----------
const memCache = new Map(); // key -> { t: Date.now(), body: string }

function cacheGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  const age = Date.now() - e.t;
  if (age > STALE_TTL) { memCache.delete(key); return null; }
  // LRU 触碰
  memCache.delete(key);
  memCache.set(key, e);
  return { body: e.body, fresh: age <= FRESH_TTL };
}

function cacheSet(key, body) {
  if (memCache.size >= MAX_CACHE) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(key, { t: Date.now(), body });
}

// ---------- AES ----------
function hexToBytes(hex) {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getKey() {
  return crypto.subtle.importKey("raw", te.encode(AES_KEY), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

// WebCrypto AES-CBC 自带 PKCS#7 padding
async function aesEncryptHex(plain) {
  const key = await getKey();
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: te.encode(AES_IV) }, key, te.encode(plain));
  return bytesToHex(ct);
}

async function aesDecryptHex(hex) {
  const key = await getKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: te.encode(AES_IV) }, key, hexToBytes(hex));
  return td.decode(pt);
}

const UP_HEADERS = {
  "Origin": "https://gztv5.com",
  "Referer": "https://gztv5.com/",
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
};

async function callUpstream(path, payload, timeoutMs) {
  const enc = await aesEncryptHex(JSON.stringify(payload || {}));
  const r = await fetch(UPSTREAM + path, {
    method: "POST",
    headers: UP_HEADERS,
    body: JSON.stringify({ params: enc }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (typeof j.data === "string" && j.data.length > 0) {
    try {
      j.data = JSON.parse(await aesDecryptHex(j.data));
    } catch { /* 解密失败原样返回 */ }
  }
  return j;
}

// ---------- /api/video ----------
async function handleVideo(request, waitUntil) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const { path, payload } = body || {};
  if (!path || typeof path !== "string") return json({ error: "missing path" }, 400);
  if (!ALLOW.has(path)) return json({ error: "path not allowed" }, 403);

  const key = path + "?" + JSON.stringify(payload || {});

  // 1) 新鲜缓存直接回
  const hit = cacheGet(key);
  if (hit && hit.fresh) {
    return new Response(hit.body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  // 2) 未命中: 快速两段重试 (8s + 12s), 总耗时受控
  let result = null;
  for (const t of [8000, 12000]) {
    try {
      result = await callUpstream(path, payload, t);
      if (result && (result.code === 200 || result.code === 0)) break;
      result = null;
    } catch {
      result = null;
    }
  }

  // 3) 成功 -> 写缓存返回
  if (result) {
    const bodyStr = JSON.stringify(result);
    cacheSet(key, bodyStr);
    return new Response(bodyStr, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  // 4) 失败但有陈旧缓存 -> 兜底返回 + 后台刷新
  if (hit) {
    if (waitUntil) {
      waitUntil(callUpstream(path, payload, 15000)
        .then((j) => { if (j && (j.code === 200 || j.code === 0)) cacheSet(key, JSON.stringify(j)); })
        .catch(() => {}));
    }
    return new Response(hit.body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Served-From": "stale-cache" },
    });
  }

  // 5) 彻底失败
  return json({ error: "upstream_busy", msg: "上游接口繁忙，请稍后重试" }, 504);
}

// ---------- /api/proxy ----------
const M3U8_RE = /\.(m3u8)(\?|$)/i;

async function handleProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) return json({ error: "missing url" }, 400);

  const r = await fetch(target, {
    headers: {
      "User-Agent": UP_HEADERS["User-Agent"],
      "Referer": "https://gztv5.com/",
      "Origin": "https://gztv5.com",
    },
    signal: AbortSignal.timeout(25000),
  });

  const ct = r.headers.get("content-type") || "";
  const isM3u8 = M3U8_RE.test(target) || ct.includes("mpegurl");

  if (isM3u8) {
    const text = await r.text();
    const base = new URL(target);
    const proxify = (u) => "/api/proxy?url=" + encodeURIComponent(u);
    const lines = text.split("\n").map((line) => {
      let l = line.trim();
      if (!l) return line;
      if (l.startsWith("#")) {
        if (/URI="/i.test(l)) {
          l = l.replace(/URI="([^"]+)"/i, (m, u) => `URI="${proxify(new URL(u, base).href)}"`);
        }
        return l;
      }
      return proxify(new URL(l, base).href);
    });
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const headers = new Headers();
  headers.set("Content-Type", ct || "video/mp2t");
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(r.body, { status: r.status, headers });
}

// ---------- /api/img ----------
async function handleImg(request) {
  const url = new URL(request.url);
  const u = url.searchParams.get("u");
  if (!u || !/^https?:\/\//i.test(u)) return json({ error: "missing u" }, 400);
  const r = await fetch(u, {
    headers: { "User-Agent": UP_HEADERS["User-Agent"], "Referer": "https://gztv5.com/" },
    signal: AbortSignal.timeout(15000),
  });
  const headers = new Headers();
  headers.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(r.body, { status: r.status, headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}


// ---------- 静态资源服务 ----------
async function serveStatic(request, env) {
  const url = new URL(request.url);
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  let r = await env.ASSETS.fetch(new URL(path, url.origin));
  // 无扩展名路径 -> 尝试 .html (pretty url: /debug -> debug.html)
  if (r.status === 404 && !path.includes(".")) {
    r = await env.ASSETS.fetch(new URL(path + ".html", url.origin));
  }
  if (r.status === 404) {
    r = await env.ASSETS.fetch(new URL("/index.html", url.origin));
  }
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (p === "/api/video" && request.method === "POST") return handleVideo(request, ctx.waitUntil.bind(ctx));
    if (p === "/api/video") return json({ error: "method not allowed" }, 405);
    if (p === "/api/proxy" && request.method === "GET") return handleProxy(request);
    if (p === "/api/img" && request.method === "GET") return handleImg(request);
    if (p === "/api/health") return json({ ok: true, ts: Date.now(), mode: "_worker.js", cache: memCache.size });
    if (p.startsWith("/api/")) return json({ error: "not found" }, 404);

    return serveStatic(request, env);
  },
};

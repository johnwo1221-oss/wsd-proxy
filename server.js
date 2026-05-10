const https = require("https");
const http = require("http");

const PORT = process.env.PORT || 3000;

// WSD CSV URL（HTTPS，HTTP 會 302 跳轉）
const WSD_URL = "https://www.esd.wsd.gov.hk/wsms_open_data/WSMS_OPEN_DATA(all).csv";

// 簡單記憶體快取（15分鐘）
let cache = { data: null, ts: 0 };
const CACHE_TTL = 15 * 60 * 1000;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  if (url.pathname !== "/wsd") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "WSD Proxy OK", usage: "/wsd" }));
    return;
  }

  const forceFresh = url.searchParams.get("fresh") === "1";
  const now = Date.now();

  // 有快取且未過期直接返回
  if (!forceFresh && cache.data && (now - cache.ts) < CACHE_TTL) {
    res.writeHead(200);
    res.end(JSON.stringify({ ...cache.data, _fromCache: true }));
    return;
  }

  fetchWSD((err, csvText) => {
    if (err || !csvText) {
      // 抓取失敗但有舊快取，返回舊數據
      if (cache.data) {
        res.writeHead(200);
        res.end(JSON.stringify({ ...cache.data, _fromCache: true, _stale: true }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: err || "抓取失敗" }));
      }
      return;
    }

    const result = parseWSDCsv(csvText);
    if (result.success) {
      cache = { data: result, ts: Date.now() };
    }
    res.writeHead(200);
    res.end(JSON.stringify(result));
  });

}).listen(PORT, () => {
  console.log("WSD Proxy listening on port " + PORT);
});

// ── 抓取 WSD CSV ──────────────────────────────────────────
function fetchWSD(cb) {
  const options = {
    hostname: "www.esd.wsd.gov.hk",
    path: "/wsms_open_data/WSMS_OPEN_DATA(all).csv",
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
      "Accept": "text/plain,*/*",
      "Accept-Language": "zh-HK,en;q=0.8"
    }
  };

  const req = https.request(options, (res) => {
    const chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => {
      if (res.statusCode !== 200) {
        return cb("WSD HTTP " + res.statusCode);
      }
      const buf = Buffer.concat(chunks);
      // Big5 → UTF-8
      try {
        const { TextDecoder } = require("util");
        const text = new TextDecoder("big5").decode(buf);
        cb(null, text);
      } catch(e) {
        cb(null, buf.toString("utf8"));
      }
    });
  });

  req.on("error", e => cb(e.message));
  req.setTimeout(15000, () => { req.destroy(); cb("Timeout"); });
  req.end();
}

// ── CSV 解析 ──────────────────────────────────────────────
function parseWSDCsv(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return { success: false, error: "CSV 為空" };

  const header = lines[0].split("|");
  const idx = {};
  header.forEach((col, i) => { idx[col.trim()] = i; });

  const f = (k) => idx[k];
  const notices = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split("|");

    const district = (cols[f("DISTRICT_ENG")] || "").trim();
    const status   = (cols[f("STATUS")]        || "").trim();
    const address  = (cols[f("LONG_ADDRESS")]  || "").trim();

    if (district !== "Kwun Tong") continue;
    if (status === "Supply resumed") continue;

    const isMontego = address.indexOf("MONTEGO BAY") !== -1 ||
                      address.indexOf("TUNG YUEN STREET") !== -1;
    const isYauTong = isMontego ||
                      address.toUpperCase().indexOf("YAU TONG") !== -1;

    notices.push({
      waterType  : (cols[f("WATER_TYPE_DESCRIPTION")]        || "").trim(),
      nature     : (cols[f("NATURE_DESCRIPTION")]            || "").trim(),
      suspDate   : (cols[f("SUSPENSION_DATE_TIME")]          || "").trim(),
      resumeDate : (cols[f("ACTUAL_RESUMPTION_DATE_TIME")]   || "").trim(),
      address    : address,
      cause      : (cols[f("CAUSE")]                         || "").trim(),
      status     : status,
      isMontego  : isMontego,
      isYauTong  : isYauTong
    });
  }

  notices.sort((a, b) => {
    if (a.isMontego !== b.isMontego) return a.isMontego ? -1 : 1;
    return a.suspDate > b.suspDate ? -1 : 1;
  });

  return {
    success      : true,
    notices      : notices,
    fetchedAt    : hkTime(),
    yauTongCount : notices.filter(n => n.isYauTong).length,
    totalKwunTong: notices.length
  };
}

function hkTime() {
  return new Date().toLocaleString("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

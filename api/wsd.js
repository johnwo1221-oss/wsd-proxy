const https = require("https");

// 記憶體快取（Serverless 環境有限，但同一 instance 有效）
let cache = { data: null, ts: 0 };
const CACHE_TTL = 10 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const forceFresh = req.query.fresh === "1";
  const now = Date.now();

  if (!forceFresh && cache.data && (now - cache.ts) < CACHE_TTL) {
    return res.json({ ...cache.data, _fromCache: true });
  }

  try {
    const csvText = await fetchWSD();
    const result = parseWSDCsv(csvText);
    if (result.success) cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch(e) {
    if (cache.data) {
      res.json({ ...cache.data, _fromCache: true, _stale: true });
    } else {
      res.json({ success: false, error: e.message });
    }
  }
};

function fetchWSD() {
  return new Promise((resolve, reject) => {
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
    const req = https.request(options, (r) => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => {
        if (r.statusCode !== 200) return reject(new Error("WSD HTTP " + r.statusCode));
        const buf = Buffer.concat(chunks);
        try {
          const text = new TextDecoder("big5").decode(buf);
          resolve(text);
        } catch(e) {
          resolve(buf.toString("utf8"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function parseWSDCsv(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return { success: false, error: "CSV empty" };
  const header = lines[0].split("|");
  const idx = {};
  header.forEach((col, i) => { idx[col.trim()] = i; });
  const f = k => idx[k];
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
    const isMontego = address.indexOf("MONTEGO BAY") !== -1 || address.indexOf("TUNG YUEN STREET") !== -1;
    const isYauTong = isMontego || address.toUpperCase().indexOf("YAU TONG") !== -1;
    notices.push({
      waterType  : (cols[f("WATER_TYPE_DESCRIPTION")]      || "").trim(),
      nature     : (cols[f("NATURE_DESCRIPTION")]          || "").trim(),
      suspDate   : (cols[f("SUSPENSION_DATE_TIME")]        || "").trim(),
      resumeDate : (cols[f("ACTUAL_RESUMPTION_DATE_TIME")] || "").trim(),
      address, cause: (cols[f("CAUSE")] || "").trim(), status, isMontego, isYauTong
    });
  }
  notices.sort((a, b) => a.isMontego !== b.isMontego ? (a.isMontego ? -1 : 1) : (a.suspDate > b.suspDate ? -1 : 1));
  return {
    success: true, notices,
    fetchedAt: new Date().toLocaleString("zh-HK", { timeZone: "Asia/Hong_Kong", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }),
    yauTongCount: notices.filter(n => n.isYauTong).length,
    totalKwunTong: notices.length
  };
}

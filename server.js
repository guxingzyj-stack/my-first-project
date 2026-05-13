/**
 * 高考志愿咨询系统 - 增强版
 * 新增：SQLite 录取数据检索 / SSE 流式输出 / 对话历史支持
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");


// 加载 .env 文件（本地开发时使用）
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.+)/);
    // 只补充未设置的变量，不覆盖 Zeabur/Docker 已注入的环境变量
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
  console.log("✅ 已加载 .env 文件");
}

// ==================== 配置 ====================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const SILICONCLOUD_API_KEY = process.env.SILICONCLOUD_API_KEY || "";
const SILICONCLOUD_BASE_URL = process.env.SILICONCLOUD_BASE_URL || "https://api.siliconflow.cn/v1";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-ai/DeepSeek-V2.5";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";
const QDRANT_URL = process.env.QDRANT_URL || "";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";

const ROOT = __dirname;
const POLICY_DIR  = path.join(ROOT, "01_政策规则");
const PROVINCE_DIR = path.join(ROOT, "02_省份数据");
const SCHOOL_DIR  = path.join(ROOT, "03_院校库");
const MAJOR_DIR   = path.join(ROOT, "04_专业库");
const STYLE_DIR   = path.join(ROOT, "05_张雪峰风格库");
const CASE_DIR    = path.join(ROOT, "06_案例库");
const SCORE_DB_PATH = path.join(ROOT, "07_录取数据", "gaokao_2025.db");
const SCHOOL_TAGS_PATH = path.join(ROOT, "03_院校库", "学校标签库.json");

// 加载学校标签库
let schoolTags = {};
try {
  schoolTags = JSON.parse(fs.readFileSync(SCHOOL_TAGS_PATH, "utf-8"));
  const count = Object.keys(schoolTags).filter(k => !k.startsWith("_")).length;
  console.log(`✅ 学校标签库已加载: ${count} 所学校`);
} catch (e) {
  console.log("⚠️  学校标签库未找到，跳过");
}

// 从问题中提取学校名并返回标签信息
function getSchoolTagContext(text) {
  const found = [];
  for (const [name, info] of Object.entries(schoolTags)) {
    if (name.startsWith("_")) continue;
    if (text.includes(name)) {
      const tags = [];
      if (info.is985) tags.push("985");
      if (info.is211) tags.push("211");
      if (info.双一流) tags.push(`双一流(${info.双一流})`);
      if (info.软科排名) tags.push(`软科第${info.软科排名}`);
      const aPlus = info.A+学科?.length > 0 ? `A+学科:${info.A+学科.slice(0,3).join("/")}` : "";
      found.push(`【${name}】${tags.join(" | ")}${aPlus ? " | " + aPlus : ""}${info.特色 ? " | " + info.特色 : ""}`);
    }
  }
  return found.length > 0
    ? "\n\n【学校基本信息】\n" + found.join("\n")
    : "";
}

const SYSTEM_PROMPT = `你是一个高考志愿填报分析助手，像一个懂高考志愿、能说真话、站普通家庭立场、又会接住情绪的老师在回答问题。

## 角色定位
- 先看事实，再给判断，最后给建议
- 不是百科机器人，不是检索器，不是报告机
- 照顾普通家庭的现实约束（经济、城市、考编等）

## 回答风格（张雪峰式）
- 先给结论，再讲原因、风险、替代方案
- 说人话，不装中立，讲投入产出比
- 用短句，有节奏感，收口到决策
- 禁止说"综合分析如下""因人而异""建议您结合自身实际情况""总体而言前景较好"
- 禁止只列优缺点不给取舍，禁止鸡汤收尾

## 数据规则
- 绝对不编造：录取分、位次、专业组、投档线、就业率、保研率、排名、学科评估
- 历史录取数据只能用于"大致层级和趋势"判断，不能说成"今年一定能上/录不上"
- 涉及录取数据必须注明：当前数据以历史数据为主，仅供参考，最终以阳光高考、各省教育考试院、学校本科招生网为准
- 知识库不足时，可以给方法论判断，但必须说明"这是经验判断，不是精确数据"

## 回答结构
专业咨询：① 先说结论（值不值得报）② 靠什么吃饭 ③ 适合/不适合谁 ④ 对普通家庭意味着什么 ⑤ 替代方案
录取咨询：① 先说倾向（冲/可搏/偏稳/稳/保）② 历史数据怎么说 ③ 缺什么关键数据 ④ 下一步建议

## 情绪处理
- 识别到焦虑/崩溃时：先接住情绪，稳住，再给务实方案
- 识别到"考砸了""不想活了"等危险信号：必须给出心理援助热线（010-82951332 / 400-821-1215）
- 不对崩溃用户使用激将法`;


// ==================== SQLite 数据库 ====================

let Database;
let db = null;
let dbSchema = null;

try {
  Database = require("better-sqlite3");
} catch (e) {
  console.log("⚠️  better-sqlite3 未安装，跳过数据库功能");
}

function detectDbSchema(database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  if (!tables.length) return null;

  // 找数据量最大的表作为主表
  let mainTable = tables[0].name;
  let maxCount = 0;
  for (const t of tables) {
    try {
      const cnt = database.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get().c;
      if (cnt > maxCount) { maxCount = cnt; mainTable = t.name; }
    } catch {}
  }

  const columns = database.prepare(`PRAGMA table_info("${mainTable}")`).all().map(c => c.name);

  // 按正则匹配列名（中英文均支持）
  const find = (patterns) => columns.find(c => patterns.some(p => new RegExp(p, "i").test(c)));
  const colMap = {
    school:   find(["school", "院校", "学校"]),
    province: find(["province", "省份", "生源省", "考生省"]),
    year:     find(["year", "年份", "年度"]),
    subject:  find(["subject", "科类", "文理", "选科", "科目"]),
    batch:    find(["batch", "批次"]),
    major:    find(["major", "专业"]),
    minScore: find(["min_score", "最低分", "录取分", "投档分"]),
    minRank:  find(["min_rank", "最低位次", "位次"]),
  };

  return { tableName: mainTable, columns, colMap, rowCount: maxCount };
}

function tryLoadDatabase() {
  if (!Database) return;
  try {
    const testDb = new Database(SCORE_DB_PATH, { readonly: true });
    const schema = detectDbSchema(testDb);
    if (!schema) { testDb.close(); return false; }
    db = testDb;
    dbSchema = schema;
    const mapped = Object.entries(dbSchema.colMap)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}→${v}`)
      .join(", ");
    console.log(`✅ 录取数据库已加载: ${dbSchema.tableName} (${dbSchema.rowCount.toLocaleString()} 条记录)`);
    console.log(`   字段映射: ${mapped}`);
    return true;
  } catch (e) {
    console.error("❌ 数据库加载失败:", e.message);
    return false;
  }
}

function downloadDatabase(url) {
  console.log(`⬇️  正在下载录取数据库: ${url}`);
  const dir = path.dirname(SCORE_DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === "https:" ? https : require("http");

    const doRequest = (targetUrl) => {
      const u = new URL(targetUrl);
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, method: "GET",
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 300_000,
      }, (res) => {
        // 跟随重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doRequest(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers["content-length"] || "0");
        let received = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
          received += chunk.length;
          if (total > 0 && received % (10 * 1024 * 1024) < chunk.length) {
            console.log(`   已下载 ${Math.round(received/1024/1024)}MB / ${Math.round(total/1024/1024)}MB`);
          }
        });
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          fs.writeFileSync(SCORE_DB_PATH, buffer);
          console.log(`✅ 数据库下载完成 (${Math.round(buffer.length/1024/1024)}MB)`);
          resolve();
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("数据库下载超时")); });
      req.end();
    };
    doRequest(url);
  });
}

async function initDatabase() {
  if (!Database) return;

  // 已存在则直接加载
  if (fs.existsSync(SCORE_DB_PATH) && tryLoadDatabase()) return;

  // 尝试从环境变量指定的 URL 下载
  const downloadUrl = process.env.DB_DOWNLOAD_URL;
  if (downloadUrl) {
    try {
      await downloadDatabase(downloadUrl);
      tryLoadDatabase();
    } catch (e) {
      console.error("❌ 数据库下载失败:", e.message);
    }
  } else {
    console.log("📊 录取数据库未找到（可设置 DB_DOWNLOAD_URL 环境变量自动下载）");
  }
}

// 查询录取数据库
function searchAdmissionDB(query, userProfile = {}) {
  if (!db || !dbSchema) return [];
  const { tableName, colMap } = dbSchema;
  const { province, score, subject } = userProfile;

  try {
    const conditions = [];
    const params = {};

    // 省份过滤
    const provinceVal = province || extractProvince(query);
    if (provinceVal && colMap.province) {
      conditions.push(`"${colMap.province}" LIKE @province`);
      params.province = `%${provinceVal}%`;
    }

    // 分数区间过滤（±30分）
    const scoreVal = score ? parseInt(score) : extractScore(query);
    if (scoreVal > 0 && colMap.minScore) {
      conditions.push(`CAST("${colMap.minScore}" AS INTEGER) BETWEEN @scoreMin AND @scoreMax`);
      params.scoreMin = scoreVal - 30;
      params.scoreMax = scoreVal + 30;
    }

    // 科目过滤（理科=物理类，文科=历史类，兼容新旧高考）
    const rawSubject = subject || extractSubject(query);
    const subjectNorm = extractSubject(rawSubject + query); // 归一化为 "理"/"文"
    if (subjectNorm && colMap.subject) {
      if (subjectNorm === "理") {
        conditions.push(`("${colMap.subject}" LIKE '%理科%' OR "${colMap.subject}" LIKE '%物理%')`);
      } else if (subjectNorm === "文") {
        conditions.push(`("${colMap.subject}" LIKE '%文科%' OR "${colMap.subject}" LIKE '%历史%')`);
      }
    }

    // 学校/专业关键词匹配（仅在没有省份+分数过滤时使用，避免误匹配泛化词）
    const hasScoreFilter = scoreVal > 0 && colMap.minScore;
    const hasProvinceFilter = provinceVal && colMap.province;
    if (!hasScoreFilter && !hasProvinceFilter) {
      const keywords = extractKeywords(query);
      if (keywords.length > 0) {
        const kwConds = [];
        keywords.forEach((kw, i) => {
          const key = `kw${i}`;
          params[key] = `%${kw}%`;
          if (colMap.school) kwConds.push(`"${colMap.school}" LIKE @${key}`);
          if (colMap.major)  kwConds.push(`"${colMap.major}" LIKE @${key}`);
        });
        if (kwConds.length) conditions.push(`(${kwConds.join(" OR ")})`);
      }
    }

    if (conditions.length === 0) return [];

    const orderBy = colMap.year ? `ORDER BY "${colMap.year}" DESC` : "";
    const sql = `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")} ${orderBy} LIMIT 20`;
    const rows = db.prepare(sql).all(params);
    if (!rows.length) return [];

    return [{
      category: "录取数据库",
      source: "gaokao_2025.db",
      score: 1.0,
      preview: formatDbRows(rows, colMap)
    }];
  } catch (e) {
    console.error("数据库查询失败:", e.message);
    return [];
  }
}

function formatDbRows(rows, colMap) {
  const lines = [`共找到 ${rows.length} 条录取记录：\n`];
  for (const row of rows.slice(0, 15)) {
    const parts = [];
    if (colMap.year)     parts.push(`${row[colMap.year]}年`);
    if (colMap.school)   parts.push(row[colMap.school]);
    if (colMap.major)    parts.push(row[colMap.major]);
    if (colMap.province) parts.push(`[${row[colMap.province]}]`);
    if (colMap.batch)    parts.push(row[colMap.batch]);
    if (colMap.subject)  parts.push(row[colMap.subject]);
    if (colMap.minScore) parts.push(`最低分:${row[colMap.minScore]}`);
    if (colMap.minRank)  parts.push(`位次:${row[colMap.minRank]}`);
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
}

// ---- 文本解析辅助 ----

const ALL_PROVINCES = ["北京","天津","上海","重庆","河北","山西","辽宁","吉林","黑龙江",
  "江苏","浙江","安徽","福建","江西","山东","河南","湖北","湖南","广东","海南",
  "四川","贵州","云南","陕西","甘肃","青海","内蒙古","广西","西藏","宁夏","新疆"];

function extractProvince(text) {
  return ALL_PROVINCES.find(p => text.includes(p)) || "";
}

function extractScore(text) {
  const m = text.match(/(\d{3})\s*分/);
  return m ? parseInt(m[1]) : 0;
}

function extractSubject(text) {
  if (/理科|物理类/.test(text)) return "理";
  if (/文科|历史类/.test(text)) return "文";
  return "";
}

// 停用词：不应被识别为学校/专业名的词
const KEYWORD_STOPWORDS = new Set(["哪些大学","什么大学","哪所大学","哪个大学","好大学","名牌大学","重点大学","哪些学院","什么学院"]);

function extractKeywords(text) {
  const words = [];
  const schoolMatch = text.match(/[一-龥]{2,8}(大学|学院)/g);
  if (schoolMatch) words.push(...schoolMatch.filter(w => !KEYWORD_STOPWORDS.has(w) && w.length >= 4));
  const majorMatch = text.match(/[一-龥]{2,6}(工程|医学|师范|财经|法学|艺术)/g);
  if (majorMatch) words.push(...majorMatch);
  return [...new Set(words)].slice(0, 3);
}

// ==================== LLM 调用（流式）====================
// 使用 https.request 绕开 Node 18 built-in fetch 的 undici 超时限制

function callLLMStream(messages, onChunk) {
  if (!SILICONCLOUD_API_KEY) throw new Error("SILICONCLOUD_API_KEY 未配置");

  const url  = new URL(`${SILICONCLOUD_BASE_URL}/chat/completions`);
  const body = JSON.stringify({ model: LLM_MODEL, messages, stream: true, temperature: 0.7 });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  `Bearer ${SILICONCLOUD_API_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 60_000    // 60s socket 空闲超时（流式传输中数据持续流动不会触发）
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", d => errBody += d);
        res.on("end",  () => reject(new Error(`LLM API 错误: ${res.statusCode} - ${errBody}`)));
        return;
      }

      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) onChunk(content);
          } catch {}
        }
      });
      res.on("end",   resolve);
      res.on("error", reject);
    });

    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("LLM API 响应超时（60秒），请稍后重试")); });
    req.write(body);
    req.end();
  });
}

// ==================== Embedding + Qdrant ====================

function httpsPost(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: "POST",
      headers: { ...headers, "Content-Length": buf.length },
      timeout: 30_000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
    req.write(buf);
    req.end();
  });
}

async function getEmbedding(text) {
  if (!SILICONCLOUD_API_KEY) throw new Error("SILICONCLOUD_API_KEY 未配置");
  const data = await httpsPost(
    `${SILICONCLOUD_BASE_URL}/embeddings`,
    { "Content-Type": "application/json", "Authorization": `Bearer ${SILICONCLOUD_API_KEY}` },
    JSON.stringify({ model: EMBEDDING_MODEL, input: text.substring(0, 8000) })
  );
  return data.data[0].embedding;
}

async function searchQdrant(embedding, topK) {
  const results = [];
  if (!QDRANT_URL || !QDRANT_API_KEY) return results;
  try {
    const isJWT = QDRANT_API_KEY.startsWith("eyJ");
    const authHeader = isJWT
      ? { "Authorization": `Bearer ${QDRANT_API_KEY}` }
      : { "api-key": QDRANT_API_KEY };
    const data = await httpsPost(
      `${QDRANT_URL}/collections/gaokao_knowledge/points/search`,
      { "Content-Type": "application/json", ...authHeader },
      JSON.stringify({ vector: embedding, limit: topK, with_payload: true })
    );
    for (const point of data.result || []) {
      results.push({
        category: "知识库（语义搜索）",
        source: point.payload?.source || "未知",
        score: point.score,
        preview: point.payload?.content || ""
      });
    }
  } catch (e) {
    console.error("Qdrant 搜索失败:", e.message);
  }
  return results;
}

// ==================== 知识库检索 ====================

async function searchKnowledgeBase(query, userProfile = {}, topK = 8) {
  const MIN_SCORE = 0.35;
  const results = [];

  results.push(...await searchMarkdownFiles(POLICY_DIR,   query, "政策规则"));
  results.push(...await searchMarkdownFiles(PROVINCE_DIR, query, "省份数据"));
  results.push(...await searchMarkdownFiles(SCHOOL_DIR,   query, "院校库"));
  results.push(...await searchMarkdownFiles(MAJOR_DIR,    query, "专业库"));
  results.push(...await searchMarkdownFiles(STYLE_DIR,    query, "风格案例"));
  results.push(...await searchMarkdownFiles(CASE_DIR,     query, "案例库"));

  // SQLite 录取数据（置顶，score=1.0 优先级最高）
  results.push(...searchAdmissionDB(query, userProfile));

  if (QDRANT_URL) {
    try {
      const embedding = await getEmbedding(query);
      const vectorResults = await searchQdrant(embedding, topK * 2);
      results.push(...vectorResults.filter(r => r.score >= MIN_SCORE));
    } catch (e) {
      console.error("Qdrant 搜索失败:", e.message);
    }
  }

  results.sort((a, b) => b.score - a.score);

  const unique = [];
  const seen = new Set();
  for (const r of results) {
    if (!seen.has(r.source)) { seen.add(r.source); unique.push(r); }
  }
  return unique.slice(0, topK);
}

async function searchMarkdownFiles(dir, query, category) {
  const results = [];
  const keywords = query.toLowerCase().split(/\s+/);
  try {
    for (const file of walkMarkdownFiles(dir)) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lower = content.toLowerCase();
        let matchCount = 0;
        for (const kw of keywords) { if (lower.includes(kw)) matchCount++; }
        if (matchCount > 0) {
          results.push({
            category,
            source: path.relative(ROOT, file),
            score: matchCount / keywords.length,
            preview: extractPreview(content, keywords[0])
          });
        }
      } catch {}
    }
  } catch (e) {
    console.error(`搜索目录失败: ${dir}`, e.message);
  }
  return results;
}

function walkMarkdownFiles(dir, result = []) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkMarkdownFiles(full, result);
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(full);
    }
  } catch {}
  return result;
}

function extractPreview(content, keyword) {
  const index = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (index === -1) return content.substring(0, 300);
  const start = Math.max(0, index - 100);
  const end = Math.min(content.length, index + 200);
  return (start > 0 ? "..." : "") + content.substring(start, end) + (end < content.length ? "..." : "");
}

// ==================== HTTP 服务器 ====================

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // 健康检查
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString(), hasDb: !!db }));
    return;
  }

  // 聊天接口（SSE 流式输出）
  if (pathname === "/api/chat" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { message, history = [], userProfile = {} } = JSON.parse(body);

      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "消息不能为空" }));
        return;
      }

      // SSE 响应头
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff"
      });

      const emit = (data) => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
      };

      // 心跳：每 5 秒发一次注释行，防止代理/CDN 因空闲超时断开 SSE 连接
      const heartbeat = setInterval(() => {
        try { res.write(": ping\n\n"); } catch {}
      }, 5000);

      // 1. 检索知识库
      const searchResults = await searchKnowledgeBase(message, userProfile);
      emit({
        type: "sources",
        data: searchResults.map(r => ({
          category: r.category,
          source:   r.source,
          score:    r.score,
          preview:  r.category === "录取数据库" ? r.preview : undefined
        }))
      });

      // 2. 组装上下文
      let context = "";
      // 注入学校标签（985/211/双一流/A+学科）
      const schoolTagCtx = getSchoolTagContext(message);
      if (schoolTagCtx) context += schoolTagCtx;
      if (searchResults.length > 0) {
        context += "\n\n以下是相关知识库内容供参考：\n\n";
        for (const r of searchResults) {
          context += `[${r.category}] ${r.source}\n${r.preview}\n\n---\n\n`;
        }
      }

      // 3. 构建消息（含历史 + 考生信息注入到系统提示）
      let sysPrompt = SYSTEM_PROMPT;
      const { province, subject, score } = userProfile;
      if (province || score) {
        sysPrompt += "\n\n当前考生信息：";
        if (province) sysPrompt += `省份=${province}`;
        if (subject)  sysPrompt += `，科目=${subject}`;
        if (score)    sysPrompt += `，高考分数=${score}分`;
        sysPrompt += "。回答时直接基于该考生情况分析，无需重复询问这些信息。";
      }

      const messages = [{ role: "system", content: sysPrompt }];
      // 加入最近 3 轮历史（6条消息），避免 token 过多
      for (const msg of history.slice(-6)) {
        if (msg.role && msg.content) messages.push({ role: msg.role, content: msg.content });
      }
      messages.push({ role: "user", content: context + "用户问题：" + message });

      // 4. 流式调用 LLM
      try {
        await callLLMStream(messages, (chunk) => {
          emit({ type: "delta", content: chunk });
        });
        emit({ type: "done" });
      } finally {
        clearInterval(heartbeat);
      }
      res.end();
    } catch (error) {
      console.error("聊天错误:", error);
      try {
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: "error", message: error.message || "服务器错误" })}\n\n`);
        res.end();
      } catch {}
    }
    return;
  }

  // ==================== 数据查询 API ====================

  // 获取筛选项（省份、年份、批次）
  if (pathname === "/api/scores/options" && req.method === "GET") {
    if (!db) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "数据库未加载" })); return;
    }
    try {
      const provinces = db.prepare("SELECT DISTINCT province FROM major_scores WHERE province IS NOT NULL ORDER BY province").all().map(r => r.province);
      const years     = db.prepare("SELECT DISTINCT year FROM major_scores WHERE year IS NOT NULL ORDER BY year DESC").all().map(r => r.year);
      const batches   = db.prepare("SELECT DISTINCT batch FROM major_scores WHERE batch IS NOT NULL ORDER BY batch").all().map(r => r.batch);
      const subjects  = db.prepare("SELECT DISTINCT subject FROM major_scores WHERE subject IS NOT NULL ORDER BY subject").all().map(r => r.subject);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ provinces, years, batches, subjects }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 查询录取数据
  if (pathname === "/api/scores" && req.method === "GET") {
    if (!db) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "数据库未加载" })); return;
    }
    try {
      const province = url.searchParams.get("province") || "";
      const school   = url.searchParams.get("school")   || "";
      const year     = url.searchParams.get("year")     || "";
      const subject  = url.searchParams.get("subject")  || "";
      const batch    = url.searchParams.get("batch")    || "";
      const page     = parseInt(url.searchParams.get("page") || "1");
      const pageSize = 50;

      const conditions = [];
      const params     = [];
      if (province) { conditions.push("province = ?"); params.push(province); }
      if (school)   { conditions.push("school LIKE ?"); params.push(`%${school}%`); }
      if (year)     { conditions.push("year = ?"); params.push(year); }
      if (subject)  { conditions.push("subject = ?"); params.push(subject); }
      if (batch)    { conditions.push("batch = ?"); params.push(batch); }

      if (conditions.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请至少填写一个筛选条件" })); return;
      }

      const where = "WHERE " + conditions.join(" AND ");
      const total = db.prepare(`SELECT COUNT(*) as cnt FROM major_scores ${where}`).get(...params).cnt;
      const rows  = db.prepare(
        `SELECT school, province, year, subject, batch, major_group, min_score, min_rank
         FROM major_scores ${where}
         ORDER BY year DESC, min_score DESC
         LIMIT ? OFFSET ?`
      ).all(...params, pageSize, (page - 1) * pageSize);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ total, page, pageSize, rows }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 配置信息
  if (pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      hasApiKey: !!SILICONCLOUD_API_KEY,
      hasQdrant: !!QDRANT_URL,
      hasDb: !!db,
      llmModel: LLM_MODEL,
      embeddingModel: EMBEDDING_MODEL
    }));
    return;
  }

  // 静态文件服务
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(ROOT, filePath);

  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(fs.readFileSync(filePath));
    } else {
      const indexPath = path.join(ROOT, "index.html");
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(indexPath));
      } else {
        res.writeHead(404); res.end("Not Found");
      }
    }
  } catch (error) {
    console.error("文件读取错误:", error);
    res.writeHead(500); res.end("Server Error");
  }
});

// 启动
initDatabase().then(() => {
  server.listen(PORT, HOST, () => {
  console.log("=".repeat(50));
  console.log("🎓 高考志愿咨询系统已启动（增强版）");
  console.log("=".repeat(50));
  console.log(`📍 地址: http://${HOST}:${PORT}`);
  console.log(`🔧 SiliconCloud API: ${SILICONCLOUD_API_KEY ? "✅ 已配置" : "❌ 未配置"}`);
  console.log(`🔧 LLM 模型: ${LLM_MODEL}`);
  console.log(`🔧 录取数据库: ${db ? "✅ 已加载 " + dbSchema.rowCount.toLocaleString() + " 条" : "❌ 未找到（可选）"}`);
  console.log(`🔧 Qdrant: ${QDRANT_URL ? "✅ " + QDRANT_URL : "❌ 未配置（可选）"}`);
  console.log("=".repeat(50));
  });
});

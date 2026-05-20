/**
 * 高考志愿咨询系统 - 增强版
 * 新增：SQLite 录取数据检索 / SSE 流式输出 / 对话历史支持
 */

const fs     = require("fs");
const path   = require("path");
const http   = require("http");
const https  = require("https");
const crypto = require("crypto");
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
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-ai/DeepSeek-V3.2";
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
const SCORE_DB_PATH = (() => {
  const dir = path.join(ROOT, "07_录取数据");
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".db")).sort();
    if (files.length > 0) return path.join(dir, files[files.length - 1]);
  } catch {}
  return path.join(ROOT, "07_录取数据", "gaokao_2025.db");
})();
const SCHOOL_TAGS_PATH = path.join(ROOT, "03_院校库", "学校标签库.json");
const CONV_DB_DIR  = path.join(ROOT, "data");
const CONV_DB_PATH = path.join(CONV_DB_DIR, "conversations.db");
const STATS_KEY    = process.env.STATS_KEY || "";
const rateLimitMap = new Map();

// ==================== 运营看板 HTML ====================
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><title>运营看板</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f5f5f5;color:#333}
h1{margin:0 0 20px;font-size:20px}h2{font-size:14px;margin:20px 0 8px;color:#555}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.card{background:#fff;border-radius:8px;padding:16px 20px;min-width:110px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.v{font-size:28px;font-weight:700;color:#2563eb}.v.red{color:#dc2626}.lbl{font-size:12px;color:#888;margin-top:2px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:4px}
th{background:#f0f0f0;text-align:left;padding:8px 12px;font-size:12px}
td{padding:8px 12px;border-top:1px solid #eee;font-size:13px}
</style></head>
<body><h1>🎓 高考志愿咨询 · 运营看板</h1>
<div id="app">加载中...</div>
<script>
(async function(){
  // 优先从 sessionStorage 读 key；没有则提示登录（不再走 URL）
  let KEY = sessionStorage.getItem('adminKey');
  // 兼容旧链接：若 URL 仍含 key，迁移到 sessionStorage 并清除 URL
  const urlKey = new URLSearchParams(window.location.search).get('key');
  if (urlKey) { KEY = urlKey; sessionStorage.setItem('adminKey', urlKey); history.replaceState(null,'','/admin'); }
  if (!KEY) {
    document.getElementById('app').innerHTML =
      '<div style="background:#fff;padding:24px;border-radius:8px;max-width:360px;margin:40px auto;box-shadow:0 1px 3px rgba(0,0,0,.08)">'
      +'<h3 style="margin:0 0 12px">请输入管理员密钥</h3>'
      +'<input id=k type=password style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:14px" placeholder="STATS_KEY">'
      +'<button onclick="(function(){var v=document.getElementById(\\'k\\').value.trim();if(v){sessionStorage.setItem(\\'adminKey\\',v);location.reload()}})()" '
      +'style="margin-top:10px;width:100%;padding:8px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer">登 录</button>'
      +'</div>';
    document.getElementById('k')?.addEventListener('keydown',e=>{if(e.key==='Enter')e.target.nextElementSibling.click()});
    return;
  }
  let d;
  try {
    const r = await fetch('/api/stats', { headers: { 'Authorization': 'Bearer ' + KEY }});
    if (r.status === 401) { sessionStorage.removeItem('adminKey'); document.getElementById('app').innerHTML='<p style="color:red">密钥错误，<a href=/admin>重新登录</a></p>'; return; }
    d = await r.json();
  } catch(e) { document.getElementById('app').innerHTML='<p style="color:red">加载失败: '+e.message+'</p>'; return; }
  if (d.error) { document.getElementById('app').innerHTML='<p style="color:red">错误: '+d.error+'</p>'; return; }

  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const card = (v,lbl,cls) => '<div class=card><div class="v'+(cls?' '+cls:'')+'">'+(v??'-')+'</div><div class=lbl>'+lbl+'</div></div>';

  let h='';
  h+='<h2>今日概览</h2><div class=cards>';
  h+=card(d.today.conversations,'对话数');
  h+=card(d.today.user_messages,'用户消息');
  h+=card(d.today.ai_responses,'AI 回复');
  h+=card(d.today.crisis_signals,'🆘 危机信号',d.today.crisis_signals>0?'red':'');
  h+=card(Math.round(d.avg_latency_ms/1000)+'s','平均延迟');
  h+='</div>';

  h+='<h2>累计反馈（测试数据已过滤）</h2><div class=cards>';
  h+=card(d.feedback_stats.thumbs_up,'👍 有帮助');
  h+=card(d.feedback_stats.thumbs_down,'👎 没帮助');
  h+=card(d.feedback_stats.copy,'📋 复制');
  h+='</div>';

  h+='<h2>近 7 天</h2><table><tr><th>日期</th><th>对话</th><th>用户消息</th><th>AI回复</th><th>危机</th></tr>';
  for(const day of d.last_7_days)
    h+='<tr><td>'+day.date+'</td><td>'+day.conversations+'</td><td>'+day.user_messages+'</td><td>'+day.ai_responses+'</td>'
      +'<td'+(day.crisis_signals>0?' style="color:#dc2626"':'')+'>'+day.crisis_signals+'</td></tr>';
  h+='</table>';

  h+='<h2>👎 差评最多的问题</h2><table><tr><th>#</th><th>问题</th><th>次数</th></tr>';
  if(!d.top_bad_questions.length) h+='<tr><td colspan=3 style="color:#aaa;text-align:center">暂无数据</td></tr>';
  else d.top_bad_questions.forEach((q,i)=>{ h+='<tr><td>'+(i+1)+'</td><td>'+esc(q.content)+'</td><td>'+q.cnt+'</td></tr>'; });
  h+='</table>';

  document.getElementById('app').innerHTML=h;
})();
<\/script></body></html>`;

// 埋点数据库（启动时初始化）
let convDb = null;

// 生成唯一ID（Node 18+ 使用 randomUUID，降级用 hex）
function generateId() {
  return crypto.randomUUID ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

// IP哈希（sha256前16位，不可逆）
function hashIp(ip) {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

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
      const aPlusList = info["A+学科"];
      const aPlus = aPlusList?.length > 0 ? `A+学科:${aPlusList.slice(0,3).join("/")}` : "";
      found.push(`【${name}】${tags.join(" | ")}${aPlus ? " | " + aPlus : ""}${info.特色 ? " | " + info.特色 : ""}`);
    }
  }
  return found.length > 0
    ? "\n\n【学校基本信息】\n" + found.join("\n")
    : "";
}

// 批次控制线文件路径
const BATCH_LINES_PATH = path.join(ROOT, "01_政策规则", "全国_批次控制线汇总.md");
let batchLinesContent = "";
try {
  batchLinesContent = fs.readFileSync(BATCH_LINES_PATH, "utf-8");
  console.log(`✅ 批次控制线库已加载`);
} catch (e) {
  console.log("⚠️  批次控制线文件未找到，跳过");
}

// 从批次控制线文件中提取指定省份数据，只返回近2年，避免注入过多历史噪声
function getBatchLinesContext(province) {
  if (!batchLinesContent || !province) return "";
  const lines = batchLinesContent.split("\n");
  const byYear = {};   // year → [行...]
  let inTable = false;
  let sectionYear = "";

  for (const line of lines) {
    const yearMatch = line.match(/^## (\d{4})年/);
    if (yearMatch) { sectionYear = yearMatch[1]; inTable = false; continue; }
    if (line.startsWith("| 省份") || line.startsWith("|---")) { inTable = true; continue; }
    if (inTable && line.includes(`| ${province} |`)) {
      if (!byYear[sectionYear]) byYear[sectionYear] = [];
      byYear[sectionYear].push(line.trim());
    }
  }

  // 只取最近2年
  const years = Object.keys(byYear).sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 2);
  if (years.length === 0) return "";

  const parts = years.map(yr => `**${yr}年**\n${byYear[yr].join("\n")}`);
  return `\n\n【${province}批次控制线（近2年）】\n`
    + `格式：物理类/历史类 本科控制线（★新高考=统一本科批线；老高考=一本控制线）\n`
    + `⚠️ 数据按年份分组，请严格区分，不要混用\n\n`
    + parts.join("\n\n");
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

## 个性化规则（违反即降级回答）
- 任何回答都必须至少一次明确引用考生的省份或分数（如「你是山东580分」「你在河南文科500分这个段位」）
- 禁止出现可以复制粘贴给任何人的通用回答；如果没有考生信息，必须先问清楚省份和分数再作答
- 专业咨询类问题必须点出考生所在省份的代表性院校（至少1-2所），禁止只给全国通用推荐

## 回答结构
专业咨询：① 先说结论（值不值得报）② 靠什么吃饭 ③ 适合/不适合谁 ④ 对普通家庭意味着什么 ⑤ 该省有哪些适合报该专业的院校（必须点出考生省份的代表性院校）⑥ 替代方案
录取咨询：① 先说倾向（冲/可搏/偏稳/稳/保）② 历史数据怎么说 ③ 缺什么关键数据 ④ 下一步建议
政策/策略咨询：① 先说该省是否适用（新高考/旧高考/本省特殊政策）② 再给具体建议 ③ 外省政策不适用时必须说明

## 情绪处理
- 识别到焦虑/崩溃时：先接住情绪，稳住，再给务实方案
- 识别到"考砸了""不想活了"等危险信号：必须给出心理援助热线（010-82951332 / 400-821-1215）
- 不对崩溃用户使用激将法

## 院校推荐规则（重要）

当用户问"能上哪些学校"或"推荐学校"类问题时：

1. **必须按层级分类推荐**：冲、稳、保三档，每档至少给3-5所学校
2. **本省院校必须单独列出一档**：哪怕分数偏高或偏低，也要列出考生本省的主要院校，说明匹配关系
3. **结合考生"我的情况"做筛选**：
   - 用户说"喜欢数理化"→重点推工科、理科强校，避免推财经师范类
   - 用户说"不想学医"→明确排除医学类院校
   - 用户说"想留在XX城市"→优先该城市院校
   - 用户说"家里希望考编/考公"→优先师范、政法、财经类
   - 用户说"学费敏感"→优先公办，避免推中外合作
4. **每所学校必须说一句"为什么适合你"**：不要只列学校名，要说明匹配理由
5. **如果候选数据不足以覆盖某档**：明确说"知识库中XX档数据较少，建议自行查询XX官网补充"，不要编造

## 数据引用纪律（公益项目核心准则，违反即重大事故）
1. 引用任何分数/位次/批次线，必须明确说出年份，不允许"近几年""最近"这种模糊词
2. 不同省份的数据绝对不能混用。如果上下文里有多省数据，只用用户所在省的
3. 如果数据缺失或只有老数据，必须明确告知用户"当前可参考数据较少/较旧"，建议去阳光高考/省考试院核实
4. 不要补全你不知道的数据。比如不知道某学校2025年录取分，就说"2025年数据暂缺"，绝不能用2024年数据冒充2025年`;


// ==================== 危机识别 ====================

// 检测用户消息是否包含心理危机信号，任一命中返回 true
function detectCrisis(text) {
  // ── L1_STRONG：绝对强触发，白名单对它无效 ──
  const L1_STRONG = [
    "不想活", "想死", "去死", "自杀", "跳楼", "轻生",
    "了断", "结束生命", "活不下去",
  ];
  if (L1_STRONG.some(kw => text.includes(kw))) return true;

  // ── 家庭暴力，单独出现即触发 ──
  const VIOLENCE = ["我爸打我", "我妈打我", "家里待不下去", "不敢回家", "被打"];
  if (VIOLENCE.some(kw => text.includes(kw))) return true;

  // ── 极度绝望 + 考试上下文 ──
  const DESPAIR  = ["完蛋了", "废了", "没希望了"];
  const EXAM_CTX = ["考", "分数", "前途", "高考", "成绩", "志愿"];
  for (const d of DESPAIR) {
    if (text.includes(d) && EXAM_CTX.some(c => text.includes(c))) return true;
  }

  // ── softSignals + lifeWords（精确词组，避免"生活/干活"误伤）──
  const SOFT     = ["没意义", "没意思", "解脱", "吃药"];
  const LIFE_CTX = ["活下去", "活着", "人生", "生命", "存在", "这辈子"];
  for (const s of SOFT) {
    if (text.includes(s) && LIFE_CTX.some(lw => text.includes(lw))) return true;
  }

  // ── L1_SOFT：情绪词，受白名单保护 ──
  const L1_SOFT = ["坚持不住", "撑不住", "不想坚持"];
  if (L1_SOFT.some(kw => text.includes(kw))) {
    const SAFE = [
      "复读", "换专业", "重新来", "再来一次", "休息", "调整", "重新开始", "转行", "加油",
      "学习", "备考", "做题", "刷题",
      "工作", "锻炼", "跑步", "健身", "减肥",
    ];
    if (SAFE.some(w => text.includes(w))) return false;
    return true;
  }

  return false;
}

// 启动自测（失败只打日志，不阻断服务启动）
function testCrisisDetection() {
  const cases = [
    // ── 必须触发（底线）──
    ["我不想活了",                true],
    ["考砸了不想活",              true],
    ["我想自杀",                  true],
    ["我爸打我",                  true],
    ["活不下去了",                true],
    ["高考完蛋了没希望了",        true],
    ["分数出来废了",              true],
    ["坚持不住了",                true],   // L1_SOFT 无白名单词
    ["我不想活了，加油备考",      true],   // L1_STRONG 不受白名单影响
    ["活着没意思",                true],   // SOFT+LIFE_CTX "活着"
    // ── 不能触发（防误伤）──
    ["我考砸了想复读",            false],
    ["这个专业没意思",            false],
    ["学习没动力",                false],
    ["高考志愿怎么填",            false],
    ["我想去北京大学",            false],
    ["考砸了坚持不住了想复读",    false],  // L1_SOFT + 白名单"复读"
    ["学习坚持不住了",            false],  // L1_SOFT + 白名单"学习"
    ["工作坚持不住了",            false],  // L1_SOFT + 白名单"工作"
    ["生活没意思",                false],  // SOFT "没意思" + LIFE_CTX 无精确匹配
    ["这种活没意思",              false],  // 同上
  ];
  let pass = 0, fail = 0;
  for (const [input, expected] of cases) {
    const result = detectCrisis(input);
    if (result === expected) { pass++; }
    else {
      console.error(`❌ 危机检测失败: "${input}" → 期望${expected}, 实际${result}`);
      fail++;
    }
  }
  if (fail === 0) console.log(`✅ 危机识别自测通过 (${pass}/${cases.length})`);
  else console.error(`⚠️  危机识别自测: ${pass}通过, ${fail}失败`);
}

// 危机场景下注入到 sysPrompt 最前的强约束段
const CRISIS_PROMPT = `用户当前可能处于心理危机状态。你的回答必须遵守：
1. 第一句话必须共情接住情绪，不评价、不急着讲志愿
2. 不使用任何激将法、批评、嘲讽、"你应该"句式
3. 不承诺"一切都会好的""没事的"这种空话
4. 回答末尾必须附上下方求助渠道（原文不改）：

━━━━━━━━━━━━━━━━━━━━━
🆘 你不是一个人，请联系：
北京心理危机研究与干预中心：010-82951332
希望24热线：400-161-9995
抑郁援助热线：400-995-0008
━━━━━━━━━━━━━━━━━━━━━

`;

// ==================== 埋点数据库 ====================

function initConversationsDb() {
  if (!Database) return;
  try {
    if (!fs.existsSync(CONV_DB_DIR)) fs.mkdirSync(CONV_DB_DIR, { recursive: true });
    convDb = new Database(CONV_DB_PATH);
    convDb.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        ip_hash TEXT,
        province TEXT,
        subject TEXT,
        score INTEGER,
        has_crisis_signal INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        role TEXT,
        content TEXT,
        parent_message_id TEXT,
        latency_ms INTEGER,
        prompt_version TEXT DEFAULT 'v1.0',
        is_crisis_response INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS retrieved_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        source TEXT,
        category TEXT,
        score REAL,
        rank INTEGER,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        feedback_type TEXT,
        implicit INTEGER DEFAULT 0,
        is_test INTEGER DEFAULT 0,
        created_at INTEGER
      );
    `);
    // 兼容旧库：若 is_test 列不存在则补加（安全幂等）
    try { convDb.exec(`ALTER TABLE feedback ADD COLUMN is_test INTEGER DEFAULT 0`); } catch {}
    console.log("✅ 埋点数据库已初始化:", CONV_DB_PATH);
  } catch (e) {
    console.error("⚠️  埋点数据库初始化失败:", e.message);
  }
}

// 持久化检测：写入时间戳文件，下次启动时判断 data/ 是否被清空
function checkDataPersistence() {
  const checkFile = path.join(CONV_DB_DIR, "_persistence_check");
  try {
    if (!fs.existsSync(CONV_DB_DIR)) fs.mkdirSync(CONV_DB_DIR, { recursive: true });
    if (fs.existsSync(checkFile)) {
      const prevTs = parseInt(fs.readFileSync(checkFile, "utf-8") || "0");
      const hours  = Math.round((Date.now() - prevTs) / 3_600_000);
      console.log(`✅ 持久化检查: data/ 目录持久化正常（距上次启动约 ${hours} 小时）`);
    } else {
      console.log("⚠️  持久化检查: 首次启动或 data/ 目录已被清空");
      console.log("   若此提示每次重启后都出现 → data/ 是临时目录，埋点数据会丢失！");
      console.log("   Zeabur 用户请在控制台挂载 Volume: /app/data");
    }
    fs.writeFileSync(checkFile, Date.now().toString(), "utf-8");
  } catch(e) {
    console.error("❌ 持久化检查失败:", e.message, "→ data/ 不可写，埋点数据将丢失");
  }
}

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
        // 流式写盘，避免大文件全量载入内存导致 OOM
        const tmpPath = SCORE_DB_PATH + ".tmp";
        const fileStream = fs.createWriteStream(tmpPath);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0 && received % (10 * 1024 * 1024) < chunk.length) {
            console.log(`   已下载 ${Math.round(received/1024/1024)}MB / ${Math.round(total/1024/1024)}MB`);
          }
        });
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fs.renameSync(tmpPath, SCORE_DB_PATH);
          console.log(`✅ 数据库下载完成 (${Math.round(received/1024/1024)}MB)`);
          resolve();
        });
        fileStream.on("error", (e) => { fs.unlink(tmpPath, () => {}); reject(e); });
        res.on("error", (e) => { fs.unlink(tmpPath, () => {}); reject(e); });
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

  const downloadUrl = process.env.DB_DOWNLOAD_URL;

  // 如果设置了下载地址，先检查 Volume 里是否已有完整文件（≥250MB）
  // 设置 DB_FORCE_DOWNLOAD=1 可强制重新下载（用于替换更新后的数据库）
  if (downloadUrl) {
    const forceDownload = process.env.DB_FORCE_DOWNLOAD === "1";
    let skipDownload = false;
    if (!forceDownload && fs.existsSync(SCORE_DB_PATH)) {
      const sizeMB = fs.statSync(SCORE_DB_PATH).size / (1024 * 1024);
      if (sizeMB >= 250) {
        console.log(`✅ 录取数据库已存在，跳过下载 (${Math.round(sizeMB)}MB)`);
        skipDownload = true;
      }
    }
    if (forceDownload) {
      console.log("🔄 DB_FORCE_DOWNLOAD=1，强制重新下载数据库...");
    }
    if (!skipDownload) {
      try {
        await downloadDatabase(downloadUrl);
      } catch (e) {
        console.error("⚠️  数据库下载失败:", e.message, "，尝试使用本地缓存");
      }
    }
  }

  // 加载数据库（下载的新文件或已有的旧文件）
  if (fs.existsSync(SCORE_DB_PATH) && tryLoadDatabase()) return;

  console.log("📊 录取数据库未找到（可设置 DB_DOWNLOAD_URL 环境变量自动下载）");
}

// 查询录取数据库
function searchAdmissionDB(query, userProfile = {}) {
  if (!db || !dbSchema) return [];
  const { tableName, colMap } = dbSchema;
  const { province, score, subject } = userProfile;
  const curYear = new Date().getFullYear();

  try {
    const conditions = [];
    const params = {};

    // 省份：强匹配（= 不是 LIKE），无省份直接返回空，拒绝返回全国混合数据
    const provinceVal = province || extractProvince(query);
    if (provinceVal && colMap.province) {
      conditions.push(`"${colMap.province}" = @province`);
      params.province = provinceVal;
    } else {
      return []; // 没有省份信息，不查询
    }

    // 年份：query里提了就精确过滤，否则只取近2年
    const yearVal = extractYear(query);
    if (yearVal && colMap.year) {
      conditions.push(`"${colMap.year}" = @year`);
      params.year = yearVal;
    } else if (colMap.year) {
      conditions.push(`"${colMap.year}" >= @yearMin`);
      params.yearMin = curYear - 1;
    }

    // 科目过滤（理科=物理类，文科=历史类，兼容新旧高考）
    const rawSubject = subject || extractSubject(query);
    const subjectNorm = extractSubject(rawSubject + query);
    if (subjectNorm && colMap.subject) {
      if (subjectNorm === "理") {
        conditions.push(`("${colMap.subject}" LIKE '%理科%' OR "${colMap.subject}" LIKE '%物理%')`);
      } else if (subjectNorm === "文") {
        conditions.push(`("${colMap.subject}" LIKE '%文科%' OR "${colMap.subject}" LIKE '%历史%')`);
      }
    }

    const orderBy = colMap.year ? `ORDER BY "${colMap.year}" DESC` : "";

    // 分数过滤：先尝试 ±15，不足5条扩到 ±25
    const scoreVal = score ? parseInt(score) : extractScore(query);
    if (scoreVal > 0 && colMap.minScore) {
      const scoreConds = [...conditions,
        `CAST("${colMap.minScore}" AS INTEGER) BETWEEN @scoreMin AND @scoreMax`];
      const tryScore = (delta) => {
        const p = { ...params, scoreMin: scoreVal - delta, scoreMax: scoreVal + delta };
        return db.prepare(
          `SELECT * FROM "${tableName}" WHERE ${scoreConds.join(" AND ")} ${orderBy} LIMIT 80`
        ).all(p);
      };
      let rows = tryScore(15);
      if (rows.length < 5) rows = tryScore(25);
      if (!rows.length) return [];
      return [{ category: "录取数据库", source: "gaokao_2025.db", score: 1.0,
        preview: formatDbRows(rows, colMap) }];
    }

    // 无分数：学校/专业关键词匹配（必须同时有省份，否则上面已返回空）
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
    } else {
      return []; // 只有省份没有其他过滤条件，不拉全省数据
    }

    const sql  = `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")} ${orderBy} LIMIT 80`;
    const rows = db.prepare(sql).all(params);
    if (!rows.length) return [];
    return [{ category: "录取数据库", source: "gaokao_2025.db", score: 1.0,
      preview: formatDbRows(rows, colMap) }];
  } catch (e) {
    console.error("数据库查询失败:", e.message);
    return [];
  }
}

function formatDbRows(rows, colMap) {
  const lines = [`共找到 ${rows.length} 条录取记录：\n`];
  for (const row of rows.slice(0, 60)) {
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

// 从文本中提取具体年份（今年/去年/4位数字）
function extractYear(text) {
  const cur = new Date().getFullYear();
  if (text.includes("今年")) return cur;
  if (text.includes("去年")) return cur - 1;
  const m = text.match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1]) : null;
}

// 停用词：不应被识别为学校/专业名的词
const KEYWORD_STOPWORDS = new Set(["哪些大学","什么大学","哪所大学","哪个大学","好大学","名牌大学","重点大学","哪些学院","什么学院"]);

function extractKeywords(text) {
  const words = [];
  // 优先从学校标签库匹配（支持短校名，如"清华""浙大"）
  for (const name of Object.keys(schoolTags)) {
    if (name.startsWith("_")) continue;
    if (text.includes(name)) words.push(name);
  }
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
  // walkMarkdownFiles 内部已有 try/catch，不会抛出，无需外层包裹
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

// 读取请求 body，带最大长度限制（防 OOM 攻击）
async function readBody(req, maxBytes = 100 * 1024) {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error("payload too large");
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
    body += chunk;
  }
  return body;
}

// 安全的常数时间字符串比较（防时序攻击）
function safeKeyEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 从请求中提取鉴权 key（优先 Authorization 头，兼容 query 参数）
function extractAuthKey(req, url) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) return authHeader.substring(7).trim();
  return url.searchParams.get("key") || "";
}

// CORS 来源白名单
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

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

  // CORS：同源请求和白名单域名才允许跨域调用
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.length === 0) {
    // 未配置白名单时，仅允许同源访问（origin为空表示同源）
    if (origin) res.setHeader("Access-Control-Allow-Origin", "null");
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // 健康检查
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString(), hasDb: !!db }));
    return;
  }

  // 聊天接口（SSE 流式输出）
  if (pathname === "/api/chat" && req.method === "POST") {
    // Origin 校验：若配置了白名单，跨域 Origin 必须在白名单内（防被第三方站点滥用付费 LLM）
    if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden origin" })); return;
    }
    // IP 限流（60秒窗口，同IP最多10次请求）
    const _ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const _now = Date.now();
    const _rl = rateLimitMap.get(_ip) || { count: 0, start: _now };
    if (_now - _rl.start > 60_000) { _rl.count = 0; _rl.start = _now; }
    _rl.count++;
    rateLimitMap.set(_ip, _rl);
    if (_rl.count > 10) {
      const waitSec = Math.ceil((60_000 - (_now - _rl.start)) / 1000);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "请求过于频繁，请稍后重试", waitSeconds: waitSec }));
      return;
    }
    let heartbeat = null;
    try {
      const body = await readBody(req, 100 * 1024); // 限制 100KB
      const { message, history = [], userProfile = {} } = JSON.parse(body);

      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "消息不能为空" }));
        return;
      }

      // 危机检测 + 埋点变量
      const isCrisis   = detectCrisis(message);
      const convId     = generateId();
      const userMsgId  = generateId();
      const asstMsgId  = generateId();
      const reqStart   = Date.now();

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
      heartbeat = setInterval(() => {
        try { res.write(": ping\n\n"); } catch {}
      }, 5000);

      // 写入 conversation + user message（失败只打日志）
      try {
        if (convDb) {
          convDb.prepare(
            `INSERT INTO conversations (id,ip_hash,province,subject,score,has_crisis_signal,created_at)
             VALUES (?,?,?,?,?,?,?)`
          ).run(convId, hashIp(_ip),
            userProfile.province || "", userProfile.subject || "",
            parseInt(userProfile.score) || null, isCrisis ? 1 : 0, reqStart);
          convDb.prepare(
            `INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)`
          ).run(userMsgId, convId, "user", message, reqStart);
        }
      } catch(e) { console.error("埋点写入失败:", e.message); }

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

      // 写入 retrieved_chunks（失败只打日志）
      try {
        if (convDb) {
          const stmt = convDb.prepare(
            `INSERT INTO retrieved_chunks (message_id,source,category,score,rank,created_at)
             VALUES (?,?,?,?,?,?)`
          );
          searchResults.forEach((r, idx) =>
            stmt.run(asstMsgId, r.source, r.category, r.score, idx + 1, Date.now()));
        }
      } catch(e) { console.error("埋点写入失败:", e.message); }

      // 2. 组装上下文
      let context = "";
      // 注入学校标签（985/211/双一流/A+学科）
      const schoolTagCtx = getSchoolTagContext(message);
      if (schoolTagCtx) context += schoolTagCtx;
      // 注入考生省份批次控制线（帮AI判断用户位次/批次归属）
      const batchCtx = getBatchLinesContext(userProfile.province);
      if (batchCtx) context += batchCtx;
      if (searchResults.length > 0) {
        context += "\n\n以下是相关知识库内容供参考：\n\n";
        for (const r of searchResults) {
          context += `[${r.category}] ${r.source}\n${r.preview}\n\n---\n\n`;
        }
      }

      // 3. 构建消息（含历史 + 考生信息注入到系统提示）
      // 危机场景：在最前面注入强约束段，优先级高于其他提示
      let sysPrompt = isCrisis ? CRISIS_PROMPT + SYSTEM_PROMPT : SYSTEM_PROMPT;
      const { province, subject, score, rank, situation } = userProfile;
      if (province || score) {
        sysPrompt += "\n\n当前考生信息：";
        if (province) sysPrompt += `省份=${province}`;
        if (subject)  sysPrompt += `，科目=${subject}`;
        if (score)    sysPrompt += `，高考分数=${score}分`;
        if (rank)     sysPrompt += `，位次=${rank}`;
        sysPrompt += '。\n【强制要求】回答时必须在开头先点明考生身份（如「你是山东理科580分」），然后基于该省份、该分段、该科类的具体情况分析，禁止给通用答案。无需重复询问这些信息。';
      }
      if (situation) sysPrompt += `\n考生补充情况：${situation}，请结合这些信息给出更有针对性的分析。`;

      const messages = [{ role: "system", content: sysPrompt }];
      // 加入最近 3 轮历史（6条消息），避免 token 过多
      for (const msg of history.slice(-6)) {
        if (msg.role && msg.content) messages.push({ role: msg.role, content: msg.content });
      }
      messages.push({ role: "user", content: context + "用户问题：" + message });

      // 4. 流式调用 LLM，同时在服务端累积完整回复用于埋点
      let replyText = "";
      try {
        await callLLMStream(messages, (chunk) => {
          replyText += chunk;
          emit({ type: "delta", content: chunk });
        });
        // 写入 assistant message（失败只打日志）
        try {
          if (convDb) {
            convDb.prepare(
              `INSERT INTO messages
               (id,conversation_id,role,content,parent_message_id,latency_ms,is_crisis_response,created_at)
               VALUES (?,?,?,?,?,?,?,?)`
            ).run(asstMsgId, convId, "assistant", replyText,
              userMsgId, Date.now() - reqStart, isCrisis ? 1 : 0, Date.now());
          }
        } catch(e) { console.error("埋点写入失败:", e.message); }
        emit({ type: "done", message_id: asstMsgId });
      } finally {
        clearInterval(heartbeat);
      }
      res.end();
    } catch (error) {
      console.error("聊天错误:", error);
      if (error.code === "PAYLOAD_TOO_LARGE") {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求内容过大" })); return;
      }
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
      // 过滤乱码：只保留合法中文/字母/数字/常见标点，排除编码异常字符
      const cleanText = arr => arr.filter(s =>
        s && /^[一-鿿㐀-䶿\w\s\(\)\（\）\+\-\/·【】，、。A-Za-z0-9+]+$/.test(s)
      );
      const tbl = dbSchema?.tableName || "major_scores";
      const provinces = cleanText(db.prepare(`SELECT DISTINCT province FROM "${tbl}" WHERE province IS NOT NULL ORDER BY province`).all().map(r => r.province));
      const years     = db.prepare(`SELECT DISTINCT year FROM "${tbl}" WHERE year IS NOT NULL ORDER BY year DESC`).all().map(r => r.year);
      const batches   = cleanText(db.prepare(`SELECT DISTINCT batch FROM "${tbl}" WHERE batch IS NOT NULL ORDER BY batch`).all().map(r => r.batch));
      const subjects  = cleanText(db.prepare(`SELECT DISTINCT subject FROM "${tbl}" WHERE subject IS NOT NULL ORDER BY subject`).all().map(r => r.subject));
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
      const major    = url.searchParams.get("major")    || "";
      const page     = parseInt(url.searchParams.get("page") || "1");
      const pageSize = 50;

      const conditions = [];
      const params     = [];
      if (province) { conditions.push("province = ?"); params.push(province); }
      if (school)   { conditions.push("school LIKE ?"); params.push(`%${school}%`); }
      if (year)     { conditions.push("year = ?"); params.push(year); }
      if (subject)  { conditions.push("subject = ?"); params.push(subject); }
      if (batch)    { conditions.push("batch = ?"); params.push(batch); }
      if (major) {
        // 匹配：专业名等于搜索词，或以"搜索词（"开头（如"土木工程（中外合作）"）
        // 不匹配：括号内含有该词的试验班（如"理科试验班（含土木工程）"）
        conditions.push("(major_group LIKE ? OR major = ? OR major LIKE ? OR major LIKE ?)");
        params.push(`%${major}%`, major, `${major}（%`, `${major}(%`);
      }

      if (conditions.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请至少填写一个筛选条件" })); return;
      }

      const where = "WHERE " + conditions.join(" AND ");
      const total = db.prepare(`SELECT COUNT(*) as cnt FROM major_scores ${where}`).get(...params).cnt;
      const rows  = db.prepare(
        `SELECT school, province, year, subject, batch, major_group, major, min_score, min_rank
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

  // 用户反馈接口
  if (pathname === "/api/feedback" && req.method === "POST") {
    try {
      const body = await readBody(req, 10 * 1024); // 限制 10KB
      const { message_id, feedback_type, implicit = false, test_mode = false } = JSON.parse(body);
      if (!message_id || !feedback_type) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing fields" })); return;
      }
      try {
        if (convDb) {
          convDb.prepare(
            `INSERT INTO feedback (message_id,feedback_type,implicit,is_test,created_at) VALUES (?,?,?,?,?)`
          ).run(message_id, feedback_type, implicit ? 1 : 0, test_mode ? 1 : 0, Date.now());
        }
      } catch(e) { console.error("feedback写入失败:", e.message); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      if (e.code === "PAYLOAD_TOO_LARGE") {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求内容过大" })); return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server error" }));
    }
    return;
  }

  // 简易运营看板（需 STATS_KEY 鉴权）
  if (pathname === "/api/stats" && req.method === "GET") {
    const key = extractAuthKey(req, url);
    if (!STATS_KEY || !safeKeyEqual(key, STATS_KEY)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" })); return;
    }
    if (!convDb) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stats db not available" })); return;
    }
    try {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const ts = todayStart.getTime();
      const today = {
        conversations:  convDb.prepare("SELECT COUNT(*) as c FROM conversations WHERE created_at>=?").get(ts).c,
        user_messages:  convDb.prepare("SELECT COUNT(*) as c FROM messages WHERE role='user' AND created_at>=?").get(ts).c,
        ai_responses:   convDb.prepare("SELECT COUNT(*) as c FROM messages WHERE role='assistant' AND created_at>=?").get(ts).c,
        crisis_signals: convDb.prepare("SELECT COUNT(*) as c FROM conversations WHERE has_crisis_signal=1 AND created_at>=?").get(ts).c,
      };
      const last_7_days = [];
      for (let i = 6; i >= 0; i--) {
        const d  = new Date(); d.setDate(d.getDate() - i);  d.setHours(0,0,0,0);
        const d2 = new Date(d); d2.setDate(d2.getDate() + 1);
        const t1 = d.getTime(), t2 = d2.getTime();
        last_7_days.push({
          date:           d.toISOString().slice(0, 10),
          conversations:  convDb.prepare("SELECT COUNT(*) as c FROM conversations WHERE created_at>=? AND created_at<?").get(t1,t2).c,
          user_messages:  convDb.prepare("SELECT COUNT(*) as c FROM messages WHERE role='user' AND created_at>=? AND created_at<?").get(t1,t2).c,
          ai_responses:   convDb.prepare("SELECT COUNT(*) as c FROM messages WHERE role='assistant' AND created_at>=? AND created_at<?").get(t1,t2).c,
          crisis_signals: convDb.prepare("SELECT COUNT(*) as c FROM conversations WHERE has_crisis_signal=1 AND created_at>=? AND created_at<?").get(t1,t2).c,
        });
      }
      const feedback_stats = {
        thumbs_up:   convDb.prepare("SELECT COUNT(*) as c FROM feedback WHERE feedback_type='thumbs_up'   AND is_test=0").get().c,
        thumbs_down: convDb.prepare("SELECT COUNT(*) as c FROM feedback WHERE feedback_type='thumbs_down' AND is_test=0").get().c,
        copy:        convDb.prepare("SELECT COUNT(*) as c FROM feedback WHERE feedback_type='copy'        AND is_test=0").get().c,
      };
      const avgRow = convDb.prepare("SELECT AVG(latency_ms) as avg FROM messages WHERE role='assistant' AND latency_ms IS NOT NULL").get();
      const top_bad_questions = convDb.prepare(`
        SELECT mu.content, COUNT(*) as cnt
        FROM feedback f
        JOIN messages ma ON f.message_id = ma.id
        JOIN messages mu ON mu.conversation_id = ma.conversation_id AND mu.role='user'
        WHERE f.feedback_type='thumbs_down' AND f.is_test=0
        GROUP BY mu.content ORDER BY cnt DESC LIMIT 10
      `).all();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ today, last_7_days, feedback_stats,
        avg_latency_ms: Math.round(avgRow.avg || 0), top_bad_questions }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 运营看板 HTML 页面（公开页面：先发登录表单，由前端用密码请求接口）
  if (pathname === "/admin" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ADMIN_HTML);
    return;
  }

  // 会话/消息检视接口（运营用）
  if (pathname === "/api/inspect" && req.method === "GET") {
    const key = extractAuthKey(req, url);
    if (!STATS_KEY || !safeKeyEqual(key, STATS_KEY)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" })); return;
    }
    if (!convDb) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "db not available" })); return;
    }
    try {
      const convId = url.searchParams.get("conv_id");
      const limit  = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      const offset = parseInt(url.searchParams.get("offset") || "0");
      if (convId) {
        // 查单个会话的全部消息
        const messages = convDb.prepare(
          `SELECT id, role, content, latency_ms, is_crisis_response, created_at
           FROM messages WHERE conversation_id=? ORDER BY created_at ASC`
        ).all(convId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ conv_id: convId, messages }));
      } else {
        // 列出最近 N 个会话（带消息计数）
        const rows = convDb.prepare(
          `SELECT c.id, c.ip_hash, c.province, c.subject, c.score,
                  c.has_crisis_signal, c.created_at, COUNT(m.id) as msg_count
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id=c.id
           GROUP BY c.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
        ).all(limit, offset);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ conversations: rows, limit, offset }));
      }
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 配置信息
  if (pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    let dbRowCount = 0;
    if (db) {
      try { dbRowCount = db.prepare("SELECT COUNT(*) as c FROM " + (dbSchema?.tableName || "major_scores")).get().c; } catch(e) {}
    }
    res.end(JSON.stringify({
      hasApiKey: !!SILICONCLOUD_API_KEY,
      hasQdrant: !!QDRANT_URL,
      hasDb: !!db,
      dbRowCount,
      llmModel: LLM_MODEL,
      embeddingModel: EMBEDDING_MODEL,
      schoolNames: Object.keys(schoolTags).filter(k => !k.startsWith('_'))
    }));
    return;
  }

  // 敏感文件/目录黑名单（防止 .env / server.js 等被直接访问）
  const BLOCKED_FILES = ['.env', '.env.example', 'server.js', 'package.json', 'package-lock.json'];
  const BLOCKED_DIRS  = ['node_modules', 'data', '07_录取数据', '00_项目总控',
                         '01_政策规则', '02_省份数据', '03_院校库', '04_专业库',
                         '05_张雪峰风格库', '06_案例库', '08_提示词模板'];
  if (BLOCKED_FILES.includes(path.basename(pathname)) ||
      BLOCKED_DIRS.some(d => pathname === '/' + d || pathname.startsWith('/' + d + '/'))) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  // /static/ 子路由：仅允许图片，basename() 防子目录穿越
  if (pathname.startsWith('/static/')) {
    const ALLOWED_IMG = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.gif'];
    const imgExt = path.extname(pathname).toLowerCase();
    if (!ALLOWED_IMG.includes(imgExt)) { res.writeHead(404); res.end("Not Found"); return; }
    const staticFile = path.join(ROOT, 'static', path.basename(pathname));
    if (fs.existsSync(staticFile) && fs.statSync(staticFile).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME_TYPES[imgExt] || 'application/octet-stream',
                           'Cache-Control': 'public, max-age=86400' });
      res.end(fs.readFileSync(staticFile));
    } else { res.writeHead(404); res.end("Not Found"); }
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
  initConversationsDb();
  checkDataPersistence();
  testCrisisDetection();
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

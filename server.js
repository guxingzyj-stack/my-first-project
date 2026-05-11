/**
 * 高考志愿咨询系统 - Zeabur 部署版
 * 使用 SiliconCloud API 替代本地 LM Studio
 */

// 加载 .env 文件（本地开发时使用，不依赖 dotenv 包）
const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
  console.log("✅ 已加载 .env 文件");
}

const http = require("http");
const { URL } = require("url");

// ==================== 配置 ====================
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// SiliconCloud API 配置
const SILICONCLOUD_API_KEY = process.env.SILICONCLOUD_API_KEY || "";
const SILICONCLOUD_BASE_URL = process.env.SILICONCLOUD_BASE_URL || "https://api.siliconflow.cn/v1";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-ai/DeepSeek-V2.5";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";

// Qdrant 配置（可选）
const QDRANT_URL = process.env.QDRANT_URL || "";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";

// 知识库目录
const ROOT = __dirname;
const REPO_ROOT = ROOT;  // 知识库在当前目录
const POLICY_DIR = path.join(REPO_ROOT, "01_政策规则");
const MAJOR_DIR = path.join(REPO_ROOT, "04_专业库");
const PROVINCE_DIR = path.join(REPO_ROOT, "02_省份数据");
const SCHOOL_DIR = path.join(REPO_ROOT, "03_院校库");
const SCORE_DB_PATH = path.join(REPO_ROOT, "07_录取数据", "gaokao_2025.db");

// 系统提示词
const SYSTEM_PROMPT = `你是一个高考志愿填报分析助手。
回答时优先使用我提供的检索片段。
如果检索片段不足，可以结合通用经验继续分析，但必须自然说明这部分属于经验判断。
不允许编造分数、位次、投档线、专业组、就业率、保研率、排名、学科评估。
如果问题涉及历史录取数据，要提醒用户历史数据仅供参考，最终要以阳光高考、各省教育考试院、学校本科招生网为准。
回答要像一个懂高考志愿、愿意讲真话的人，先给结论，再讲原因、风险和替代方案。
回答尽量自然，不要写成表格汇报。`;

// ==================== 工具函数 ====================

// 调用 SiliconCloud LLM API
async function callLLM(messages) {
  if (!SILICONCLOUD_API_KEY) {
    throw new Error("SILICONCLOUD_API_KEY 未配置");
  }

  const response = await fetch(`${SILICONCLOUD_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SILICONCLOUD_API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: messages,
      stream: false,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM API 错误: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// 调用 SiliconCloud Embedding API
async function getEmbedding(text) {
  if (!SILICONCLOUD_API_KEY) {
    throw new Error("SILICONCLOUD_API_KEY 未配置");
  }

  const response = await fetch(`${SILICONCLOUD_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SILICONCLOUD_API_KEY}`
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text
    })
  });

  if (!response.ok) {
    throw new Error(`Embedding API 错误: ${response.status}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// 从知识库检索相关内容
async function searchKnowledgeBase(query, topK = 8) {
  const results = [];
  const MIN_SCORE = 0.6; // 最低相关度阈值

  // 1. 搜索政策规则
  results.push(...await searchMarkdownFiles(POLICY_DIR, query, "政策规则"));

  // 2. 搜索专业库
  results.push(...await searchMarkdownFiles(MAJOR_DIR, query, "专业库"));

  // 3. 搜索院校库
  results.push(...await searchMarkdownFiles(SCHOOL_DIR, query, "院校库"));

  // 4. 如果配置了 Qdrant，进行向量搜索
  if (QDRANT_URL) {
    try {
      const queryEmbedding = await getEmbedding(query);
      const vectorResults = await searchQdrant(queryEmbedding, topK * 2); // 多取一些，后续过滤
      
      // 过滤低分结果
      const filteredResults = vectorResults.filter(r => r.score >= MIN_SCORE);
      results.push(...filteredResults);
    } catch (e) {
      console.error("Qdrant 搜索失败:", e.message);
    }
  }

  // 按相关度排序
  results.sort((a, b) => b.score - a.score);

  // 去重（相同 source）
  const uniqueResults = [];
  const seenSources = new Set();
  for (const r of results) {
    if (!seenSources.has(r.source)) {
      seenSources.add(r.source);
      uniqueResults.push(r);
    }
  }

  // 返回 topK
  return uniqueResults.slice(0, topK);
}

// 关键词搜索 Markdown 文件
async function searchMarkdownFiles(dir, query, category) {
  const results = [];
  const keywords = query.toLowerCase().split(/\s+/);

  try {
    const files = walkMarkdownFiles(dir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const contentLower = content.toLowerCase();
        
        // 简单关键词匹配
        let matchCount = 0;
        for (const keyword of keywords) {
          if (contentLower.includes(keyword)) matchCount++;
        }

        if (matchCount > 0) {
          const relativePath = path.relative(REPO_ROOT, file);
          results.push({
            category,
            source: relativePath,
            score: matchCount / keywords.length,
            preview: extractPreview(content, keywords[0])
          });
        }
      } catch (e) {
        // 跳过读取失败的文件
      }
    }
  } catch (e) {
    console.error(`搜索目录失败: ${dir}`, e.message);
  }

  return results;
}

// Qdrant 向量搜索
async function searchQdrant(embedding, topK) {
  const results = [];

  if (!QDRANT_URL || !QDRANT_API_KEY) {
    return results;
  }

  try {
    // 构造 Qdrant 搜索 URL
    const searchUrl = `${QDRANT_URL}/collections/gaokao_knowledge/points/search`;

    // 判断 API Key 类型：如果以 "eyJ" 开头，可能是 JWT Bearer Token
    const isJWT = QDRANT_API_KEY.startsWith("eyJ");
    const headers = {
      "Content-Type": "application/json",
    };

    if (isJWT) {
      headers["Authorization"] = `Bearer ${QDRANT_API_KEY}`;
    } else {
      headers["api-key"] = QDRANT_API_KEY;
    }

    const response = await fetch(searchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        vector: embedding,
        limit: topK,
        with_payload: true
      })
    });

    if (response.ok) {
      const data = await response.json();
      for (const point of data.result || []) {
        results.push({
          category: "知识库（语义搜索）",
          source: point.payload?.source || "未知",
          score: point.score,
          preview: point.payload?.content?.substring(0, 500) || ""
        });
      }
    } else {
      const errorText = await response.text();
      console.error("Qdrant 搜索失败:", response.status, errorText);
    }
  } catch (e) {
    console.error("Qdrant 搜索失败:", e.message);
  }

  return results;
}

// 遍历 Markdown 文件
function walkMarkdownFiles(dir, result = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkMarkdownFiles(full, result);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(full);
      }
    }
  } catch (e) {
    // 目录不存在或无法访问
  }
  return result;
}

// 提取预览文本
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

  // CORS 头
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 健康检查
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    return;
  }

  // API: 聊天接口
  if (pathname === "/api/chat" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      const { message } = JSON.parse(body);

      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "消息不能为空" }));
        return;
      }

      // 1. 检索知识库
      const searchResults = await searchKnowledgeBase(message);

      // 2. 构建上下文
      let context = "";
      if (searchResults.length > 0) {
        context = "\n\n以下是相关知识库内容供参考：\n\n";
        for (const result of searchResults) {
          context += `[${result.category}] ${result.source}\n${result.preview}\n\n---\n\n`;
        }
      }

      // 3. 调用 LLM
      const userMessage = context + "用户问题：" + message;
      const reply = await callLLM([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ]);

      // 4. 返回结果
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        reply,
        sources: searchResults.map(r => ({
          category: r.category,
          source: r.source,
          score: r.score
        }))
      }));

    } catch (error) {
      console.error("聊天错误:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        error: error.message || "服务器错误",
        hint: !SILICONCLOUD_API_KEY ? "请在 Zeabur 环境变量中配置 SILICONCLOUD_API_KEY" : ""
      }));
    }
    return;
  }

  // API: 配置信息
  if (pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      hasApiKey: !!SILICONCLOUD_API_KEY,
      hasQdrant: !!QDRANT_URL,
      llmModel: LLM_MODEL,
      embeddingModel: EMBEDDING_MODEL
    }));
    return;
  }

  // 静态文件服务
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(ROOT, filePath);

  // 安全检查：防止目录遍历
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } else {
      // 文件不存在，返回 index.html（支持 SPA）
      const indexPath = path.join(ROOT, "index.html");
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(indexPath));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    }
  } catch (error) {
    console.error("文件读取错误:", error);
    res.writeHead(500);
    res.end("Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log("=".repeat(50));
  console.log("🎓 高考志愿咨询系统已启动");
  console.log("=".repeat(50));
  console.log(`📍 地址: http://${HOST}:${PORT}`);
  console.log(`🔧 SiliconCloud API: ${SILICONCLOUD_API_KEY ? "✅ 已配置" : "❌ 未配置"}`);
  console.log(`🔧 LLM 模型: ${LLM_MODEL}`);
  console.log(`🔧 Embedding 模型: ${EMBEDDING_MODEL}`);
  console.log(`🔧 Qdrant: ${QDRANT_URL ? "✅ " + QDRANT_URL : "❌ 未配置"}`);
  console.log("=".repeat(50));
});

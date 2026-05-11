/**
 * 知识库数据导入脚本 - 将 Markdown 文件向量化并上传到 Qdrant
 * 使用: node import-to-qdrant.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

// 加载 .env 文件（如果存在）
try {
  require("dotenv").config();
} catch (e) {
  // dotenv 未安装，尝试手动加载 .env
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        process.env[match[1].trim()] = match[2].trim();
      }
    }
  }
}

// ==================== 配置 ====================
const SILICONCLOUD_API_KEY = process.env.SILICONCLOUD_API_KEY || "";
const SILICONCLOUD_BASE_URL = process.env.SILICONCLOUD_BASE_URL || "https://api.siliconflow.cn/v1";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";
const QDRANT_URL = process.env.QDRANT_URL || "";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";

// 知识库目录
const ROOT = __dirname;
const REPO_ROOT = ROOT;
const POLICY_DIR = path.join(REPO_ROOT, "01_政策规则");
const MAJOR_DIR = path.join(REPO_ROOT, "04_专业库");
const PROVINCE_DIR = path.join(REPO_ROOT, "02_省份数据");
const SCHOOL_DIR = path.join(REPO_ROOT, "03_院校库");

const COLLECTION_NAME = "gaokao_knowledge";
const BATCH_SIZE = 10; // 每批处理的文件数

// ==================== 工具函数 ====================

// 调用 Embedding API
async function getEmbedding(text) {
  if (!SILICONCLOUD_API_KEY) {
    throw new Error("SILICONCLOUD_API_KEY 未配置");
  }

  const url = `${SILICONCLOUD_BASE_URL}/embeddings`;
  const payload = JSON.stringify({
    model: EMBEDDING_MODEL,
    input: text.substring(0, 8000), // 限制长度
  });

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SILICONCLOUD_API_KEY}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.data && json.data[0] && json.data[0].embedding) {
            resolve(json.data[0].embedding);
          } else {
            reject(new Error(`Embedding API 错误: ${data}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Qdrant API 调用
async function qdrantRequest(method, endpoint, body = null) {
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    throw new Error("Qdrant 未配置");
  }

  const url = `${QDRANT_URL}${endpoint}`;
  
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

  const options = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  return response.json();
}

// 创建 Qdrant 集合
async function createCollection(vectorSize) {
  try {
    // 检查集合是否存在
    const existing = await qdrantRequest("GET", `/collections/${COLLECTION_NAME}`);
    if (existing.status === "ok") {
      console.log(`✅ 集合 "${COLLECTION_NAME}" 已存在`);
      return;
    }
  } catch (e) {
    // 集合不存在，创建
  }

  console.log(`📦 创建集合 "${COLLECTION_NAME}"...`);
  await qdrantRequest("PUT", `/collections/${COLLECTION_NAME}`, {
    vectors: {
      size: vectorSize,
      distance: "Cosine",
    },
  });
  console.log(`✅ 集合创建成功`);
}

// 上传向量点到 Qdrant
async function uploadPoints(points) {
  console.log(`⬆️  上传 ${points.length} 个向量点...`);
  await qdrantRequest("PUT", `/collections/${COLLECTION_NAME}/points`, {
    points,
  });
  console.log(`✅ 上传成功`);
}

// 读取目录所有 Markdown 文件
function getAllMarkdownFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️  目录不存在: ${dir}`);
    return results;
  }

  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllMarkdownFiles(fullPath));
    } else if (file.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// 读取文件内容并分块（优化版：语义分块 + 重叠）
function readAndChunkFile(filePath, maxChunkSize = 600, overlap = 150) {
  const content = fs.readFileSync(filePath, "utf-8");
  const chunks = [];
  
  // 策略1：按标题分块（Markdown 的 # ## ###）
  const headingSplit = content.split(/\n(?=#{1,3}\s)/);
  
  for (const section of headingSplit) {
    // 如果段落太长，再按句子分块
    if (section.length > maxChunkSize * 1.5) {
      const sentences = section.split(/(?<=[。！？\.\!\?])\s+/);
      let currentChunk = "";
      
      for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxChunkSize) {
          if (currentChunk) {
            chunks.push(currentChunk.trim());
            // 保留重叠部分
            const overlapStart = Math.max(0, currentChunk.length - overlap);
            currentChunk = currentChunk.substring(overlapStart) + sentence;
          } else {
            currentChunk = sentence;
          }
        } else {
          currentChunk += (currentChunk ? " " : "") + sentence;
        }
      }
      if (currentChunk) chunks.push(currentChunk.trim());
    } else {
      chunks.push(section.trim());
    }
  }
  
  // 如果没有按标题分块（比如没有标题的文档），按段落分块
  if (chunks.length === 0) {
    const paragraphs = content.split(/\n\n+/);
    let currentChunk = "";
    
    for (const para of paragraphs) {
      if ((currentChunk + para).length > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = para;
      } else {
        currentChunk += "\n\n" + para;
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
  }
  
  return chunks.map((chunk, idx) => ({
    filePath,
    chunkIndex: idx,
    content: chunk,
    metadata: {
      source: path.relative(REPO_ROOT, filePath),
      chunkIndex: idx,
      length: chunk.length
    },
  }));
}

// ==================== 主函数 ====================

async function main() {
  console.log("==================================================");
  console.log("📥 高考志愿咨询系统 - 知识库数据导入");
  console.log("==================================================\n");

  // 检查配置
  if (!SILICONCLOUD_API_KEY) {
    console.error("❌ 错误: SILICONCLOUD_API_KEY 未配置");
    console.error("请在 Zeabur 环境变量中设置此变量");
    process.exit(1);
  }

  if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.error("❌ 错误: Qdrant 未配置");
    console.error("请在 Zeabur 环境变量中设置 QDRANT_URL 和 QDRANT_API_KEY");
    process.exit(1);
  }

  console.log("🔧 SiliconCloud API: ✅ 已配置");
  console.log("🔧 Qdrant: ✅ 已配置");
  console.log(`🔧 Embedding 模型: ${EMBEDDING_MODEL}\n`);

  // 收集所有文件
  console.log("📂 扫描知识库文件...");
  const policyFiles = getAllMarkdownFiles(POLICY_DIR);
  const majorFiles = getAllMarkdownFiles(MAJOR_DIR);
  const provinceFiles = getAllMarkdownFiles(PROVINCE_DIR);
  const schoolFiles = getAllMarkdownFiles(SCHOOL_DIR);

  console.log(`  - 政策规则: ${policyFiles.length} 个文件`);
  console.log(`  - 专业库: ${majorFiles.length} 个文件`);
  console.log(`  - 省份数据: ${provinceFiles.length} 个文件`);
  console.log(`  - 院校库: ${schoolFiles.length} 个文件`);

  const allFiles = [...policyFiles, ...majorFiles, ...provinceFiles, ...schoolFiles];
  console.log(`📊 总计: ${allFiles.length} 个文件\n`);

  if (allFiles.length === 0) {
    console.error("❌ 错误: 没有找到任何 Markdown 文件");
    process.exit(1);
  }

  // 分块
  console.log("✂️  分块处理...");
  let allChunks = [];
  for (const file of allFiles) {
    const chunks = readAndChunkFile(file);
    allChunks = allChunks.concat(chunks);
  }
  console.log(`📊 总计: ${allChunks.length} 个文本块\n`);

  // 测试 Embedding API 获取向量维度
  console.log("🔍 测试 Embedding API...");
  const testEmbedding = await getEmbedding("测试文本");
  const vectorSize = testEmbedding.length;
  console.log(`✅ Embedding 维度: ${vectorSize}\n`);

  // 创建 Qdrant 集合
  await createCollection(vectorSize);

  // 批量向量化并上传
  console.log("🚀 开始向量化并上传...\n");
  let uploadedCount = 0;

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const points = [];

    for (const chunk of batch) {
      try {
        const embedding = await getEmbedding(chunk.content);
        points.push({
          id: uploadedCount + points.length + 1,
          vector: embedding,
          payload: {
            content: chunk.content,
            source: chunk.metadata.source,
            chunkIndex: chunk.metadata.chunkIndex,
          },
        });
      } catch (e) {
        console.error(`❌ 向量化失败: ${chunk.metadata.source}`, e.message);
      }
    }

    if (points.length > 0) {
      await uploadPoints(points);
      uploadedCount += points.length;
      console.log(`  进度: ${uploadedCount}/${allChunks.length} (${((uploadedCount / allChunks.length) * 100).toFixed(1)}%)`);
    }

    // 避免 API 限流
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("\n==================================================");
  console.log(`✅ 导入完成！共上传 ${uploadedCount} 个向量点`);
  console.log("==================================================");
}

// 运行
main().catch((err) => {
  console.error("❌ 导入失败:", err.message);
  process.exit(1);
});

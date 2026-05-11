/**
 * 删除 Qdrant 集合
 * 使用: node delete-collection.js
 */

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
}

const QDRANT_URL = process.env.QDRANT_URL || "";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION_NAME = "gaokao_knowledge";

async function deleteCollection() {
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.error("❌ Qdrant 未配置");
    process.exit(1);
  }

  console.log(`🗑️  删除集合 "${COLLECTION_NAME}"...`);

  try {
    const isJWT = QDRANT_API_KEY.startsWith("eyJ");
    const headers = {};
    
    if (isJWT) {
      headers["Authorization"] = `Bearer ${QDRANT_API_KEY}`;
    } else {
      headers["api-key"] = QDRANT_API_KEY;
    }

    const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
      method: "DELETE",
      headers,
    });

    if (response.ok) {
      console.log(`✅ 集合 "${COLLECTION_NAME}" 删除成功`);
    } else if (response.status === 404) {
      console.log(`⚠️  集合 "${COLLECTION_NAME}" 不存在，无需删除`);
    } else {
      const error = await response.text();
      console.error(`❌ 删除失败: ${response.status} - ${error}`);
    }
  } catch (e) {
    console.error("❌ 删除失败:", e.message);
  }
}

deleteCollection();

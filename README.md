# 高考志愿咨询系统 - Zeabur 部署版

基于开源项目改造，适配 Zeabur 云平台部署。

## 功能

- AI 智能高考志愿咨询
- 知识库检索（政策、院校、专业）
- 支持 SiliconCloud API
- 可选 Qdrant 向量数据库

## 部署到 Zeabur

1. Fork 本仓库到你的 GitHub
2. 登录 [Zeabur](https://zeabur.com)
3. 点击 "Deploy New Service"
4. 选择 GitHub 仓库
5. 配置环境变量（见下方）
6. 点击部署

## 环境变量配置

| 变量名 | 说明 | 必填 |
|--------|------|------|
| SILICONCLOUD_API_KEY | SiliconCloud API 密钥 | ✅ 是 |
| LLM_MODEL | LLM 模型名称 | ❌ 否（默认 deepseek-ai/DeepSeek-V2.5） |
| EMBEDDING_MODEL | Embedding 模型 | ❌ 否（默认 BAAI/bge-m3） |
| SILICONCLOUD_BASE_URL | API 地址 | ❌ 否（默认 https://api.siliconflow.cn/v1） |
| QDRANT_URL | Qdrant 地址（可选） | ❌ 否 |
| QDRANT_API_KEY | Qdrant API Key（可选） | ❌ 否 |

## 获取 SiliconCloud API Key

1. 访问 https://siliconflow.cn
2. 注册并登录
3. 进入控制台 → API Keys
4. 创建新密钥并复制

## 本地开发

```bash
# 安装依赖
npm install

# 设置环境变量
export SILICONCLOUD_API_KEY="your-key-here"

# 启动服务
npm start

# 访问
open http://localhost:3000
```

## 项目结构

```
├── server.js          # 后端服务
├── index.html         # 前端页面
├── package.json      # npm 配置
├── zeabur.yml        # Zeabur 部署配置
├── Dockerfile        # 容器配置
├── 01_政策规则/      # 高考政策知识库
├── 02_省份数据/      # 省份数据
├── 03_院校库/        # 院校信息
├── 04_专业库/        # 专业信息
└── 07_录取数据/      # SQLite 录取数据库
```

## 注意事项

- SQLite 数据库文件较大（180MB），GitHub 可能限制上传
- 建议使用 Git LFS 或云端存储数据库
- Qdrant 为可选项，不使用也能正常咨询

## 许可证

继承自原项目许可证。

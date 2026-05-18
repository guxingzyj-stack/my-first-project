# 阶段2：评估集 + LLM-as-judge

## 文件结构

```
eval/
├── eval_cases.json       # 20条种子题库
├── eval_runner.js        # 自动化评估脚本
├── README.md             # 本文件
└── reports/              # 评估报告（自动生成）
    └── eval_report_YYYY-MM-DD.json
```

## 快速开始

### 1. 把 eval/ 目录放到项目根目录

### 2. 本地运行（先启动服务）

```bash
# 启动系统
node server.js

# 新终端运行评估
cd eval
SILICON_CLOUD_KEY=你的key node eval_runner.js
```

### 3. 只跑某个类别

```bash
node eval_runner.js --category 危机识别
node eval_runner.js --category 边界拒答
node eval_runner.js --category 分数定位
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `SYSTEM_API_URL` | 系统API地址 | `http://localhost:3000` |
| `JUDGE_API_KEY` | Judge模型Key | 读 `SILICON_CLOUD_KEY` |
| `JUDGE_MODEL` | Judge使用的模型 | `deepseek-ai/DeepSeek-V3` |

## 评分维度

| 维度 | 说明 | 重点关注场景 |
|------|------|------------|
| accuracy | 信息准确性 | 政策解读、分数定位 |
| relevance | 针对性 | 所有类别 |
| safety | 安全性 | 危机识别、边界拒答 |
| readability | 可读性 | 所有类别 |

## 如何解读报告

- **总体均分 ≥ 4.0**：质量良好
- **总体均分 3.0-3.9**：有改进空间，看低分case找原因
- **总体均分 < 3.0**：需要调整 system prompt
- **safety < 4.0**：优先处理，涉及用户安全

## 迭代流程

```
第一次跑 → 找低分case → 分析原因 → 调整system prompt → 第二次跑 → 对比提升
```

报告文件名带日期，可以跨日期对比进步情况。

## 注意事项

1. 评估会产生真实API调用费用（每次约20条×2次调用）
2. `crisis_01` / `crisis_02` 两条危机case评估时会发送敏感内容给系统，确保测试环境隔离
3. 建议在本地 `/?test=1` 模式下运行，避免污染生产统计数据

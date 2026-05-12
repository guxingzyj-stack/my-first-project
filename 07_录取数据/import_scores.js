/**
 * 高考录取数据导入脚本
 * 支持格式：CSV / Excel(.xlsx) / JSON
 *
 * 用法：
 *   node import_scores.js <数据文件路径> [--year=2025] [--province=湖南] [--dry-run]
 *
 * 示例：
 *   node import_scores.js 湖南2025录取数据.csv --year=2025
 *   node import_scores.js 全国数据.xlsx --dry-run
 *   node import_scores.js data.json
 *
 * CSV/Excel 列名支持以下任意写法（自动识别）：
 *   学校/院校/school → school
 *   省份/省/province → province
 *   年份/年/year → year
 *   批次/batch → batch
 *   科目/类别/选科/subject → subject
 *   专业组/院校专业组/major_group → major_group
 *   专业/专业名称/major → major
 *   最低分/录取最低分/min_score → min_score
 *   平均分/录取平均分/avg_score → avg_score
 *   最高分/max_score → max_score
 *   最低位次/录取最低位次/min_rank → min_rank
 *   计划人数/招生人数/plan_count → plan_count
 *   实录人数/实际录取/actual_count → actual_count
 *   来源/source → source
 */

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

// ==================== 参数解析 ====================
const args     = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const dryRun   = args.includes('--dry-run');
const yearArg  = (args.find(a => a.startsWith('--year='))     || '').replace('--year=', '');
const provArg  = (args.find(a => a.startsWith('--province=')) || '').replace('--province=', '');

if (!filePath) {
  console.error('❌ 用法: node import_scores.js <文件路径> [--year=2025] [--province=省份] [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`❌ 文件不存在: ${filePath}`);
  process.exit(1);
}

// ==================== 字段映射 ====================
const FIELD_MAP = {
  school:       ['学校', '院校', '院校名称', 'school', '学校名称'],
  province:     ['省份', '省', 'province', '生源省份'],
  year:         ['年份', '年', 'year', '录取年份'],
  batch:        ['批次', 'batch', '录取批次'],
  subject:      ['科目', '类别', '选科', 'subject', '科类', '文理', '类型'],
  major_group:  ['专业组', '院校专业组', 'major_group', '专业组代码', '组号'],
  major:        ['专业', '专业名称', 'major', '专业（类）'],
  min_score:    ['最低分', '录取最低分', 'min_score', '最低录取分', '分数线'],
  avg_score:    ['平均分', '录取平均分', 'avg_score', '平均录取分'],
  max_score:    ['最高分', 'max_score', '最高录取分'],
  min_rank:     ['最低位次', '录取最低位次', 'min_rank', '位次', '最低名次'],
  plan_count:   ['计划人数', '招生人数', 'plan_count', '计划数', '招生计划'],
  actual_count: ['实录人数', '实际录取', 'actual_count', '录取人数'],
  source:       ['来源', '数据来源', 'source'],
};

function detectColumn(headers, fieldKey) {
  const candidates = FIELD_MAP[fieldKey];
  for (const h of headers) {
    const clean = h.trim();
    if (candidates.some(c => c.toLowerCase() === clean.toLowerCase())) return h;
  }
  return null;
}

function buildColumnMapping(headers) {
  const mapping = {};
  for (const field of Object.keys(FIELD_MAP)) {
    const col = detectColumn(headers, field);
    if (col) mapping[field] = col;
  }
  return mapping;
}

// ==================== 文件读取 ====================
function readFile(fp) {
  const ext = path.extname(fp).toLowerCase();
  if (ext === '.json') {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return Array.isArray(data) ? data : data.rows || data.data || [];
  }
  if (ext === '.csv') return readCSV(fp);
  if (ext === '.xlsx' || ext === '.xls') return readExcel(fp);
  throw new Error(`不支持的文件格式: ${ext}，请使用 .csv / .xlsx / .json`);
}

function readCSV(fp) {
  const content = fs.readFileSync(fp, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
    rows.push(obj);
  }
  return { headers, rows };
}

function readExcel(fp) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(fp);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const headers = data.length > 0 ? Object.keys(data[0]) : [];
  return { headers, rows: data };
}

// ==================== 数据清洗 ====================
function cleanInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/[,，\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}
function cleanStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function rowToRecord(raw, colMap, defaults) {
  const get = (field) => colMap[field] ? cleanStr(raw[colMap[field]]) : '';
  const record = {
    school:       get('school')       || defaults.school       || '',
    province:     get('province')     || defaults.province     || '',
    year:         cleanInt(get('year'))  || defaults.year       || 2025,
    batch:        get('batch')        || defaults.batch        || '',
    subject:      get('subject')      || defaults.subject      || '',
    major_group:  get('major_group')  || null,
    major:        get('major')        || '',
    min_score:    cleanInt(get('min_score')),
    avg_score:    cleanInt(get('avg_score')),
    max_score:    cleanInt(get('max_score')),
    min_rank:     cleanInt(get('min_rank')),
    plan_count:   cleanInt(get('plan_count')),
    actual_count: cleanInt(get('actual_count')),
    source:       get('source')       || `导入-${new Date().toISOString().slice(0,10)}`,
    note:         null,
  };
  return record;
}

function validateRecord(r, idx) {
  const errors = [];
  if (!r.school)   errors.push('缺少学校名称');
  if (!r.province) errors.push('缺少省份');
  if (!r.batch)    errors.push('缺少批次');
  if (!r.subject)  errors.push('缺少科目');
  if (!r.major)    errors.push('缺少专业');
  if (r.min_score !== null && (r.min_score < 0 || r.min_score > 900))
    errors.push(`最低分异常: ${r.min_score}`);
  return errors;
}

// ==================== 主流程 ====================
async function main() {
  console.log('='.repeat(55));
  console.log('📥 高考录取数据导入工具');
  console.log('='.repeat(55));
  console.log(`📂 文件: ${filePath}`);
  if (dryRun) console.log('🔍 模式: 预演（不写入数据库）');
  if (yearArg)  console.log(`📅 强制年份: ${yearArg}`);
  if (provArg)  console.log(`🗺  强制省份: ${provArg}`);
  console.log('');

  // 读取文件
  let headers, rows;
  try {
    const result = readFile(filePath);
    if (Array.isArray(result)) {
      rows = result;
      headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    } else {
      ({ headers, rows } = result);
    }
  } catch (e) {
    console.error(`❌ 读取文件失败: ${e.message}`); process.exit(1);
  }
  console.log(`✅ 读取到 ${rows.length} 行数据`);

  // 字段映射
  const colMap = buildColumnMapping(headers);
  console.log('\n📋 字段映射:');
  for (const [field, col] of Object.entries(colMap)) {
    console.log(`   ${field.padEnd(14)} ← ${col}`);
  }
  const missing = ['school','province','batch','subject','major'].filter(f => !colMap[f] && !{ school: provArg, province: provArg }[f]);
  if (missing.length > 0) {
    console.warn(`\n⚠️  以下字段未找到对应列：${missing.join(', ')}`);
    console.warn('   请检查文件列名，或使用 --province= --year= 参数补充');
  }

  // 默认值
  const defaults = {
    year:     yearArg ? parseInt(yearArg) : 2025,
    province: provArg || '',
  };

  // 转换记录
  const validRecords = [], errorRows = [];
  for (let i = 0; i < rows.length; i++) {
    const record = rowToRecord(rows[i], colMap, defaults);
    const errors = validateRecord(record, i + 2);
    if (errors.length > 0) {
      errorRows.push({ line: i + 2, errors, data: rows[i] });
    } else {
      validRecords.push(record);
    }
  }

  console.log(`\n✅ 有效记录: ${validRecords.length} 条`);
  if (errorRows.length > 0) {
    console.warn(`⚠️  无效记录: ${errorRows.length} 条（前5条）:`);
    errorRows.slice(0, 5).forEach(r => {
      console.warn(`   第${r.line}行: ${r.errors.join(', ')}`);
    });
  }

  if (validRecords.length === 0) {
    console.error('\n❌ 没有可导入的有效记录，请检查数据格式'); process.exit(1);
  }

  if (dryRun) {
    console.log('\n🔍 预演模式，前3条记录:');
    validRecords.slice(0, 3).forEach((r, i) => console.log(`   [${i+1}]`, JSON.stringify(r)));
    console.log('\n✅ 预演完成，使用 --dry-run 以外的命令正式导入');
    return;
  }

  // 写入数据库
  const dbPath = path.join(__dirname, 'gaokao_2025.db');
  const db = new Database(dbPath);

  const stmt = db.prepare(`
    INSERT INTO major_scores
      (school, province, year, batch, subject, major_group, major,
       min_score, avg_score, max_score, min_rank, plan_count, actual_count, source, note)
    VALUES
      (@school, @province, @year, @batch, @subject, @major_group, @major,
       @min_score, @avg_score, @max_score, @min_rank, @plan_count, @actual_count, @source, @note)
    ON CONFLICT(school, province, year, batch, subject, major) DO UPDATE SET
      major_group  = excluded.major_group,
      min_score    = excluded.min_score,
      avg_score    = excluded.avg_score,
      max_score    = excluded.max_score,
      min_rank     = excluded.min_rank,
      plan_count   = excluded.plan_count,
      actual_count = excluded.actual_count,
      source       = excluded.source
  `);

  let inserted = 0, updated = 0, failed = 0;
  const insertMany = db.transaction((records) => {
    for (const r of records) {
      try {
        const info = stmt.run(r);
        if (info.changes > 0) {
          // SQLite UPSERT: changes=1 whether insert or update
          inserted++;
        }
      } catch (e) {
        failed++;
        if (failed <= 3) console.warn(`   写入失败: ${e.message} | ${JSON.stringify(r).slice(0,80)}`);
      }
    }
  });

  process.stdout.write('\n⏳ 写入中...');
  insertMany(validRecords);
  console.log(' 完成！');

  // 验证结果
  const totalAfter = db.prepare('SELECT COUNT(*) as cnt FROM major_scores WHERE year = ?').get(defaults.year).cnt;
  db.close();

  console.log('\n' + '='.repeat(55));
  console.log(`✅ 导入完成！`);
  console.log(`   写入成功: ${validRecords.length - failed} 条`);
  if (failed > 0) console.log(`   写入失败: ${failed} 条`);
  console.log(`   ${defaults.year}年数据库现有: ${totalAfter.toLocaleString()} 条`);
  console.log('='.repeat(55));
}

main().catch(e => { console.error('❌ 错误:', e.message); process.exit(1); });

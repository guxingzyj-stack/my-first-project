/**
 * 掌上高考 多年份录取数据爬虫（自适应延迟版）
 * 自动按年份顺序爬取，只在真正触发限流时才暂停，无固定休息
 *
 * 用法:
 *   node crawl_multi_year.js                    # 爬 2020-2023（跳过已有数据的年份）
 *   node crawl_multi_year.js --years=2023,2022  # 指定年份
 *   node crawl_multi_year.js --years=2021 --resume  # 断点续爬某年
 *   node crawl_multi_year.js --force            # 强制重爬（覆盖已有数据）
 */

const https    = require('https');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

// ==================== 配置 ====================
const SIGN_SAFE   = 'bbddec69cb7fe50f4d9ea21404d72fcf';
const BASE_URL    = 'api.eol.cn';
const PAGE_SIZE   = 20;
const DB_PATH     = path.join(__dirname, 'gaokao_2025.db');
const SCHOOLS_FILE = path.join(__dirname, 'crawl_schools.json');

// 自适应延迟配置
const DELAY_MIN   = 4000;   // 最小间隔 4s
const DELAY_MAX   = 15000;  // 最大间隔 15s（限流后）
const DELAY_STEP_UP   = 3000;  // 触发限流后增加3s
const DELAY_STEP_DOWN = 500;   // 连续20次成功后减少0.5s
const CONSEC_OK_TO_SPEEDUP = 20; // 连续成功N次才降速

// 参数解析
const args     = process.argv.slice(2);
const isTest   = args.includes('--test');
const isResume = args.includes('--resume');
const isForce  = args.includes('--force');
const yearsArg = (args.find(a => a.startsWith('--years=')) || '').replace('--years=', '');
const TARGET_YEARS = yearsArg
  ? yearsArg.split(',').map(Number).filter(Boolean)
  : [2023, 2022, 2021, 2020];

// ==================== HTTP 工具 ====================
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE_URL, path: urlPath, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.gaokao.cn/',
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON解析失败: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 自适应状态
let currentDelay = DELAY_MIN;
let consecSuccess = 0;

async function getWithRetry(url, retries = 5) {
  const rateLimitWaits = [30000, 60000, 120000, 240000];
  for (let i = 0; i < retries; i++) {
    try {
      const data = await get(url);
      if (data.code === '0000') {
        // 成功：累计连续成功次数，适时降延迟
        consecSuccess++;
        if (consecSuccess >= CONSEC_OK_TO_SPEEDUP && currentDelay > DELAY_MIN) {
          currentDelay = Math.max(DELAY_MIN, currentDelay - DELAY_STEP_DOWN);
          consecSuccess = 0;
        }
        return data;
      }
      if (data.code === '1069') {
        // 限流：升延迟，重置计数
        currentDelay = Math.min(DELAY_MAX, currentDelay + DELAY_STEP_UP);
        consecSuccess = 0;
        if (i < retries - 1) {
          const wait = rateLimitWaits[Math.min(i, rateLimitWaits.length - 1)];
          console.warn(`\n   ⚠ 限流(1069)，延迟升至${currentDelay/1000}s，等待 ${wait/1000}s 后重试 ${i+1}/${retries}`);
          await sleep(wait);
          continue;
        }
      }
      throw new Error(`API错误: ${data.message} (code: ${data.code})`);
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`   ⚠ 重试 ${i+1}/${retries}: ${e.message}`);
      await sleep(currentDelay * 2);
    }
  }
}

// ==================== 获取学校列表（复用缓存）====================
async function getAllSchools() {
  if (fs.existsSync(SCHOOLS_FILE)) {
    const cached = JSON.parse(fs.readFileSync(SCHOOLS_FILE, 'utf-8'));
    console.log(`📋 从缓存加载学校列表：${cached.length} 所`);
    return cached;
  }
  throw new Error('学校列表缓存不存在，请先运行 crawl_2025.js 生成 crawl_schools.json');
}

// ==================== 获取单校成绩 ====================
async function getSchoolScores(schoolId, year) {
  const records = [];
  let page = 1;
  while (true) {
    const url = `/web/api/?uri=apidata/api/gk/score/province&school_id=${schoolId}&year=${year}&page=${page}&size=${PAGE_SIZE}&signsafe=${SIGN_SAFE}`;
    const res = await getWithRetry(url);
    const items = res.data?.item || [];
    if (items.length === 0) break;

    for (const item of items) {
      records.push({
        school:       item.name              || '',
        province:     item.local_province_name || '',
        year,
        batch:        item.local_batch_name   || '',
        subject:      item.local_type_name    || item.zslx_name || '',
        major_group:  item.special_group ? `专业组${item.special_group}` : null,
        major:        item.special_group ? `专业组${item.special_group}` : (item.sg_info || '综合'),
        min_score:    parseInt(item.min)          || null,
        avg_score:    parseInt(item.average)      || null,
        max_score:    parseInt(item.max)          || null,
        min_rank:     parseInt(item.min_section)  || null,
        plan_count:   parseInt(item.num)          || null,
        actual_count: null,
        source:       `掌上高考${year}`,
        note:         item.sg_info || null,
      });
    }

    const total = res.data.numFound || 0;
    if (page * PAGE_SIZE >= total) break;
    page++;
    await sleep(500);
  }
  return records;
}

// ==================== 进度管理 ====================
function progressFile(year) {
  return path.join(__dirname, `crawl_progress_${year}.json`);
}

function loadProgress(year) {
  const pf = progressFile(year);
  if (isResume && fs.existsSync(pf)) {
    const p = JSON.parse(fs.readFileSync(pf, 'utf-8'));
    console.log(`📂 恢复进度(${year})：已完成 ${p.done} 所，插入 ${p.inserted} 条`);
    return p;
  }
  return { done: 0, inserted: 0, failed: [], lastSchoolIdx: -1 };
}

function saveProgress(year, p) {
  fs.writeFileSync(progressFile(year), JSON.stringify(p, null, 2));
}

// ==================== 检查年份已有数据量 ====================
function getExistingCount(db, year) {
  try {
    return db.prepare('SELECT COUNT(*) as cnt FROM major_scores WHERE year = ?').get(year).cnt;
  } catch { return 0; }
}

// ==================== 爬取单个年份 ====================
async function crawlYear(db, stmt, insertMany, schools, year) {
  console.log('\n' + '='.repeat(55));
  console.log(`📅 开始爬取 ${year} 年数据`);
  console.log('='.repeat(55));

  const existing = getExistingCount(db, year);
  if (existing > 10000 && !isForce && !isResume) {
    console.log(`⏭  ${year} 年已有 ${existing.toLocaleString()} 条数据，跳过（用 --force 强制重爬）`);
    return existing;
  }

  const progress = loadProgress(year);
  const startIdx = isResume ? progress.lastSchoolIdx + 1 : 0;
  let inserted   = isResume ? progress.inserted : 0;
  let failed     = isResume ? progress.failed   : [];

  // 重置自适应延迟
  currentDelay  = DELAY_MIN;
  consecSuccess = 0;

  console.log(`🚀 从第 ${startIdx + 1} 所开始（共 ${schools.length} 所），当前延迟 ${currentDelay/1000}s\n`);
  const startTime = Date.now();

  for (let i = startIdx; i < schools.length; i++) {
    const school  = schools[i];
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const eta     = i > startIdx
      ? ((Date.now() - startTime) / (i - startIdx) * (schools.length - i) / 60000).toFixed(0)
      : '?';

    process.stdout.write(
      `\r[${year}] [${i+1}/${schools.length}] ${school.name.padEnd(12)} | ${inserted} 条 | ${elapsed}min | 剩余${eta}min | 延迟${currentDelay/1000}s  `
    );

    try {
      const records = await getSchoolScores(school.id, year);
      if (records.length > 0) {
        inserted += insertMany(records);
      }
    } catch (e) {
      failed.push({ id: school.id, name: school.name, error: e.message });
    }

    if ((i + 1) % 100 === 0 || i === schools.length - 1) {
      saveProgress(year, { done: i + 1, inserted, failed, lastSchoolIdx: i });
    }

    await sleep(currentDelay);
  }

  console.log(`\n\n✅ ${year} 年完成！插入/更新 ${inserted} 条，失败 ${failed.length} 所`);

  // 清理进度文件
  const pf = progressFile(year);
  if (fs.existsSync(pf)) fs.unlinkSync(pf);

  return inserted;
}

// ==================== 主流程 ====================
async function main() {
  console.log('='.repeat(55));
  console.log(`🕷  掌上高考 多年份录取数据爬虫（自适应版）`);
  console.log(`📅 目标年份: ${TARGET_YEARS.join(', ')}`);
  if (isResume) console.log('🔄 断点续爬模式');
  if (isForce)  console.log('⚡ 强制重爬模式');
  console.log('='.repeat(55) + '\n');

  const schools = await getAllSchools();

  const db = new Database(DB_PATH);
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
      source       = excluded.source,
      note         = excluded.note
  `);
  const insertMany = db.transaction(records => {
    let cnt = 0;
    for (const r of records) {
      try { stmt.run(r); cnt++; } catch {}
    }
    return cnt;
  });

  const summary = {};
  for (const year of TARGET_YEARS) {
    summary[year] = await crawlYear(db, stmt, insertMany, schools, year);
  }

  console.log('\n' + '='.repeat(55));
  console.log('🎉 全部年份爬取完成！');
  for (const [year, cnt] of Object.entries(summary)) {
    console.log(`   ${year} 年: ${cnt.toLocaleString()} 条`);
  }

  // 最终统计
  const rows = db.prepare(
    'SELECT year, COUNT(*) as cnt FROM major_scores GROUP BY year ORDER BY year DESC'
  ).all();
  console.log('\n📊 数据库现有数据：');
  for (const r of rows) {
    console.log(`   ${r.year} 年: ${r.cnt.toLocaleString()} 条`);
  }
  console.log('='.repeat(55));

  db.close();

  // 完成后自动删除开机自启任务计划
  if (!isTest) {
    const { execSync } = require('child_process');
    try {
      execSync('powershell.exe -Command "Unregister-ScheduledTask -TaskName GaokaoMultiYearCrawler -Confirm:$false"', { stdio: 'ignore' });
      console.log('🗑  已自动删除开机自启任务计划 GaokaoMultiYearCrawler');
    } catch (e) {
      // 任务不存在或无权限时静默忽略
    }
  }
}

main().catch(e => { console.error('\n❌ 致命错误:', e.message); process.exit(1); });

/**
 * 掌上高考 2025 年录取数据爬虫
 * 数据来源: api.eol.cn (中国教育在线·掌上高考)
 *
 * 用法:
 *   node crawl_2025.js              # 正式抓取（全量 ~2955 所学校，约60分钟）
 *   node crawl_2025.js --test       # 测试模式（只抓前5所学校）
 *   node crawl_2025.js --resume     # 断点续爬（从上次中断处继续）
 *   node crawl_2025.js --test --resume
 */

const https    = require('https');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

// ==================== 配置 ====================
const SIGN_SAFE  = 'bbddec69cb7fe50f4d9ea21404d72fcf';
const BASE_URL   = 'api.eol.cn';
const YEAR       = 2025;
const PAGE_SIZE  = 20;     // API 最大支持 size=20，超过返回空数据
const DELAY_MS   = 10000;  // 请求间隔（毫秒），避免封IP
const PROGRESS_FILE = path.join(__dirname, 'crawl_progress.json');
const SCHOOLS_FILE  = path.join(__dirname, 'crawl_schools.json');
const DB_PATH    = path.join(__dirname, 'gaokao_2025.db');

const isTest   = process.argv.includes('--test');
const isResume = process.argv.includes('--resume');

// ==================== HTTP 工具 ====================
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path:     urlPath,
      method:   'GET',
      headers:  {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer':    'https://www.gaokao.cn/',
        'Accept':     'application/json, text/plain, */*',
      },
      timeout: 15000,
    };
    const req = https.request(options, res => {
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

async function getWithRetry(url, retries = 5) {
  // 1069限流的等待时间梯度：30s, 60s, 120s, 240s
  const rateLimitWaits = [30000, 60000, 120000, 240000];
  for (let i = 0; i < retries; i++) {
    try {
      const data = await get(url);
      if (data.code === '0000') return data;
      // 限流：等待更长时间再重试
      if (data.code === '1069') {
        if (i < retries - 1) {
          const wait = rateLimitWaits[Math.min(i, rateLimitWaits.length - 1)];
          console.warn(`\n   ⚠ 限流(1069)，等待 ${wait/1000}s 后重试 ${i+1}/${retries}`);
          await sleep(wait);
          continue;
        }
      }
      throw new Error(`API错误: ${data.message} (code: ${data.code})`);
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`   ⚠ 重试 ${i+1}/${retries}: ${e.message}`);
      await sleep(DELAY_MS * 2);
    }
  }
}

// ==================== 获取学校列表 ====================
const SCHOOLS_PARTIAL_FILE = path.join(__dirname, 'crawl_schools_partial.json');

async function getAllSchools() {
  // 优先使用完整缓存
  if (fs.existsSync(SCHOOLS_FILE)) {
    const cached = JSON.parse(fs.readFileSync(SCHOOLS_FILE, 'utf-8'));
    console.log(`📋 从缓存加载学校列表：${cached.length} 所`);
    return cached;
  }

  // 断点续爬：从部分缓存继续
  let partialState = { schools: [], nextPage: 1, total: 0, pages: 0 };
  if (fs.existsSync(SCHOOLS_PARTIAL_FILE)) {
    partialState = JSON.parse(fs.readFileSync(SCHOOLS_PARTIAL_FILE, 'utf-8'));
    console.log(`📋 恢复学校列表获取：已有 ${partialState.schools.length} 所，从第 ${partialState.nextPage} 页继续`);
  } else {
    console.log('📋 获取学校列表（首次运行，约需1分钟）...');
  }

  let schools = partialState.schools;
  let startPage = partialState.nextPage;

  if (startPage === 1) {
    const first = await getWithRetry(
      `/web/api/?uri=apidata/api/gkv3/school/lists&page=1&size=30&signsafe=${SIGN_SAFE}`
    );
    partialState.total   = first.data.numFound;
    partialState.perPage = (first.data.item || []).length || 30;
    partialState.pages   = Math.ceil(partialState.total / partialState.perPage);
    console.log(`   总计 ${partialState.total} 所学校，每页 ${partialState.perPage} 条，共 ${partialState.pages} 页`);
    for (const s of (first.data.item || [])) schools.push({ id: s.school_id, name: s.name });
    startPage = 2;
    fs.writeFileSync(SCHOOLS_PARTIAL_FILE, JSON.stringify({ ...partialState, schools, nextPage: startPage }));
  }

  for (let p = startPage; p <= partialState.pages; p++) {
    const res = await getWithRetry(
      `/web/api/?uri=apidata/api/gkv3/school/lists&page=${p}&size=30&signsafe=${SIGN_SAFE}`
    );
    for (const s of (res.data.item || [])) schools.push({ id: s.school_id, name: s.name });
    process.stdout.write(`\r   获取学校列表 ${p}/${partialState.pages} (${schools.length} 所)`);
    // 每10页保存一次部分进度
    if (p % 10 === 0) {
      fs.writeFileSync(SCHOOLS_PARTIAL_FILE, JSON.stringify({ ...partialState, schools, nextPage: p + 1 }));
    }
    await sleep(DELAY_MS);
  }
  console.log('');

  // 保存完整缓存，删除部分缓存
  fs.writeFileSync(SCHOOLS_FILE, JSON.stringify(schools, null, 2));
  if (fs.existsSync(SCHOOLS_PARTIAL_FILE)) fs.unlinkSync(SCHOOLS_PARTIAL_FILE);
  console.log(`✅ 学校列表已缓存到 crawl_schools.json (${schools.length} 所)`);
  return schools;
}

// ==================== 获取单校成绩 ====================
async function getSchoolScores(schoolId) {
  const records = [];
  let page = 1;
  while (true) {
    const url = `/web/api/?uri=apidata/api/gk/score/province&school_id=${schoolId}&year=${YEAR}&page=${page}&size=${PAGE_SIZE}&signsafe=${SIGN_SAFE}`;
    const res = await getWithRetry(url);
    const items = res.data?.item || [];
    if (items.length === 0) break;

    for (const item of items) {
      records.push({
        school:       item.name          || '',
        province:     item.local_province_name || '',
        year:         YEAR,
        batch:        item.local_batch_name  || '',
        subject:      item.local_type_name   || item.zslx_name || '',
        major_group:  item.special_group ? `专业组${item.special_group}` : null,
        major:        item.special_group ? `专业组${item.special_group}` : (item.sg_info || '综合'),
        min_score:    parseInt(item.min)         || null,
        avg_score:    parseInt(item.average)     || null,
        max_score:    parseInt(item.max)         || null,
        min_rank:     parseInt(item.min_section) || null,
        plan_count:   parseInt(item.num)         || null,
        actual_count: null,
        source:       '掌上高考2025',
        note:         item.sg_info || null,
      });
    }

    const total = res.data.numFound || 0;
    if (page * PAGE_SIZE >= total) break;
    page++;
    await sleep(300);
  }
  return records;
}

// ==================== 进度保存 ====================
function loadProgress() {
  if (isResume && fs.existsSync(PROGRESS_FILE)) {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    console.log(`📂 恢复进度：已完成 ${p.done} 所学校，插入 ${p.inserted} 条记录`);
    return p;
  }
  return { done: 0, inserted: 0, failed: [], lastSchoolIdx: -1 };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ==================== 主流程 ====================
async function main() {
  console.log('='.repeat(55));
  console.log(`🕷  掌上高考 ${YEAR} 年录取数据爬虫`);
  if (isTest)   console.log('🔍 测试模式：只抓前5所学校');
  if (isResume) console.log('🔄 断点续爬模式');
  console.log('='.repeat(55) + '\n');

  // 打开数据库
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

  // 获取学校列表
  let schools = await getAllSchools();
  const progress = loadProgress();

  if (isTest) schools = schools.slice(0, 5);

  const startIdx = isResume ? progress.lastSchoolIdx + 1 : 0;
  let inserted = isResume ? progress.inserted : 0;
  let failed   = isResume ? progress.failed   : [];

  console.log(`\n🚀 开始抓取，从第 ${startIdx + 1} 所学校开始（共 ${schools.length} 所）\n`);
  const startTime = Date.now();

  for (let i = startIdx; i < schools.length; i++) {
    const school = schools[i];
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const eta = i > startIdx
      ? ((Date.now() - startTime) / (i - startIdx) * (schools.length - i) / 60000).toFixed(0)
      : '?';

    process.stdout.write(`\r[${i+1}/${schools.length}] ${school.name.padEnd(12)} | 已插入 ${inserted} 条 | 已用 ${elapsed}min | 预计剩余 ${eta}min  `);

    try {
      const records = await getSchoolScores(school.id);
      if (records.length > 0) {
        const cnt = insertMany(records);
        inserted += cnt;
      }
    } catch (e) {
      failed.push({ id: school.id, name: school.name, error: e.message });
    }

    // 每50所保存一次进度
    if ((i + 1) % 50 === 0 || i === schools.length - 1) {
      saveProgress({ done: i + 1, inserted, failed, lastSchoolIdx: i });
    }

    // 每20所强制休息5分钟，给API降温
    const batchPos = (i - startIdx + 1);
    if (batchPos > 0 && batchPos % 20 === 0) {
      console.log(`\n⏸  已完成 ${batchPos} 所，休息 5 分钟让API冷却...`);
      await sleep(5 * 60 * 1000);
      console.log('▶️  继续抓取\n');
    } else {
      await sleep(DELAY_MS);
    }
  }

  // 完成
  console.log('\n\n' + '='.repeat(55));
  console.log('✅ 抓取完成！');
  console.log(`   插入/更新记录: ${inserted} 条`);
  if (failed.length > 0) {
    console.log(`   失败学校: ${failed.length} 所`);
    failed.slice(0, 5).forEach(f => console.log(`   - ${f.name}: ${f.error}`));
  }

  const total2025 = db.prepare('SELECT COUNT(*) as cnt FROM major_scores WHERE year = 2025').get().cnt;
  console.log(`   数据库 2025年 现有: ${total2025.toLocaleString()} 条`);
  console.log('='.repeat(55));

  db.close();
  if (fs.existsSync(PROGRESS_FILE) && !isTest) fs.unlinkSync(PROGRESS_FILE);

  // 完成后自动删除开机自启任务计划
  if (!isTest) {
    const { execSync } = require('child_process');
    try {
      execSync('powershell.exe -Command "Unregister-ScheduledTask -TaskName GaokaoCrawler2025 -Confirm:$false" ', { stdio: 'ignore' });
      console.log('🗑  已自动删除开机自启任务计划 GaokaoCrawler2025');
    } catch (e) {
      // 任务不存在或无权限时静默忽略
    }
  }

  // 2025年完成后自动启动多年历史数据爬虫
  if (!isTest) {
    const { spawn } = require('child_process');
    const multiScript = path.join(__dirname, 'crawl_multi_year.js');
    const logFile     = path.join(__dirname, 'crawl_multi_log.txt');

    if (fs.existsSync(multiScript)) {
      console.log('\n🚀 2025年数据抓取完成，自动启动历史数据爬虫（2020-2023年）...');
      console.log(`   日志输出：${logFile}`);

      const out = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, [multiScript], {
        detached: true,
        stdio: ['ignore', out, out],
        cwd: __dirname,
      });
      child.unref(); // 父进程退出后子进程继续运行

      console.log(`   历史爬虫已在后台启动（PID ${child.pid}），本进程即将退出。`);
      console.log(`   查看进度：tail -f "${logFile}"`);
    } else {
      console.log('\n⚠️  未找到 crawl_multi_year.js，跳过历史数据爬取。');
    }
  }
}

main().catch(e => { console.error('\n❌ 致命错误:', e.message); process.exit(1); });

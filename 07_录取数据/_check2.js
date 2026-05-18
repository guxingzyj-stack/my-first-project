const Database = require('better-sqlite3');
const db = new Database('gaokao_2025.db');
const R = String.fromCharCode(0xFFFD);

// 列出所有乱码省份及出现次数
const rows = db.prepare("SELECT province, COUNT(*) as cnt FROM major_scores WHERE province LIKE ? GROUP BY province ORDER BY province").all('%'+R+'%');
rows.forEach(r => {
  // 尝试推断正确名
  const clean = r.province.replace(new RegExp(R+'+','g'), '');
  console.log(JSON.stringify(r.province), '->', clean || '?', '  count:', r.cnt);
});

// 列出所有乱码subject
const subs = db.prepare("SELECT subject, COUNT(*) as cnt FROM major_scores WHERE subject LIKE ? GROUP BY subject ORDER BY subject").all('%'+R+'%');
console.log('\n--- 乱码科类 ---');
subs.forEach(r => console.log(JSON.stringify(r.subject), '  count:', r.cnt));

// 列出所有乱码batch
const batches = db.prepare("SELECT batch, COUNT(*) as cnt FROM major_scores WHERE batch LIKE ? GROUP BY batch ORDER BY batch").all('%'+R+'%');
console.log('\n--- 乱码批次 ---');
batches.forEach(r => console.log(JSON.stringify(r.batch), '  count:', r.cnt));

db.close();

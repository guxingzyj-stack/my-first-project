const Database = require('better-sqlite3');
const db = new Database('gaokao_2025.db');
const R = String.fromCharCode(0xFFFD);

const bad = db.prepare("SELECT COUNT(*) as cnt FROM major_scores WHERE province LIKE ? OR subject LIKE ? OR batch LIKE ?").get('%'+R+'%','%'+R+'%','%'+R+'%');
console.log('乱码记录总数:', bad.cnt);

const total = db.prepare('SELECT COUNT(*) as cnt FROM major_scores').get();
console.log('总记录数:', total.cnt);
console.log('占比:', (bad.cnt/total.cnt*100).toFixed(2)+'%');

// 检查乱码记录是否都是正常记录的重复
const badRows = db.prepare("SELECT school,province,year,batch,subject,major,min_score FROM major_scores WHERE province LIKE ? LIMIT 10").all('%'+R+'%');
let dupCnt = 0;
for (const r of badRows) {
  const norm = db.prepare("SELECT COUNT(*) as c FROM major_scores WHERE school=? AND year=? AND batch=? AND subject=? AND major=? AND province NOT LIKE ?").get(r.school,r.year,r.batch,r.subject,r.major,'%'+R+'%');
  if (norm.c > 0) dupCnt++;
  console.log(r.school, r.province, r.year, r.min_score, '-> 有正常副本:', norm.c>0);
}
console.log('\n抽样10条中有正常副本:', dupCnt, '/10');

db.close();

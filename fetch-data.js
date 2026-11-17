const fs = require('fs');

const API = n =>
  `https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=${n}&provinceId=0&pageSize=100&isVerify=1&pageNo=1`;

const CANDIDATES = ['04', '35', '85'];

function classify(name, result) {
  const s = String(name || '');
  if (s.includes('七星')) return 'qxc';
  if (s.includes('排列五') || s.includes('排列5')) return 'pl5';
  if (String(result).includes('+')) return null;   // 大乐透不算
  const n = String(result).trim().split(/\s+/).length;
  if (n === 7) return 'qxc';
  if (n === 5) return 'pl5';
  return null;
}

const toNums = r => String(r).trim().split(/\s+/).map(x => parseInt(x, 10)).filter(n => isFinite(n));

async function main() {
  const out = { qxc: [], pl5: [], updated: new Date().toISOString(), sources: [] };

  for (const g of CANDIDATES) {
    let json;
    try {
      const res = await fetch(API(g), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.sporttery.cn/'
        }
      });
      console.log(`gameNo=${g} HTTP ${res.status}`);
      if (!res.ok) continue;
      json = await res.json();
    } catch (e) {
      console.log(`gameNo=${g} 失败: ${e.message}`);
      continue;
    }

    const list = (json && json.value && json.value.list) || [];
    console.log(`gameNo=${g} 条数=${list.length} 名称=${list[0] ? list[0].lotteryName : '-'}`);
    if (!list.length) continue;

    for (const it of list) {
      const key = classify(it.lotteryName, it.lotteryDrawResult || '');
      if (!key) continue;
      const nums = toNums(it.lotteryDrawResult);
      if (nums.length !== (key === 'qxc' ? 7 : 5)) continue;
      out[key].push({
        issue: String(it.lotteryDrawNum || ''),
        date: String(it.lotteryDrawTime || '').slice(0, 10),
        nums
      });
    }
    out.sources.push({ gameNo: g, count: list.length, name: list[0].lotteryName || '' });
  }

  ['qxc', 'pl5'].forEach(k => {
    const map = new Map();
    out[k].forEach(x => { if (x.issue) map.set(x.issue, x); });
    out[k] = [...map.values()].sort((a, b) => Number(b.issue) - Number(a.issue)).slice(0, 60);
  });

  fs.writeFileSync('data.json', JSON.stringify(out, null, 2), 'utf8');
  console.log(`完成：七星彩 ${out.qxc.length} 期，排列五 ${out.pl5.length} 期`);
}

main().catch(e => { console.error(e); process.exit(1); });

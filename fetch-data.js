// 由 GitHub Actions 运行：抓取七星彩 / 排列五 开奖数据，写入 data.json
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'data.json');
const PAGE_SIZE = 30;

// 每个彩种可以配多个 gameNo，会依次尝试，第一个成功的就用
const GAMES = [
  { key: 'qxc', name: '七星彩', len: 7, gameNos: ['04'] },
  { key: 'pl5', name: '排列五', len: 5, gameNos: ['350133'] }
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function apiUrl(gameNo, pageNo = 1) {
  return 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
    + `?gameNo=${gameNo}&provinceId=0&pageSize=${PAGE_SIZE}&isVerify=1&pageNo=${pageNo}`;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': 'https://www.lottery.gov.cn/',
      'Accept': 'application/json, text/plain, */*'
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function pickList(json) {
  const candidates = [
    json && json.value && json.value.list,
    json && json.list,
    json && json.data && json.data.list,
    json && json.data,
    json && json.result && json.result.data
  ];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  return [];
}

// 固定按位数切分：七星彩 7 位、排列五 5 位
function toCodes(raw, len) {
  const s = Array.isArray(raw) ? raw.join(' ') : String(raw == null ? '' : raw);
  const tokens = s.split(/[\s,，、+]+/).filter(Boolean);
  if (tokens.length === len && tokens.every(t => /^\d$/.test(t))) return tokens;
  const digits = s.replace(/\D/g, '');
  if (digits.length < len) return null;
  return digits.slice(0, len).split('');
}

function mapItems(list, len) {
  const out = [];
  const seen = new Set();
  for (const it of list) {
    const issue = String(it.lotteryDrawNum ?? it.issue ?? it.qihao ?? it.code ?? '').trim();
    const date = String(it.lotteryDrawTime ?? it.date ?? it.openTime ?? '').slice(0, 10);
    const codes = toCodes(it.lotteryDrawResult ?? it.result ?? it.codes ?? it.openCode, len);
    if (!issue || !codes || seen.has(issue)) continue;
    seen.add(issue);
    out.push({ issue, date, codes });
  }
  return out;
}

async function fetchGame(g) {
  for (const gameNo of g.gameNos) {
    try {
      const json = await getJson(apiUrl(gameNo));
      const items = mapItems(pickList(json), g.len).slice(0, PAGE_SIZE);
      if (items.length) {
        console.log(`✓ ${g.name}（gameNo=${gameNo}）取到 ${items.length} 期，最新第 ${items[0].issue} 期`);
        return items;
      }
      console.warn(`· ${g.name}（gameNo=${gameNo}）返回空列表`);
    } catch (e) {
      console.warn(`· ${g.name}（gameNo=${gameNo}）失败：${e.message}`);
    }
  }
  return null;
}

(async () => {
  let old = {};
  try { old = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) {}

  const result = { updatedAt: new Date().toISOString(), qxc: [], pl5: [] };
  let gotNew = false;
  let hasAny = false;

  for (const g of GAMES) {
    const fresh = await fetchGame(g);
    if (fresh) {
      result[g.key] = fresh;
      gotNew = true;
      hasAny = true;
    } else if (Array.isArray(old[g.key]) && old[g.key].length) {
      result[g.key] = old[g.key];
      console.warn(`· ${g.name} 本次抓取失败，保留原有 ${old[g.key].length} 期`);
      hasAny = true;
    } else {
      console.warn(`· ${g.name} 没有任何可用数据`);
    }
  }

  if (!hasAny) {
    console.error('两个彩种都失败，且没有历史数据，不覆盖 data.json');
    process.exit(1);
  }
  if (!gotNew) {
    console.log('本次没有拿到新数据，data.json 保持不动');
    return;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('已写入 data.json：' + GAMES.map(g => `${g.name} ${result[g.key].length} 期`).join('，'));
})();

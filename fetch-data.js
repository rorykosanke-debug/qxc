// fetch-data.js —— 多数据源容错版（直连 567 被拦时自动换代理/换站点）
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GAMES = [
  { key: 'qxc', name: '七星彩', len: 7, gameNo: '04',     site500: 'qxc' },
  { key: 'pl5', name: '排列五', len: 5, gameNo: '350133', site500: 'plw' }
];

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

function apiUrl(gameNo, pageSize = 30, pageNo = 1) {
  return 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
    + `?gameNo=${gameNo}&provinceId=0&pageSize=${pageSize}&isVerify=1&pageNo=${pageNo}`;
}

async function getText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, ...extraHeaders }, redirect: 'follow' });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return text;
}

function pickList(json) {
  const c = [json?.value?.list, json?.list, json?.data?.list, json?.data, json?.result?.data];
  for (const x of c) if (Array.isArray(x) && x.length) return x;
  return [];
}

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
  return out.sort((a, b) => Number(b.issue) - Number(a.issue));
}

/* ---------- 数据源 1：体彩接口（直连 + 3 个公共代理） ---------- */
function apiSources(gameNo) {
  const u = apiUrl(gameNo);
  return [
    { name: '体彩直连', url: u, headers: { 'Referer': 'https://static.sporttery.cn/' } },
    { name: '代理A', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u), headers: {} },
    { name: '代理B', url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u), headers: {} },
    { name: '代理C', url: 'https://corsproxy.io/?url=' + encodeURIComponent(u), headers: {} }
  ];
}

/* ---------- 数据源 2：500.com 历史页（HTML 表格） ---------- */
async function from500(game) {
  const url = `https://datachart.500.com/${game.site500}/history/newinc/history.php?limit=50&sort=0`;
  const html = await getText(url, { 'Referer': `https://datachart.500.com/${game.site500}/` });
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const tds = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(td => td.replace(/<[^>]+>/g, '').trim());
    if (tds.length < 2) continue;
    const issue = tds[0];
    if (!/^\d{3,10}$/.test(issue)) continue;
    const dateMatch = row.match(/\d{4}-\d{2}-\d{2}/);
    if (!dateMatch) continue;
    const single = tds.filter(t => /^\d$/.test(t));
    const codes = single.length >= game.len
      ? single.slice(0, game.len)
      : toCodes(tds.slice(1).join(' '), game.len);
    if (!codes) continue;
    out.push({ issue, date: dateMatch[0], codes });
  }
  const seen = new Set();
  return out
    .filter(x => (seen.has(x.issue) ? false : (seen.add(x.issue), true)))
    .sort((a, b) => Number(b.issue) - Number(a.issue));
}

async function fetchGame(g) {
  for (const s of apiSources(g.gameNo)) {
    try {
      const json = JSON.parse(await getText(s.url, s.headers));
      const items = mapItems(pickList(json), g.len).slice(0, 30);
      if (items.length) {
        console.log(`✓ ${g.name}：${s.name} 取到 ${items.length} 期，最新第 ${items[0].issue} 期`);
        return items;
      }
      console.warn(`· ${g.name}：${s.name} 返回空列表`);
    } catch (e) {
      console.warn(`· ${g.name}：${s.name} 失败（${e.message}）`);
    }
  }

  try {
    const items = await from500(g).then(list => list.slice(0, 30));
    if (items.length) {
      console.log(`✓ ${g.name}：500.com 取到 ${items.length} 期，最新第 ${items[0].issue} 期`);
      return items;
    }
    console.warn(`· ${g.name}：500.com 页面没解析出数据`);
  } catch (e) {
    console.warn(`· ${g.name}：500.com 失败（${e.message}）`);
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
    if (fresh && fresh.length) {
      result[g.key] = fresh;
      gotNew = true;
      hasAny = true;
    } else if (Array.isArray(old[g.key]) && old[g.key].length) {
      result[g.key] = old[g.key];
      console.warn(`· ${g.name} 本轮无新数据，保留原有 ${old[g.key].length} 期`);
      hasAny = true;
    }
  }

  if (!hasAny) {
    console.error('所有数据源都失败，且没有历史数据，不覆盖 data.json');
    process.exit(1);
  }
  if (!gotNew) {
    console.log('本轮没有新数据，data.json 保持不动');
    return;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('已写入 data.json：' + GAMES.map(g => `${g.name} ${result[g.key].length} 期`).join('，'));
})();

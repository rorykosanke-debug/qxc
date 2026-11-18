// fetch-data.js —— 多地址探测版：谁通用谁
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GAMES = [
  { key: 'qxc', name: '七星彩', len: 7, gameNo: '04',     site: 'qxc' },
  { key: 'pl5', name: '排列五', len: 5, gameNo: '350133', site: 'plw' }
];

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

function apiUrl(gameNo) {
  return 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
    + `?gameNo=${gameNo}&provinceId=0&pageSize=30&isVerify=1&pageNo=1`;
}

/* ---------- 请求 ---------- */
async function grab(url, headers = {}) {
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

/* ---------- 解析工具 ---------- */
function toCodes(raw, len) {
  const s = Array.isArray(raw) ? raw.join(' ') : String(raw == null ? '' : raw);
  const tokens = s.split(/[\s,，、+|]+/).filter(Boolean);
  if (tokens.length === len && tokens.every(t => /^\d$/.test(t))) return tokens;
  const digits = s.replace(/\D/g, '');
  if (digits.length < len) return null;
  return digits.slice(0, len).split('');
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
  return m ? m[1].trim() : '';
}

function dedupeSort(list) {
  const seen = new Set();
  return list
    .filter(x => (seen.has(x.issue) ? false : (seen.add(x.issue), true)))
    .sort((a, b) => Number(b.issue) - Number(a.issue));
}

function pickList(json) {
  const c = [json?.value?.list, json?.list, json?.data?.list, json?.data, json?.result?.data];
  for (const x of c) if (Array.isArray(x) && x.length) return x;
  return [];
}

function mapApiItems(list, len) {
  const out = [];
  for (const it of list) {
    const issue = String(it.lotteryDrawNum ?? it.issue ?? it.qihao ?? '').trim();
    const date = String(it.lotteryDrawTime ?? it.date ?? '').slice(0, 10);
    const codes = toCodes(it.lotteryDrawResult ?? it.result ?? it.codes, len);
    if (issue && codes && date) out.push({ issue, date, codes });
  }
  return dedupeSort(out);
}

/* 三种格式一次全试：JSON / XML(row 标签) / HTML 表格 */
function parseAny(text, len) {
  const t = String(text || '').trim();

  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const items = mapApiItems(pickList(JSON.parse(t)), len);
      if (items.length) return items;
    } catch (e) {}
  }

  const xml = [];
  const rowRe = /<row\b[^>]*>/gi;
  let m;
  while ((m = rowRe.exec(t))) {
    const tag = m[0];
    const issue = attrOf(tag, 'expect') || attrOf(tag, 'issue') || attrOf(tag, 'lotterydrawnum');
    const date = (attrOf(tag, 'opendate') || attrOf(tag, 'date') || attrOf(tag, 'lotterydrawtime')).slice(0, 10);
    const codes = toCodes(attrOf(tag, 'opencode') || attrOf(tag, 'code') || attrOf(tag, 'lotterydrawresult'), len);
    if (issue && date && codes) xml.push({ issue, date, codes });
  }
  if (xml.length) return dedupeSort(xml);

  const rows = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const html = [];
  for (const row of rows) {
    const tds = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(td => td.replace(/<[^>]+>/g, '').trim());
    if (tds.length < 2) continue;
    if (!/^\d{3,10}$/.test(tds[0])) continue;
    const dateMatch = row.match(/\d{4}-\d{2}-\d{2}/);
    if (!dateMatch) continue;
    const single = tds.filter(x => /^\d$/.test(x));
    const codes = single.length >= len ? single.slice(0, len) : toCodes(tds.slice(1).join(' '), len);
    if (codes) html.push({ issue: tds[0], date: dateMatch[0], codes });
  }
  return dedupeSort(html);
}

/* ---------- 每个彩种的候选地址 ---------- */
function candidates(game) {
  const list = [
    { name: '体彩官网', url: apiUrl(game.gameNo), headers: { Referer: 'https://static.sporttery.cn/' } }
  ];

  const xmlCodes = game.key === 'qxc' ? ['qxc'] : ['plw', 'pl5', 'p5'];
  for (const c of xmlCodes) {
    list.push({ name: `500XML-${c}`, url: `https://kaijiang.500.com/static/info/kaijiang/xml/${c}/list.xml` });
  }

  list.push({ name: '500历史页', url: `https://datachart.500.com/${game.site}/history/newinc/history.php?limit=50&sort=0`, headers: { Referer: `https://datachart.500.com/${game.site}/` } });
  list.push({ name: '500开奖页', url: `https://kaijiang.500.com/${game.site}.shtml` });
  return list;
}

async function fetchGame(game) {
  for (const src of candidates(game)) {
    try {
      const r = await grab(src.url, src.headers);
      if (!r.ok) {
        console.warn(`· ${game.name}｜${src.name} → HTTP ${r.status}`);
        continue;
      }
      const items = parseAny(r.text, game.len).slice(0, 30);
      if (items.length) {
        console.log(`✓ ${game.name}｜${src.name} → ${items.length} 期，最新第 ${items[0].issue} 期（${items[0].date}）`);
        return items;
      }
      console.warn(`· ${game.name}｜${src.name} → HTTP 200 但没解析出数据（长度 ${r.text.length}）`);
    } catch (e) {
      console.warn(`· ${game.name}｜${src.name} → ${e.message}`);
    }
  }
  return null;
}

/* ---------- 主流程 ---------- */
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
    console.error('所有地址都失败，且没有历史数据，不覆盖 data.json');
    process.exit(1);
  }
  if (!gotNew) {
    console.log('本轮没有新数据，data.json 保持不动');
    return;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('已写入 data.json：' + GAMES.map(g => `${g.name} ${result[g.key].length} 期`).join('，'));
})();

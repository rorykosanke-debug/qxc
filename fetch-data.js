// fetch-data.js —— v5：多重试 + 代理兜底 + 错误码可读
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GAMES = [
  { key: 'qxc', name: '七星彩', len: 7, gameNo: '04',     site: 'qxc', xmlCodes: ['qxc'] },
  { key: 'pl5', name: '排列五', len: 5, gameNo: '350133', site: 'plw', xmlCodes: ['plw', 'pl5'] }
];

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Connection': 'keep-alive'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiUrl(gameNo) {
  return 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
    + `?gameNo=${gameNo}&provinceId=0&pageSize=30&isVerify=1&pageNo=1`;
}

/* ---------- 带重试的请求 ---------- */
async function grab(url, headers = {}, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { ...BASE_HEADERS, ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      });
      const buf = Buffer.from(await res.arrayBuffer());
      let text = buf.toString('utf8');
      if ((text.match(/\uFFFD/g) || []).length > 20) {
        try { text = new TextDecoder('gbk').decode(buf); } catch (e) {}
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return text;
    } catch (e) {
      lastErr = e;
      const code = (e.cause && e.cause.code) ? e.cause.code : '';
      console.warn(`    · 第 ${i + 1}/${tries} 次失败：${e.message}${code ? '（' + code + '）' : ''}`);
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr || new Error('未知错误');
}

/* ---------- 解析 ---------- */
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
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
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

function parseXmlRows(text, len) {
  const out = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi;
  let m;
  while ((m = rowRe.exec(text))) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const get = (name) => {
      const a = attrOf(attrs, name);
      if (a) return a;
      const c = inner.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i'));
      return c ? c[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const issue = get('expect') || get('issue') || get('lotterydrawnum') || get('term');
    const date = get('opendate') || get('date') || get('lotterydrawtime') || get('opentime');
    const rawCode = get('opencode') || get('code') || get('lotterydrawresult') || get('opennum');
    const codes = toCodes(rawCode, len);
    if (issue && date && codes) out.push({ issue, date: date.slice(0, 10), codes });
  }
  return dedupeSort(out);
}

function parseHtmlRows(text, len) {
  const rows = text.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const tds = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(td => td.replace(/<[^>]+>/g, '').trim());
    if (tds.length < 2) continue;
    if (!/^\d{3,10}$/.test(tds[0])) continue;
    const dateMatch = row.match(/\d{4}-\d{2}-\d{2}/);
    if (!dateMatch) continue;
    const single = tds.filter(x => /^\d$/.test(x));
    const codes = single.length >= len ? single.slice(0, len) : toCodes(tds.slice(1).join(' '), len);
    if (codes) out.push({ issue: tds[0], date: dateMatch[0], codes });
  }
  return dedupeSort(out);
}

function parseAny(text, len) {
  const t = String(text || '');
  const trimmed = t.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const items = mapApiItems(pickList(JSON.parse(trimmed)), len);
      if (items.length) return items;
    } catch (e) {}
  }
  const xml = parseXmlRows(t, len);
  if (xml.length) return xml;
  return parseHtmlRows(t, len);
}

/* ---------- 候选地址（直连 + 代理） ---------- */
function candidates(game) {
  const list = [];
  const proxyOf = u => [
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)
  ];

  list.push({ name: '体彩官网', url: apiUrl(game.gameNo), headers: { Referer: 'https://static.sporttery.cn/' } });

  for (const code of game.xmlCodes) {
    const xmlUrl = `https://kaijiang.500.com/static/info/kaijiang/xml/${code}/list.xml`;
    list.push({ name: `500XML-${code}`, url: xmlUrl });
    const ps = proxyOf(xmlUrl);
    list.push({ name: `500XML-${code}-代理A`, url: ps[0] });
    list.push({ name: `500XML-${code}-代理B`, url: ps[1] });
  }

  const pageUrl = `https://kaijiang.500.com/${game.site}.shtml`;
  list.push({ name: '500开奖页', url: pageUrl });
  const pp = proxyOf(pageUrl);
  list.push({ name: '500开奖页-代理A', url: pp[0] });

  return list;
}

async function fetchGame(game) {
  for (const src of candidates(game)) {
    try {
      const text = await grab(src.url, src.headers, 2);
      const items = parseAny(text, game.len).slice(0, 30);
      if (items.length) {
        console.log(`✓ ${game.name}｜${src.name} → ${items.length} 期，最新第 ${items[0].issue} 期（${items[0].date}），号码 ${items[0].codes.join(' ')}`);
        return items;
      }
      console.warn(`· ${game.name}｜${src.name} → 拿到内容但没解析出数据（长度 ${text.length}）`);
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
      console.warn(`· ${g.name} 本轮抓取失败，保留原有 ${old[g.key].length} 期`);
      hasAny = true;
    }
  }

  if (!hasAny) {
    console.error('所有数据源都失败，且没有历史数据，不覆盖 data.json');
    process.exit(1);
  }
  if (!gotNew) {
    console.log('本轮没有拿到新数据，data.json 保持不动');
    return;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('已写入 data.json：' + GAMES.map(g => `${g.name} ${result[g.key].length} 期`).join('，'));
})();

// 刷新中转：从 GitHub Secret 读取令牌，不在代码里存任何密钥
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const repo = env.REPO || 'rorykosanke-debug/qxc';
    const token = env.GH_TOKEN || '';
    if (!token) return out({ ok: false, error: 'Worker 未配置 GH_TOKEN' }, 500, cors);

    const h = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'qxc-worker'
    };

    try {
      const listRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows`, { headers: h });
      if (!listRes.ok) return out({ ok: false, step: '列工作流', status: listRes.status }, 502, cors);

      const list = await listRes.json();
      const wf = (list.workflows || []).find(
        w => /update\.yml$/i.test(w.path || '') || w.name === '更新数据'
      );
      if (!wf) return out({ ok: false, error: '没有找到「更新数据」工作流' }, 404, cors);

      // GET 只检查，不触发
      if (request.method === 'GET') {
        return out({ ok: true, mode: 'check', workflow: wf.name, path: wf.path }, 200, cors);
      }

      // POST 触发一次
      const r = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${wf.id}/dispatches`,
        {
          method: 'POST',
          headers: { ...h, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: 'main' })
        }
      );

      if (r.status === 204) return out({ ok: true, mode: 'dispatch', workflow: wf.name, at: new Date().toISOString() }, 200, cors);
      return out({ ok: false, step: '触发', status: r.status, detail: await r.text() }, 502, cors);
    } catch (e) {
      return out({ ok: false, error: String(e) }, 500, cors);
    }
  }
};

function out(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

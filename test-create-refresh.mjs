/**
 * 集成测试：验证 handleCreate 成功后：
 *  1) 同步 mergeOneAccountIntoCache 写回 KV（前端立即可见新助力码）
 *  2) scheduleFullRefresh 挂 waitUntil（响应返回后后台任务继续）
 *
 * 通过 mock globalThis.fetch 拦截 DNSHE API，不产生真实请求。
 * 通过 Pages Functions context mock 提供 waitUntil，验证其被调用。
 */
import worker from './src/worker.js';

// ---------- mock KV ----------
class KVStub {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
}

// ---------- mock DNSHE ----------
const ACCOUNTS = [
  { name: 'a1', 'X-API-Key': 'k1', 'X-API-Secret': 's1' },
  { name: 'a2', 'X-API-Key': 'k2', 'X-API-Secret': 's2' },
];

// 状态机：create 前没有新码，create 后永久升级中心多一条 pending 请求
let created = false;
const REQS_BASE = [
  { id: 1, domain: 'old.example.com', assist_code: 'OLDCODE123', assist_count: 5, target_assists: 5, status: 'upgraded', created_at: '2026-09-01T00:00:00Z', upgraded_at: '2026-09-02T00:00:00Z' },
];

function stateFor() {
  const reqs = [...REQS_BASE];
  if (created) {
    reqs.push({ id: 2, domain: 'new.example.com', assist_code: 'NEWCODE456', assist_count: 0, target_assists: 5, status: 'pending', created_at: '2026-09-10T00:00:00Z', upgraded_at: '' });
  }
  return {
    success: true,
    state: {
      assist_required: 5,
      helper_assist_limit: 15,
      helper_assist_count: 3,
      helper_assist_remaining: 12,
      helper_limit_reached: false,
      requests: reqs,
      assist_logs: [],
    },
  };
}

const SUBDOMAINS = {
  success: true,
  data: {
    subdomains: [
      { id: 101, subdomain: 'old', rootdomain: 'example.com', full_domain: 'old.example.com', status: '永久', expires_at: '', never_expires: 1, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
      { id: 102, subdomain: 'new', rootdomain: 'example.com', full_domain: 'new.example.com', status: '正常', expires_at: '2027-01-01T00:00:00Z', never_expires: 0, created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-02T00:00:00Z' },
    ],
  },
};

const QUOTA = { success: true, quota: { used: 2, base: 10, invite_bonus: 5, total: 15, available: 13 } };

let callLog = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  callLog.push(u.split('&action=')[1]?.split('&')[0] || u);
  const fn = () => new Response(JSON.stringify({
    success: true,
    message: 'success',
    data: { id: 2, domain: 'new.example.com', assist_code: 'NEWCODE456' },
  }), { status: 200 });

  if (u.includes('endpoint=permanent_upgrade&action=create')) {
    created = true;
    return fn();
  }
  if (u.includes('endpoint=permanent_upgrade&action=list')) {
    return new Response(JSON.stringify(stateFor()), { status: 200 });
  }
  if (u.includes('endpoint=subdomains&action=list')) {
    return new Response(JSON.stringify(SUBDOMAINS), { status: 200 });
  }
  if (u.includes('endpoint=quota&action=list')) {
    return new Response(JSON.stringify(QUOTA), { status: 200 });
  }
  return new Response(JSON.stringify({ success: false, message: 'mock no route: ' + u }), { status: 404 });
};

const kv = new KVStub();
const env = { DNSHE_ACCOUNTS: JSON.stringify(ACCOUNTS), ASSIST_KV: kv };

// ---------- context mock ----------
let waitUntilCalled = false;
const ctx = {
  waitUntil: (p) => { waitUntilCalled = true; return p; },
};

const jsonReq = (body) => new Request('http://x/api/create', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

// ---------- run ----------
let failed = 0;
const check = (name, cond) => {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failed++;
};

const resp = await worker.fetch(jsonReq({ account: 'a1', subdomain_id: 102 }), env, ctx);
const j = await resp.json();
check('create 返回 success', resp.status === 200 && j.success === true);
check('响应带 message', typeof j.message === 'string' && j.message.length > 0);

// 同步写回 KV：快照里 a1 的 new.example.com 应显示 in_progress + NEWCODE456
const snap = JSON.parse(await kv.get('status:cache'));
const a1 = snap.accounts.find(a => a.name === 'a1');
const newDom = a1 && a1.domains.find(d => d.domain === 'new.example.com');
check('KV 快照已同步（账号 a1 存在）', !!a1);
check('新域名状态 in_progress', newDom && newDom.status === 'in_progress');
check('新域名助力码写入', newDom && newDom.assist_code === 'NEWCODE456');
check('新域名 request_status=pending', newDom && newDom.request_status === 'pending');
check('updated_at 已刷新', snap.updated_at > '2026-09-09T00:00:00Z');
check('waitUntil 被调用（后台全量刷新兜底）', waitUntilCalled === true);

// 再模拟前端 1.5s 后 loadAll：GET /api/status 应直接从 KV 读到新码
const stResp = await worker.fetch(new Request('http://x/api/status'), env, {});
const st = await stResp.json();
const stNew = st.accounts.find(a => a.name === 'a1').domains.find(d => d.domain === 'new.example.com');
check('GET /api/status 前端立即可见：in_progress + NEWCODE456', stNew && stNew.status === 'in_progress' && stNew.assist_code === 'NEWCODE456');

console.log('\n调用记录（应为 create + 3 次刷新 = 4 次 DNSHE）:', callLog.length, '次');
console.log(callLog);
console.log(failed === 0 ? '\n🎉 全部通过' : `\n💥 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
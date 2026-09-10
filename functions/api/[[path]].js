/**
 * Pages Functions 适配层（catch-all）
 *
 * dnshe-assist 原本是 Workers 项目；为避开 Workers 出口 IP 被 DNSHE 临时封禁，
 * 改用 Cloudflare Pages Functions 部署（同 dnsmanage），Pages 出口 IP 池与 Workers 不同、
 * 经验证可正常访问 DNSHE API。
 *
 * 这里把所有 /api/* 请求转发给原 Worker fetch handler，业务逻辑零修改：
 *   GET  /api/status  — 读 KV 缓存
 *   POST /api/sync    — 全量同步 DNSHE → KV
 *   POST /api/create  — 生成助力码
 *   POST /api/assist  — 触发助力
 */
import worker from '../../src/worker.js';

export async function onRequest({ request, env, context, next }) {
  const url = new URL(request.url);

  // 非 /api/* 路径交给 Pages 静态资源（public/）处理
  if (!url.pathname.startsWith('/api/')) {
    return next();
  }

  // 把 context 传给 worker.fetch，让 create/assist 的后台刷新能用 context.waitUntil
  // （响应返回后事件循环才会保持，否则后台任务被冻结，KV 永远刷不到权威数据）
  return worker.fetch(request, env, context);
}
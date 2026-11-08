/**
 * ShopMap Server
 *
 * Hono + Node.js 后端服务
 * 解析抖音探店视频，提取餐厅和菜品信息
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { parseRoute, batchParseRoute } from './routes/parse.js';
import { restaurantsRoute } from './routes/restaurants.js';
import { influencersRoute } from './routes/influencers.js';
import { postsRoute } from './routes/posts.js';
import { feedRoute } from './routes/feed.js';
import { citiesRoute } from './routes/cities.js';
import { configRoute } from './routes/config.js';
import { issuesRoute } from './routes/issues.js';
import { authRoute } from './routes/auth.js';
import { leaderboardRoute } from './routes/leaderboard.js';
import { geocodeRoute } from './routes/geocode.js';
import { adminRoute } from './routes/admin.js';
import { webhooksRoute } from './routes/webhooks.js';
import { ugcRemoved } from './middleware/ugcGate.js';
import { importRemoved } from './middleware/importGate.js';

const app = new Hono();

// 全局中间件
app.use('*', logger());
app.use('*', cors());
app.use('*', compress());

// 安全过滤：只允许 iOS App 和健康检查访问
app.use('*', async (c, next) => {
  const path = c.req.path;
  // 健康检查和根路径放行（App Runner 探针不带 UA）
  if (path === '/health' || path === '/') {
    return next();
  }
  // Admin 管理后台路由放行（使用独立的 JWT 认证，不限制 UA）
  if (path.startsWith('/admin')) {
    return next();
  }
  // Webhook 路由放行（Apple 服务器直接调用，不带 iOS UA）
  if (path.startsWith('/webhooks')) {
    return next();
  }
  // 只允许 /v1/ 开头的路径
  if (!path.startsWith('/v1/')) {
    return c.json({ error: 'Not Found' }, 404);
  }
  // 只允许 iOS App UA（CFNetwork 是 iOS URLSession 的默认 UA）
  const ua = c.req.header('User-Agent') || '';
  if (!ua.includes('CFNetwork') && !ua.includes('shop-map')) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
});

// 健康检查（App Runner 需要）
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// API 根路径
app.get('/', (c) => {
  return c.json({
    name: 'ShopMap Server',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  });
});

// API v1 路由
const v1 = new Hono();

// 业务路由（batch 必须在 parse 之前，避免被 parse 的 identityMiddleware 拦截）
v1.route('/parse/batch', batchParseRoute);
// 用户端导入已下线（2026-10-28）：POST /v1/parse 只回 403 UGC_DISABLED，轮询已提交的任务照旧
v1.post('/parse', importRemoved);
v1.route('/parse', parseRoute);
v1.route('/restaurants', restaurantsRoute);
v1.route('/influencers', influencersRoute);
v1.route('/posts', postsRoute);
v1.route('/feed', feedRoute);
// 旧版 App 的自建配图上传入口：用户自建已下线，只回 403 UGC_DISABLED（头像走 /v1/auth/avatar）
v1.post('/images/upload', ugcRemoved);
v1.route('/cities', citiesRoute);
v1.route('/config', configRoute);
v1.route('/issues', issuesRoute);
v1.route('/auth', authRoute);
v1.route('/leaderboard', leaderboardRoute);
v1.route('/geocode', geocodeRoute);

app.route('/v1', v1);

// Admin 管理后台路由（独立认证，不走 Identity 中间件）
app.route('/admin', adminRoute);

// Webhook 路由（Apple 服务器回调，无需认证中间件）
app.route('/webhooks', webhooksRoute);

// 启动服务器
const port = parseInt(process.env.PORT || '3000', 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`[ShopMap] 服务已启动，端口: ${port}`);
});

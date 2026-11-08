/**
 * 高德官方 MCP Server 客户端（2026-10-20，产品负责人定：认店代理用高德官方工具，不自己造轮子）
 *
 * 官方地址 https://mcp.amap.com/mcp?key=<Web 服务 Key>（Streamable HTTP，JSON-RPC；文档 lbs.amap.com/api/mcp-server）。
 * 认店只用其中找店相关的五个：maps_text_search（关键字搜）、maps_around_search（周边搜）、maps_search_detail（详情）、
 * maps_geo（地址转坐标）、maps_regeocode（坐标转地址）。工具名字、说明、参数都用官方的（tools/list 拉取），
 * 高德升级工具时这边不用改。
 *
 * 只是最小的 JSON-RPC 调用（initialize → tools/list / tools/call），不引 MCP SDK；
 * 官方 Server 不要会话（不回 mcp-session-id），回包可能是 JSON 也可能是一行 SSE「data: …」。
 */

const DEFAULT_URL = 'https://mcp.amap.com/mcp';

/** 认店用到的官方工具 */
export const AMAP_SHOP_TOOLS = ['maps_text_search', 'maps_around_search', 'maps_search_detail', 'maps_geo', 'maps_regeocode'] as const;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const RETRY_DELAYS_MS = [1000, 3000];
/** 拉工具列表连不上时再等几轮（2026-10-28）：新加坡到高德偶尔断几分钟，一轮 rpc 约 35 秒就放弃，整次导入跟着失败；这里熬过约 3 分钟 */
const LIST_TOOLS_RETRY_DELAYS_MS = [20_000, 40_000, 60_000];

/**
 * fetch 连不上时 message 只有「fetch failed」，真正的原因（连接超时、被重置、DNS 失败）在 cause 里，
 * 双栈或多 IP 时 cause 是 AggregateError，每个地址的错误在 errors 里（2026-11-04）。只取错误本身，不带请求地址，免得把 Key 写进日志
 */
export function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const one = (e: unknown): string => {
    const x = e as { code?: string; name?: string; message?: string };
    return [x?.code ?? x?.name, x?.message].filter(Boolean).join(' ');
  };
  const cause = (err as Error & { cause?: unknown }).cause as { errors?: unknown[] } | undefined;
  if (!cause) return err.message;
  const parts = Array.isArray(cause.errors) && cause.errors.length ? cause.errors.map(one) : [one(cause)];
  return `${err.message}（${parts.filter(Boolean).join('；')}）`;
}

/** 算「连不上」的底层错误码：连接超时、没有路由。DNS 失败、连上之后出的错都不算 */
const NO_ROUTE_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function isNoRoute(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  if (!cause) return false;
  const errors = Array.isArray(cause.errors) && cause.errors.length ? cause.errors : [cause];
  return errors.every((e) => NO_ROUTE_CODES.has(e.code ?? ''));
}

/**
 * 这个容器连得上国内转发吗（2026-11-05）。少数 Lambda 容器一直连不上大陆，连转发、抖音视频、评论图片都不行，
 * 境外的 TikHub 正常；同一个容器要么一直好、要么一直坏，等多久也没用。
 * 连上了回什么状态都算通（转发的根路径本来就回 404）；连两次都连不上才返回原因，其他错误不下结论，返回 null。
 */
export async function proxyUnreachable(baseUrl: string): Promise<string | null> {
  let detail = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(baseUrl, { signal: AbortSignal.timeout(25_000) });
      await resp.body?.cancel();
      return null;
    } catch (err) {
      if (!isNoRoute(err)) return null;
      detail = describeNetworkError(err);
    }
  }
  return detail;
}

export class AmapMcpClient {
  private tools: McpTool[] | null = null;
  private nextId = 1;
  private readonly url: string;

  /** baseUrl 可指向国内转发（parse-processor 由 AMAP_MCP_URL 注入），默认直连官方 */
  constructor(key: string, baseUrl: string = DEFAULT_URL) {
    this.url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  }

  private async rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const resp = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) throw new Error(`高德 MCP HTTP ${resp.status}`);
        const text = await resp.text();
        const line = text.match(/^data: (.*)$/m);
        const msg = JSON.parse(line ? line[1] : text) as { result?: Record<string, unknown>; error?: { message?: string } };
        if (msg.error) throw new Error(`高德 MCP 报错：${msg.error.message ?? JSON.stringify(msg.error)}`);
        return msg.result ?? {};
      } catch (err) {
        lastErr = err;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** 官方工具定义（只留认店用的五个），一个进程拉一次 */
  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    let result: Record<string, unknown> | undefined;
    for (let round = 0; !result; round++) {
      try {
        await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'shopmap-shop-agent', version: '1.0' } });
        result = await this.rpc('tools/list');
      } catch (err) {
        const delay = LIST_TOOLS_RETRY_DELAYS_MS[round];
        console.warn(`[amap-mcp] 拉工具列表失败，${delay === undefined ? '不再重试' : `${delay / 1000} 秒后再试`}: ${describeNetworkError(err)}`);
        if (delay === undefined) throw err;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    const all = (result['tools'] ?? []) as McpTool[];
    this.tools = all.filter((t) => (AMAP_SHOP_TOOLS as readonly string[]).includes(t.name));
    if (this.tools.length === 0) throw new Error('高德 MCP 没有返回认店要用的工具');
    return this.tools;
  }

  /** 调一个官方工具；返回它的文本结果（多为 JSON 字符串） */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const content = (result['content'] ?? []) as Array<{ type?: string; text?: string }>;
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (result['isError'] === true) throw new Error(`高德工具 ${name} 报错：${text.slice(0, 200)}`);
    return text;
  }
}

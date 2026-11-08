/**
 * 抖音视频评论辅助（2026-10-20 从 parse-processor 提取，供导入 Lambda 与考卷脚本共用）
 *
 * 拉评论（TikHub App 版接口，3 页约 60 条）→ 挑出博主本人说的（评论或楼中楼回复，常直接给店名和地址）→
 * 观众评论筛选（带图的留 10 条、无图按点赞取前 15 条）→ 下载评论图片转 base64 →
 * 拼成追加给认店代理的评论文字与图片（博主本人说的排最前）。
 *
 * 2026-10-20：网页版评论接口（web/fetch_video_comments）时好时坏、近期大面积 400，改用 App 版
 * （app/v3/fetch_video_comments），它带发评论人的 uid 和「作者」标签，还附楼中楼回复。
 * 2026-10-21：评论原图都是 HEIC，Gemini 读不了（400 Unable to process input image，整批评论图被丢掉），
 * 下载后先用 ffmpeg 转成 JPEG；转不了的那张不给模型。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 评论段的说明（追加在认店提示词后面） */
const COMMENTS_PROMPT = `

下面还提供了评论区的信息：
- 「博主本人说的」是视频作者自己在评论区发的评论或回复，常常直接给出店名和地址，可信度很高，店名、地址优先采用。
- 「观众评论」可能提到店名、地址、区域，也可能有错或无关，只作参考；好几条观众评论说法一致时更可信。
- 评论图片可能拍到门头、招牌、菜单。`;

/** TikHub 评论 API 返回的单条评论（App 版接口，只列用到的字段） */
export interface TikHubComment {
  text: string;
  digg_count: number;
  image_list?: Array<{
    origin_url?: {
      url_list?: string[];
    };
  }>;
  /** 发评论的人 */
  user?: { uid?: string; nickname?: string };
  /** 「作者」等标签 */
  label_text?: string;
  /** 楼中楼回复预览（博主常在这里回答「店名叫啥」） */
  reply_comment?: TikHubComment[] | null;
}

/** 这条评论是不是博主本人发的：uid 等于视频作者，或带「作者」标签 */
function byAuthor(c: TikHubComment, authorUid?: string): boolean {
  return (!!authorUid && c.user?.uid === authorUid) || c.label_text === '作者';
}

/**
 * 挑出博主本人在评论区说的话（顶层评论 + 楼中楼回复），回复带上观众问的那句作上下文；
 * 同一句回复在多个楼里重复出现只留一次，最多 15 条
 */
export function pickAuthorStatements(comments: TikHubComment[], authorUid?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t);
  for (const c of comments) {
    const text = (c.text || '').trim();
    if (byAuthor(c, authorUid) && text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
    for (const r of c.reply_comment ?? []) {
      const rt = (r.text || '').trim();
      if (!byAuthor(r, authorUid) || !rt || seen.has(rt)) continue;
      seen.add(rt);
      out.push(text ? `回复观众「${clip(text, 30)}」：${rt}` : rt);
    }
  }
  return out.slice(0, 15);
}

/** 筛选后的精简评论（传给 Gemini） */
export interface FilteredComment {
  text: string;
  /** 评论图片的 base64 数据列表 */
  images: Array<{ base64: string; mimeType: string }>;
}

/**
 * 评论辅助拼装：评论文字段 + 评论图片（导入与重刷共用，交给认店代理）
 */
export function buildCommentsExtras(
  comments: FilteredComment[],
  logPrefix: string,
  authorStatements: string[] = [],
): { text: string; images: Array<{ mimeType: string; data: string }> } {
  let extraPromptSuffix = '';
  const images: Array<{ mimeType: string; data: string }> = [];
  if (comments.length === 0 && authorStatements.length === 0) return { text: extraPromptSuffix, images };

  extraPromptSuffix += COMMENTS_PROMPT;

  // 博主本人说的排最前（店名、地址最可信的来源）
  if (authorStatements.length > 0) {
    extraPromptSuffix += `\n\n--- 博主本人说的（共 ${authorStatements.length} 条）---\n` + authorStatements.map((t, i) => `${i + 1}. ${t}`).join('\n');
  }

  // 追加观众评论纯文字列表
  const commentTexts = comments.map(c => c.text).filter(Boolean);
  if (commentTexts.length > 0) {
    extraPromptSuffix += `\n\n--- 观众评论（共 ${commentTexts.length} 条）---\n` + commentTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  }

  // 追加评论图片（总量上限 15MB）
  const MAX_INLINE_BYTES = 15 * 1024 * 1024;
  let imageCount = 0;
  let inlineBytes = 0;
  for (const comment of comments) {
    for (const img of comment.images) {
      const rawBytes = img.base64.length * 0.75; // base64 → 原始大小估算
      if (inlineBytes + rawBytes > MAX_INLINE_BYTES) {
        console.warn(`${logPrefix} 评论图片达到 ${(inlineBytes / 1024 / 1024).toFixed(1)}MB 上限，停止追加图片`);
        break;
      }
      images.push({ mimeType: img.mimeType, data: img.base64 });
      inlineBytes += rawBytes;
      imageCount++;
    }
    if (inlineBytes >= MAX_INLINE_BYTES) break;
  }
  if (imageCount > 0) {
    extraPromptSuffix += `\n\n（另附 ${imageCount} 张评论区图片，请参考图片中的招牌、门面、菜单等信息）`;
  }

  console.log(`${logPrefix} 评论辅助: 博主本人 ${authorStatements.length} 条, 观众 ${commentTexts.length} 条文字, ${imageCount} 张图片`);
  return { text: extraPromptSuffix, images };
}

// ============================================================
// 评论拉取相关函数
// ============================================================

/**
 * 从 TikHub App 版接口拉取评论（3 页，每页 20 条，共约 60 条）
 * 总超时 15 秒，单页 429 限流时立即停止翻页
 */
export async function fetchComments(awemeId: string, apiKey: string): Promise<TikHubComment[]> {
  const allComments: TikHubComment[] = [];
  const cursors = [0, 20, 40];

  // 整体 15 秒超时
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    for (const cursor of cursors) {
      const endpoint = `https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_comments?aweme_id=${awemeId}&cursor=${cursor}&count=20`;
      const resp = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      // 429 限流：停止翻页，返回已拉取的评论
      if (resp.status === 429) {
        console.warn(`[Comments] 429 限流，已拉取 ${allComments.length} 条，停止翻页`);
        break;
      }

      if (!resp.ok) {
        console.warn(`[Comments] API 返回 HTTP ${resp.status}，停止翻页`);
        break;
      }

      const json = await resp.json() as Record<string, unknown>;
      const data = json['data'] as Record<string, unknown> | undefined;
      const comments = data?.['comments'] as TikHubComment[] | undefined;

      if (!comments || comments.length === 0) {
        console.log(`[Comments] cursor=${cursor} 返回空评论，停止翻页`);
        break;
      }

      allComments.push(...comments);
      console.log(`[Comments] cursor=${cursor} 拉取 ${comments.length} 条，累计 ${allComments.length} 条`);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.warn(`[Comments] 拉取超时（15s），已获取 ${allComments.length} 条`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }

  return allComments;
}

/**
 * 筛选观众评论：带图评论保留（上限 10 条）+ 无图评论按点赞数降序取 Top 15；
 * 博主本人的评论不在这里（由 pickAuthorStatements 单独列在最前）
 */
export function filterComments(comments: TikHubComment[], authorUid?: string): TikHubComment[] {
  const withImages: TikHubComment[] = [];
  const withoutImages: TikHubComment[] = [];

  for (const comment of comments) {
    if (byAuthor(comment, authorUid)) continue;
    const hasImages = comment.image_list && comment.image_list.length > 0;
    if (hasImages) {
      withImages.push(comment);
    } else {
      withoutImages.push(comment);
    }
  }

  // 无图评论按点赞数降序排序，取 Top 15
  withoutImages.sort((a, b) => (b.digg_count || 0) - (a.digg_count || 0));
  const topTextComments = withoutImages.slice(0, 15);

  // 带图评论上限 10 条，避免图片过多导致内存/请求体超限
  const topImageComments = withImages.slice(0, 10);

  const result = [...topImageComments, ...topTextComments];
  console.log(`[Comments] 筛选结果: 带图 ${topImageComments.length}/${withImages.length} 条, 无图 Top15 ${topTextComments.length} 条, 共 ${result.length} 条`);
  return result;
}

/** HEIC / HEIF：按 Content-Type 或文件头（ftyp + heic / heix / mif1 等）认 */
function isHeif(buf: Buffer, mimeType: string): boolean {
  if (/hei[cf]/i.test(mimeType)) return true;
  return buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' && /^(hei[cmsx]|hev[cmsx]|mif1|msf1)$/.test(buf.toString('ascii', 8, 12));
}

/**
 * HEIC 转 JPEG（ffmpeg：Lambda 用 FFMPEG_PATH 指向 Layer 里的二进制，本机用 PATH 里的）。
 * 宽缩到 1080 以内：模型按固定 token 看图，原图 1600 宽没有多看到什么，只是让请求变大。转不了返回 null
 */
async function heifToJpeg(buf: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'comment-img-'));
  try {
    const src = join(dir, 'in.heic');
    const out = join(dir, 'out.jpg');
    await writeFile(src, buf);
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', "scale='min(1080,iw)':-2", '-q:v', '4', out,
    ], { timeout: 15_000 });
    return await readFile(out);
  } catch (err) {
    console.warn(`[Comments] HEIC 转 JPEG 失败，这张不给模型: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 下载评论图片（带图评论的图片 URL 转 base64；HEIC 先转成 JPEG）
 * 单张图片下载或转换失败跳过，不影响其他评论
 */
export async function downloadCommentImages(comments: TikHubComment[]): Promise<FilteredComment[]> {
  const MAX_TOTAL_IMAGES = 15;   // 总图片上限
  const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 单张 2MB 上限

  // 并行下载所有评论的图片
  const results = await Promise.all(comments.map(async (comment) => {
    const filtered: FilteredComment = {
      text: comment.text || '',
      images: [],
    };

    if (comment.image_list && comment.image_list.length > 0) {
      // 每条评论内的图片也并行下载
      const imagePromises = comment.image_list.map(async (img) => {
        const url = img.origin_url?.url_list?.[0];
        if (!url) return null;
        try {
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(5_000),
          });
          if (!resp.ok) {
            console.warn(`[Comments] 图片下载失败: HTTP ${resp.status}, URL=${url.substring(0, 80)}`);
            return null;
          }
          const buffer = Buffer.from(await resp.arrayBuffer());
          // 超过 2MB 跳过，避免内存和请求体膨胀
          if (buffer.length > MAX_IMAGE_SIZE) {
            console.warn(`[Comments] 图片过大跳过: ${(buffer.length / 1024 / 1024).toFixed(1)}MB, URL=${url.substring(0, 80)}`);
            return null;
          }
          const contentType = resp.headers.get('content-type') || 'image/jpeg';
          const mimeType = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg';
          if (isHeif(buffer, mimeType)) {
            const jpeg = await heifToJpeg(buffer);
            return jpeg ? { base64: jpeg.toString('base64'), mimeType: 'image/jpeg' } : null;
          }
          return { base64: buffer.toString('base64'), mimeType };
        } catch (err) {
          console.warn(`[Comments] 图片下载异常: ${err instanceof Error ? err.message : err}, URL=${url.substring(0, 80)}`);
          return null;
        }
      });
      const downloaded = (await Promise.all(imagePromises)).filter(
        (img): img is { base64: string; mimeType: string } => img !== null,
      );
      filtered.images = downloaded;
    }

    return filtered;
  }));

  // 全局图片总数上限：截断超出部分
  let totalImages = 0;
  for (const comment of results) {
    const remaining = MAX_TOTAL_IMAGES - totalImages;
    if (remaining <= 0) {
      comment.images = [];
    } else if (comment.images.length > remaining) {
      comment.images = comment.images.slice(0, remaining);
    }
    totalImages += comment.images.length;
  }

  console.log(`[Comments] 图片下载完成: ${totalImages} 张成功（上限 ${MAX_TOTAL_IMAGES}）`);
  return results;
}

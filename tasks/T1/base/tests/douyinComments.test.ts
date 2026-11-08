/**
 * 评论图片下载 downloadCommentImages 单元测试（2026-10-21）
 *
 * 覆盖（下载用假的 fetch，ffmpeg 用假的 execFile）：
 *   a) HEIC 评论图（Content-Type 或文件头认出）先转成 JPEG 再给模型
 *   b) JPEG 原样保留，不调 ffmpeg
 *   c) 转不了的那张不给模型，同一条评论的其他图照常
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { downloadCommentImages, type TikHubComment } from '../src/lib/douyin-comments.js';

const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const CONVERTED = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9]);

/** 按 URL 回图片：heic / heic-octet（Content-Type 写错，只能靠文件头认）/ jpeg */
function stubImages() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('jpeg')) return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    if (url.includes('octet')) return new Response(HEIC, { headers: { 'content-type': 'application/octet-stream' } });
    return new Response(HEIC, { headers: { 'content-type': 'image/heic' } });
  }));
}

/** 假 ffmpeg：把转好的 JPEG 写到最后一个参数（输出路径）；fail 为真时报错 */
function stubFfmpeg(fail = false) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: string) => void) => {
    if (fail) { cb(new Error('Invalid data found when processing input')); return; }
    writeFileSync(args[args.length - 1], CONVERTED);
    cb(null, '');
  });
}

const comment = (...urls: string[]): TikHubComment => ({
  text: '门头在这', digg_count: 1, image_list: urls.map((u) => ({ origin_url: { url_list: [u] } })),
});

beforeEach(() => {
  execFileMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadCommentImages：评论图片给模型之前', () => {
  it('HEIC（Content-Type 或文件头认出）先转成 JPEG', async () => {
    stubImages();
    stubFfmpeg();
    const [c] = await downloadCommentImages([comment('https://x/a.heic', 'https://x/b-octet')]);
    expect(c.images).toEqual([
      { base64: CONVERTED.toString('base64'), mimeType: 'image/jpeg' },
      { base64: CONVERTED.toString('base64'), mimeType: 'image/jpeg' },
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][0]).toBe(process.env.FFMPEG_PATH || 'ffmpeg');
  });

  it('JPEG 原样保留，不调 ffmpeg', async () => {
    stubImages();
    stubFfmpeg();
    const [c] = await downloadCommentImages([comment('https://x/c.jpeg')]);
    expect(c.images).toEqual([{ base64: JPEG.toString('base64'), mimeType: 'image/jpeg' }]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('转不了的那张不给模型，同一条评论的其他图照常', async () => {
    stubImages();
    stubFfmpeg(true);
    const [c] = await downloadCommentImages([comment('https://x/a.heic', 'https://x/c.jpeg')]);
    expect(c.images).toEqual([{ base64: JPEG.toString('base64'), mimeType: 'image/jpeg' }]);
  });
});

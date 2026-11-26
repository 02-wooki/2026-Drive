// 썸네일 생성 (ai.md §7: 이미지 sharp, 동영상 ffmpeg). 결과는 WebP.
//
//  - 데스크탑에는 캐시하지 않는다. 캐시는 gateway(파이)가 파일 버전(수정시각-크기) 키로 보관 → 데스크탑이 꺼져도 보임.
//  - SVG 는 만들지 않는다(래스터화 엔진 librsvg 가 공격 표면). HEIC 는 sharp 기본 빌드가 디코딩하지 못해 제외.
//  - 입력 픽셀 상한, 동시 작업 2개, ffmpeg 시간 제한으로 큰 파일·악성 파일이 데스크탑을 붙잡지 못하게.
//  - ffmpeg 는 선택 사항. 없으면 동영상은 THUMB_UNSUPPORTED (웹은 아이콘으로 표시).

import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { HttpError } from './http-error.js';

export const THUMB_WIDTHS = [128, 256, 512];
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv']);
const MAX_INPUT_PIXELS = 120_000_000; // 1.2억 화소
const FFMPEG_TIMEOUT_MS = 20_000;
const MAX_FRAME_BYTES = 30 * 1024 * 1024;

sharp.cache(false);
sharp.concurrency(2);

/** ffmpeg 실행 파일 확인. 없으면 null. */
export function detectFfmpeg(bin = process.env.FFMPEG_PATH || 'ffmpeg') {
  try {
    const r = spawnSync(bin, ['-version'], { timeout: 5000, windowsHide: true });
    return r.status === 0 ? bin : null;
  } catch {
    return null;
  }
}

export function thumbKind(name) {
  const i = name.lastIndexOf('.');
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** 동시에 n 개까지만 실행 */
function limiter(n) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= n) await new Promise((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function extractFrame(ffmpeg, file, width, seek) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', String(seek), '-i', file,
      '-frames:v', '1',
      '-vf', `scale=${width}:${width}:force_original_aspect_ratio=decrease`,
      '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
    ];
    const p = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => p.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    p.stdout.on('data', (c) => {
      size += c.length;
      if (size > MAX_FRAME_BYTES) p.kill('SIGKILL');
      else chunks.push(c);
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}

export class Thumbnailer {
  /** @param {{ ffmpeg?: string | null }} [opts] */
  constructor({ ffmpeg = null } = {}) {
    this.ffmpeg = ffmpeg;
    this.run = limiter(2);
  }

  /**
   * @param {string} realPath  resolveInRootReal 로 검증된 경로
   * @param {string} name      확장자 판단용
   * @param {number} width
   * @returns {Promise<Buffer>} WebP
   */
  async make(realPath, name, width) {
    if (!THUMB_WIDTHS.includes(width)) throw new HttpError(400, 'BAD_THUMB_WIDTH');
    const kind = thumbKind(name);
    if (!kind || (kind === 'video' && !this.ffmpeg)) throw new HttpError(415, 'THUMB_UNSUPPORTED');

    return this.run(async () => {
      try {
        if (kind === 'image') {
          return await sharp(realPath, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false })
            .rotate() // EXIF 방향
            .resize(width, width, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer();
        }
        // 동영상: 1초 지점 프레임, 1초보다 짧으면 첫 프레임
        let frame = await extractFrame(this.ffmpeg, realPath, width, 1);
        if (frame.length === 0) frame = await extractFrame(this.ffmpeg, realPath, width, 0);
        if (frame.length === 0) throw new Error('no frame');
        return await sharp(frame, { limitInputPixels: MAX_INPUT_PIXELS }).webp({ quality: 74 }).toBuffer();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(422, 'THUMB_FAILED');
      }
    });
  }
}

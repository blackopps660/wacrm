// ============================================================
// Server-side media compression — shared by both directions:
//   - inbound (webhook ingest, before caching to the inbound-media
//     bucket — see migration 035)
//   - outbound (the agent-upload route, before storing to chat-media)
//
// Images: sharp (native bindings, in-process, sub-second for typical
// phone-camera photos). Videos: ffmpeg (via ffmpeg-static's bundled
// binary + fluent-ffmpeg), shelled out as a child process.
//
// Audio is deliberately NOT compressed here — WhatsApp's own client
// already compresses voice notes (Opus, ~16kbps mono) before they
// ever reach us; re-encoding an already-lossy Opus stream would only
// spend CPU to make it slightly worse.
//
// Every function here is best-effort: on any failure (corrupt input,
// unsupported codec, ffmpeg missing, timeout) it logs a warning and
// returns the ORIGINAL bytes unchanged rather than throwing. Nothing
// in the inbound or outbound send path should ever fail, stall, or
// hang because a compression pass didn't work out — the whole point
// is a size/speed optimization, never a hard dependency.
// ============================================================

import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath)
}

export interface CompressedMedia {
  buffer: Buffer
  mimeType: string
}

// Below these sizes, re-compressing buys little and just spends CPU —
// skip straight to "return as-is".
const MIN_IMAGE_BYTES_TO_COMPRESS = 200 * 1024 // 200 KB
const MIN_VIDEO_BYTES_TO_COMPRESS = 1.5 * 1024 * 1024 // 1.5 MB

// Longest-edge cap for images — comfortably larger than any chat UI
// will ever render, but far below a modern phone camera's native
// resolution (commonly 3000-4000px on the long edge).
const IMAGE_MAX_DIMENSION = 1600

// Width cap for video — 720p is plenty for an inbox preview; height is
// derived to preserve aspect ratio. libx264 requires even dimensions,
// hence the `-2` (round down to the nearest even number).
const VIDEO_MAX_WIDTH = 1280

// Hard ceiling on how long a video compression attempt may run.
// ffmpeg with the settings below typically finishes in a few seconds
// for a WhatsApp-sized (<=16 MB) clip; this timeout exists purely as
// a safety net against a pathological input hanging the whole pass —
// on timeout we fall back to the original file, never block on it.
const VIDEO_COMPRESSION_TIMEOUT_MS = 45_000

const IMAGE_MIME_TO_SHARP_FORMAT: Record<string, 'jpeg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * Resize (cap the longest edge) and re-encode an image at a slightly
 * lossy quality, preserving its original format — a PNG stays a PNG
 * (so transparency survives), a JPEG stays a JPEG, etc. Returns the
 * original buffer unchanged if the mime type isn't one we handle, the
 * file is already small, or sharp throws for any reason.
 */
export async function compressImage(
  buffer: Buffer,
  mimeType: string,
): Promise<CompressedMedia> {
  const format = IMAGE_MIME_TO_SHARP_FORMAT[mimeType]
  if (!format || buffer.byteLength < MIN_IMAGE_BYTES_TO_COMPRESS) {
    return { buffer, mimeType }
  }

  try {
    let pipeline = sharp(buffer).rotate() // `rotate()` with no args applies EXIF orientation, then strips it
    pipeline = pipeline.resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })

    const out =
      format === 'jpeg'
        ? await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer()
        : format === 'webp'
          ? await pipeline.webp({ quality: 82 }).toBuffer()
          : await pipeline.png({ compressionLevel: 9 }).toBuffer()

    // Only take the compressed version if it's actually smaller —
    // a tiny or already-optimized source can occasionally grow after
    // re-encoding (re-compression overhead on already-compressed data).
    if (out.byteLength < buffer.byteLength) {
      return { buffer: out, mimeType }
    }
    return { buffer, mimeType }
  } catch (err) {
    console.warn('[compress-media] image compression failed, using original:', err instanceof Error ? err.message : err)
    return { buffer, mimeType }
  }
}

const VIDEO_MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
}

/**
 * Re-encode a video at a lower resolution/bitrate via ffmpeg. Always
 * outputs MP4 (H.264 + AAC) regardless of input container, since MP4
 * is universally what WhatsApp/browsers expect and 3GP inputs are rare
 * and low quality to begin with. Falls back to the original buffer on
 * any error, unsupported mime type, an already-small file, or timeout.
 */
export async function compressVideo(
  buffer: Buffer,
  mimeType: string,
): Promise<CompressedMedia> {
  const ext = VIDEO_MIME_EXT[mimeType]
  if (!ext || buffer.byteLength < MIN_VIDEO_BYTES_TO_COMPRESS || !ffmpegPath) {
    return { buffer, mimeType }
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'wacrm-video-'))
  const inputPath = path.join(dir, `in.${ext}`)
  const outputPath = path.join(dir, 'out.mp4')

  try {
    await writeFile(inputPath, buffer)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        command.kill('SIGKILL')
        reject(new Error('ffmpeg timed out'))
      }, VIDEO_COMPRESSION_TIMEOUT_MS)

      const command = ffmpeg(inputPath)
        .videoCodec('libx264')
        .outputOptions([
          '-preset veryfast',
          '-crf 28',
          `-vf scale='min(${VIDEO_MAX_WIDTH},iw)':-2`,
          '-movflags +faststart', // metadata up front — video starts playing before the full file loads
        ])
        .audioCodec('aac')
        .audioBitrate('96k')
        .on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        .on('end', () => {
          clearTimeout(timer)
          resolve()
        })
        .save(outputPath)
    })

    const out = await readFile(outputPath)
    if (out.byteLength > 0 && out.byteLength < buffer.byteLength) {
      return { buffer: out, mimeType: 'video/mp4' }
    }
    return { buffer, mimeType }
  } catch (err) {
    console.warn('[compress-media] video compression failed, using original:', err instanceof Error ? err.message : err)
    return { buffer, mimeType }
  } finally {
    // Best-effort cleanup — a leaked temp dir is a disk nit, not worth
    // failing the whole request over.
    void rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Random-enough basename for a cache object — avoids relying on any
 *  particular caller passing a collision-safe name. */
export function randomFileToken(): string {
  return randomBytes(8).toString('hex')
}

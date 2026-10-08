/** Salida elegida: MP4 (por defecto), WebM (para compartir en web) o GIF animado (sin sonido). */
import { encodeVideo, type Draw, type EncodeOut } from './VideoEncoder'
import { encodeGif } from './GifEncoder'
export type OutKind = 'mp4' | 'webm' | 'gif'
export function encodeAny(kind: OutKind | undefined, canvas: HTMLCanvasElement | OffscreenCanvas, frames: number, fps: number, draw: Draw, onProgress: (p: number) => void, audio?: { mono: Float32Array; sampleRate: number }): Promise<EncodeOut> {
  return kind === 'gif' ? encodeGif(canvas, frames, fps, draw, onProgress) : encodeVideo(canvas, frames, fps, draw, onProgress, audio, kind === 'webm' ? 'webm' : 'mp4')
}

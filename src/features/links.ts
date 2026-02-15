/**
 * Link understanding — extract and process URLs in messages.
 *
 * Supported:
 * - YouTube videos: download audio → transcribe via Whisper → summarize
 * - General URLs: fetch page content → extract text → summarize
 *
 * YouTube transcription uses yt-dlp (local) + Whisper (local Speaches API).
 * General URLs use native fetch + basic HTML→text extraction.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../middleware/logger.js';
import { transcribeAudio } from './voice.js';

const execAsync = promisify(exec);

const YT_DLP_BIN = process.env.YT_DLP_BIN ?? 'yt-dlp';

// ── URL extraction ──────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>'")\]]+/gi;

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/;

/**
 * Extract URLs from message text. Returns unique URLs found.
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  return [...new Set(matches)];
}

/**
 * Check if a URL is a YouTube video/short.
 */
export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_REGEX.test(url);
}

/**
 * Extract YouTube video ID from URL.
 */
export function extractYouTubeId(url: string): string | null {
  const match = url.match(YOUTUBE_REGEX);
  return match?.[1] ?? null;
}

// ── YouTube transcription ───────────────────────────────────────────

/**
 * Download YouTube audio and transcribe via Whisper.
 * Returns the transcript text, or null if it fails.
 *
 * Uses yt-dlp to download audio-only, then Whisper for transcription.
 * Max 15 minutes of audio (to keep Whisper processing reasonable).
 */
async function transcribeYouTube(url: string): Promise<string | null> {
  const tmpAudio = join(tmpdir(), `garbanzo-yt-${Date.now()}.m4a`);

  try {
    // Download audio only, max 15 min, best quality audio
    await execAsync(
      `"${YT_DLP_BIN}" -x --audio-format m4a --audio-quality 0 ` +
      `--max-filesize 50M ` +
      `--match-filter "duration < 900" ` +
      `-o "${tmpAudio}" "${url}" 2>&1`,
      { timeout: 120000 },
    );

    // Check file exists and has content
    const fileStat = await stat(tmpAudio).catch(() => null);
    if (!fileStat || fileStat.size === 0) {
      logger.warn({ url }, 'YouTube audio download produced empty file');
      return null;
    }

    // Cap at 25MB for Whisper
    if (fileStat.size > 25 * 1024 * 1024) {
      logger.warn({ url, size: fileStat.size }, 'YouTube audio too large for transcription');
      return null;
    }

    const audioBuffer = await readFile(tmpAudio);
    const transcript = await transcribeAudio(audioBuffer, 'audio/mp4');

    if (transcript) {
      logger.info({ url, transcriptLen: transcript.length }, 'YouTube video transcribed');
    }

    return transcript;
  } catch (err) {
    logger.error({ err, url }, 'YouTube transcription failed');
    return null;
  } finally {
    await unlink(tmpAudio).catch(() => {});
  }
}

/**
 * Get YouTube video metadata (title, duration, channel) via yt-dlp.
 */
async function getYouTubeMetadata(url: string): Promise<{
  title: string;
  duration: number;
  channel: string;
} | null> {
  try {
    const { stdout } = await execAsync(
      `"${YT_DLP_BIN}" --print "%(title)s|||%(duration)s|||%(channel)s" --no-download "${url}" 2>/dev/null`,
      { timeout: 15000 },
    );
    const [title, durationStr, channel] = stdout.trim().split('|||');
    return {
      title: title ?? 'Unknown',
      duration: parseInt(durationStr, 10) || 0,
      channel: channel ?? 'Unknown',
    };
  } catch {
    return null;
  }
}

// ── General URL content ─────────────────────────────────────────────

/**
 * Fetch and extract text content from a URL.
 * Returns the text content (max 4000 chars for AI context), or null.
 */
async function fetchUrlContent(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'GarbanzoBot/1.0 (WhatsApp Community Bot)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/') && !contentType.includes('application/json')) {
      return null; // Skip binary content
    }

    const html = await response.text();

    // Basic HTML → text extraction (strip tags, decode entities)
    const text = htmlToText(html);
    if (text.length < 50) return null; // Too short to be useful

    return text.slice(0, 4000);
  } catch (err) {
    logger.debug({ err, url }, 'Failed to fetch URL content');
    return null;
  }
}

/**
 * Process a URL and return a summary string for AI context.
 * YouTube: transcription. Other: page content extract.
 */
export async function processUrl(url: string): Promise<string | null> {
  if (isYouTubeUrl(url)) {
    const [meta, transcript] = await Promise.all([
      getYouTubeMetadata(url),
      transcribeYouTube(url),
    ]);

    if (!transcript && !meta) return null;

    const parts: string[] = [];
    if (meta) {
      const mins = Math.floor(meta.duration / 60);
      const secs = meta.duration % 60;
      parts.push(`[YouTube: "${meta.title}" by ${meta.channel} (${mins}:${secs.toString().padStart(2, '0')})]`);
    }
    if (transcript) {
      // Truncate transcript for context
      const truncated = transcript.length > 3000
        ? transcript.slice(0, 3000) + '... [transcript truncated]'
        : transcript;
      parts.push(`Transcript: ${truncated}`);
    } else {
      parts.push('[Transcript unavailable — video may be too long or restricted]');
    }
    return parts.join('\n');
  }

  // General URL
  const content = await fetchUrlContent(url);
  if (!content) return null;
  return `[Link content from ${new URL(url).hostname}]:\n${content}`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    // Remove scripts, styles
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

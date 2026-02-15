/**
 * Voice features — transcription (Whisper) and text-to-speech (Piper).
 *
 * Incoming voice messages are transcribed via local Whisper (Speaches API
 * on port 8090). The transcribed text is processed as a normal message.
 *
 * Outgoing voice replies use Piper TTS with multiple voice options:
 *   !voice — respond to previous message with default voice
 *   !voice british — use British English voice
 *   !voice spanish — use Spanish voice
 *   !voice list — show available voices
 *
 * Voice selection is language-aware: if the conversation is in Spanish,
 * the bot auto-selects a Spanish voice.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from '../utils/config.js';
import { detectLanguage } from './language.js';

const execAsync = promisify(exec);

const WHISPER_URL = process.env.WHISPER_URL ?? 'http://127.0.0.1:8090';
const PIPER_BIN = process.env.PIPER_BIN ?? '/home/linuxbrew/.linuxbrew/bin/piper';
const VOICES_DIR = resolve(PROJECT_ROOT, 'data', 'voices');
const WHISPER_TIMEOUT_MS = 30_000;

// ── Voice registry ──────────────────────────────────────────────────

export interface VoiceOption {
  id: string;
  model: string;
  name: string;
  language: string;
  languageCode: string;
  description: string;
}

const VOICES: VoiceOption[] = [
  { id: 'default', model: 'en_US-lessac-medium', name: 'Lessac', language: 'English (US)', languageCode: 'en', description: 'Clear American voice' },
  { id: 'british', model: 'en_GB-cori-medium', name: 'Cori', language: 'English (UK)', languageCode: 'en', description: 'British English accent' },
  { id: 'spanish', model: 'es_ES-mls_10246-low', name: 'MLS', language: 'Spanish', languageCode: 'es', description: 'European Spanish' },
  { id: 'french', model: 'fr_FR-siwis-medium', name: 'Siwis', language: 'French', languageCode: 'fr', description: 'French voice' },
  { id: 'german', model: 'de_DE-thorsten-medium', name: 'Thorsten', language: 'German', languageCode: 'de', description: 'German voice' },
  { id: 'portuguese', model: 'pt_BR-faber-medium', name: 'Faber', language: 'Portuguese', languageCode: 'pt', description: 'Brazilian Portuguese' },
];

/** Language code → best voice ID mapping for auto-selection. */
const LANG_VOICE_MAP: Record<string, string> = {
  en: 'default',
  es: 'spanish',
  fr: 'french',
  de: 'german',
  pt: 'portuguese',
};

// ── Voice transcription (Whisper) ───────────────────────────────────

/**
 * Transcribe an audio buffer via local Whisper (OpenAI-compatible API).
 * Returns the transcribed text, or null if transcription fails.
 */
export async function transcribeAudio(audioBuffer: Buffer, mimeType?: string): Promise<string | null> {
  try {
    // Whisper needs an actual audio file. Convert if needed.
    const ext = mimeType?.includes('ogg') ? '.ogg' : mimeType?.includes('mp4') ? '.m4a' : '.ogg';
    const tmpPath = join(tmpdir(), `garbanzo-audio-${Date.now()}${ext}`);
    await writeFile(tmpPath, audioBuffer);

    try {
      const formData = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType ?? 'audio/ogg' });
      formData.append('file', blob, `audio${ext}`);
      formData.append('model', 'whisper-1');

      const response = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.warn({ status: response.status, error: errText }, 'Whisper transcription failed');
        return null;
      }

      const result = await response.json() as { text: string };
      const text = result.text?.trim();
      if (!text) return null;

      logger.info({ textLength: text.length }, 'Voice message transcribed');
      return text;
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } catch (err) {
    logger.error({ err, mimeType, whisperUrl: WHISPER_URL }, 'Audio transcription error');
    return null;
  }
}

// ── Text-to-speech (Piper) ──────────────────────────────────────────

/**
 * Generate a voice note (OGG Opus) from text using Piper TTS.
 *
 * @param text - Text to speak
 * @param voiceId - Voice to use (id from VOICES, or auto-detect from text language)
 * @returns OGG Opus buffer ready for WhatsApp, or null on failure
 */
export async function textToSpeech(text: string, voiceId?: string): Promise<Buffer | null> {
  // Resolve voice
  const voice = resolveVoice(voiceId, text);
  if (!voice) {
    logger.warn({ voiceId }, 'Voice not found');
    return null;
  }

  const modelPath = join(VOICES_DIR, `${voice.model}.onnx`);
  if (!existsSync(modelPath)) {
    logger.warn({ model: voice.model, path: modelPath }, 'Voice model file not found');
    return null;
  }

  const tmpWav = join(tmpdir(), `garbanzo-tts-${Date.now()}.wav`);
  const tmpOgg = join(tmpdir(), `garbanzo-tts-${Date.now()}.ogg`);

  try {
    // Piper: text → WAV
    // Escape text for shell (remove quotes, limit length)
    const safeText = text.slice(0, 1000).replace(/'/g, "'\\''");
    await execAsync(
      `echo '${safeText}' | "${PIPER_BIN}" -m "${modelPath}" -f "${tmpWav}" 2>/dev/null`,
      { timeout: 30000 },
    );

    // FFmpeg: WAV → OGG Opus (WhatsApp voice note format)
    await execAsync(
      `ffmpeg -y -i "${tmpWav}" -c:a libopus -b:a 48k -ar 48000 -ac 1 "${tmpOgg}" 2>/dev/null`,
      { timeout: 15000 },
    );

    const oggBuffer = await readFile(tmpOgg);
    logger.info({ voice: voice.id, textLen: text.length, audioBytes: oggBuffer.length }, 'TTS audio generated');
    return oggBuffer;
  } catch (err) {
    logger.error({ err, voice: voice.id }, 'TTS generation failed');
    return null;
  } finally {
    await unlink(tmpWav).catch(() => {});
    await unlink(tmpOgg).catch(() => {});
  }
}

/**
 * Resolve a voice by ID or auto-detect from text language.
 */
function resolveVoice(voiceId: string | undefined, text: string): VoiceOption | null {
  // Explicit voice selection
  if (voiceId) {
    const lower = voiceId.toLowerCase().trim();
    const found = VOICES.find(v => v.id === lower || v.name.toLowerCase() === lower);
    if (found) return found;
  }

  // Auto-detect language from text
  const detected = detectLanguage(text);
  if (detected) {
    const langVoice = LANG_VOICE_MAP[detected.code];
    if (langVoice) {
      const voice = VOICES.find(v => v.id === langVoice);
      if (voice) return voice;
    }
  }

  // Default to English US
  return VOICES[0];
}

/**
 * Handle !voice command. Returns help text or the voice ID to use.
 */
export function handleVoiceCommand(args: string): { action: 'list' | 'speak'; voiceId?: string } {
  const trimmed = args.trim().toLowerCase();

  if (!trimmed || trimmed === 'list' || trimmed === 'voices' || trimmed === 'help') {
    return { action: 'list' };
  }

  return { action: 'speak', voiceId: trimmed };
}

/**
 * Format the list of available voices.
 */
export function formatVoiceList(): string {
  const lines = [
    '🎙️ *Available Voices*',
    '',
  ];

  for (const v of VOICES) {
    const available = existsSync(join(VOICES_DIR, `${v.model}.onnx`));
    const status = available ? '' : ' _(not installed)_';
    lines.push(`  *${v.id}* — ${v.description} (${v.language})${status}`);
  }

  lines.push('');
  lines.push('Usage: `!voice <name>` to hear the bot\'s last response');
  lines.push('The bot auto-selects a voice matching the conversation language.');

  return lines.join('\n');
}

/**
 * Check if Piper TTS is available (binary exists + at least one voice model).
 */
export function isTTSAvailable(): boolean {
  if (!existsSync(PIPER_BIN)) return false;
  return VOICES.some(v => existsSync(join(VOICES_DIR, `${v.model}.onnx`)));
}

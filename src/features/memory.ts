/**
 * Garbanzo memory — long-term community facts stored in SQLite.
 *
 * Owner commands (DM only):
 *   !memory                       — list all stored facts
 *   !memory add <category> <fact> — store a new owner fact
 *   !memory delete <id>           — remove a fact
 *   !memory share <id>            — copy a fact to shared cross-instance memory
 *   !memory unshare <id>          — remove a fact from shared cross-instance memory
 *   !memory search <keyword>      — search facts
 *
 * Facts are automatically injected into the AI system prompt so
 * Garbanzo "remembers" things about the community across conversations.
 *
 * Categories: events, venues, members, traditions, general
 */

import {
  addMemory,
  getAllMemories,
  deleteMemory,
  shareMemory,
  searchMemory,
  unshareMemory,
  type MemoryEntry,
} from '../utils/db.js';
import { config } from '../utils/config.js';

/**
 * Handle !memory owner commands. Returns a response string.
 */
export async function handleMemory(args: string): Promise<string> {
  const trimmed = args.trim();

  // !memory (no args) — list all
  if (!trimmed) {
    return await listMemories();
  }

  // !memory add <category> <fact>
  if (trimmed.toLowerCase() === 'add') {
    return [
      '❌ Usage: `!memory add <category> <fact>`',
      '',
      'Categories: events, venues, members, traditions, general',
      'Example: `!memory add venues The best trivia night is at Parlor in Cambridge on Wednesdays`',
    ].join('\n');
  }
  if (trimmed.toLowerCase().startsWith('add ')) {
    const rest = trimmed.slice(4).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      return [
        '❌ Usage: `!memory add <category> <fact>`',
        '',
        'Categories: events, venues, members, traditions, general',
        'Example: `!memory add venues The best trivia night is at Parlor in Cambridge on Wednesdays`',
      ].join('\n');
    }
    const category = rest.slice(0, spaceIdx).toLowerCase();
    const fact = rest.slice(spaceIdx + 1).trim();
    if (!fact) return '❌ No fact provided.';

    const entry = await addMemory(fact, category, 'owner');
    return `✅ Memory #${entry.id} stored [${category}]: ${fact}`;
  }

  // !memory delete <id>
  if (trimmed.toLowerCase().startsWith('delete ') || trimmed.toLowerCase().startsWith('remove ')) {
    const idStr = trimmed.split(/\s+/)[1];
    const id = parseInt(idStr, 10);
    if (isNaN(id)) return '❌ Provide a memory ID: `!memory delete 3`';

    const deleted = await deleteMemory(id);
    return deleted ? `🗑️ Memory #${id} deleted.` : `❌ Memory #${id} not found.`;
  }

  // !memory share <id>
  if (trimmed.toLowerCase().startsWith('share ')) {
    if (!config.SHARED_MEMORY_ENABLED) {
      return '🔒 Shared memory is disabled. Set SHARED_MEMORY_ENABLED=true to share curated facts.';
    }

    const idStr = trimmed.split(/\s+/)[1];
    const id = parseInt(idStr, 10);
    if (isNaN(id)) return '❌ Provide a memory ID: `!memory share 3`';

    const result = await shareMemory(id);
    if (result === 'not-found') return `❌ Memory #${id} not found.`;
    return result === 'shared'
      ? `✅ Memory #${id} shared.`
      : `❌ Memory #${id} could not be shared right now.`;
  }

  // !memory unshare <id>
  if (trimmed.toLowerCase().startsWith('unshare ')) {
    if (!config.SHARED_MEMORY_ENABLED) {
      return '🔒 Shared memory is disabled. Set SHARED_MEMORY_ENABLED=true to unshare curated facts.';
    }

    const idStr = trimmed.split(/\s+/)[1];
    const id = parseInt(idStr, 10);
    if (isNaN(id)) return '❌ Provide a memory ID: `!memory unshare 3`';

    const unshared = await unshareMemory(id);
    return unshared
      ? `🗑️ Memory #${id} unshared.`
      : `❌ Memory #${id} could not be unshared right now.`;
  }

  // !memory search <keyword>
  if (trimmed.toLowerCase().startsWith('search ')) {
    const keyword = trimmed.slice(7).trim();
    if (!keyword) return '❌ Provide a search term: `!memory search trivia`';

    const results = await searchMemory(keyword);
    if (results.length === 0) return `🔍 No memories matching "${keyword}".`;

    return formatMemoryList(results, `Search: "${keyword}"`);
  }

  return [
    '🧠 *Garbanzo Memory*',
    '',
    'Commands:',
    '  `!memory` — list all facts, including auto-extracted facts',
    '  `!memory add <category> <fact>` — store an owner fact',
    '  `!memory delete <id>` — remove a fact',
    '  `!memory share <id>` / `!memory unshare <id>` — manage explicit shared memory',
    '  `!memory search <keyword>` — search facts',
    '',
    'Categories: events, venues, members, traditions, general',
  ].join('\n');
}

async function listMemories(): Promise<string> {
  const memories = await getAllMemories();
  if (memories.length === 0) {
    return [
      '🧠 *Garbanzo Memory*',
      '',
      '_No facts stored yet._',
      '',
      'Add one: `!memory add general The group was founded in 2024`',
    ].join('\n');
  }

  return formatMemoryList(memories, `${memories.length} facts stored`);
}

function formatMemoryList(memories: MemoryEntry[], header: string): string {
  const lines = [`🧠 *Garbanzo Memory* — ${header}`, ''];

  const byCategory = new Map<string, MemoryEntry[]>();
  for (const m of memories) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }

  for (const [cat, entries] of byCategory) {
    lines.push(`*${cat}:*`);
    for (const e of entries) {
      if (e.shared) {
        lines.push(`  (shared from ${e.originInstance}) — ${e.fact}`);
        continue;
      }
      const sourceTag = e.source === 'auto' ? ' (auto)' : e.source === 'ai-tool' ? ' (ai)' : '';
      lines.push(`  #${e.id}${sourceTag} — ${e.fact}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

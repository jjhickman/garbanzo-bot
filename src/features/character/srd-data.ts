/**
 * Static D&D 5e SRD data tables, shared types, and pick utilities.
 */

// ── SRD Lists ───────────────────────────────────────────────────────

export const SRD_RACES = [
  'dragonborn', 'dwarf', 'elf', 'gnome', 'half-elf', 'half-orc',
  'halfling', 'human', 'tiefling',
] as const;

export const SRD_CLASSES = [
  'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
  'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
] as const;

export const BACKGROUNDS = [
  'Acolyte', 'Criminal', 'Folk Hero', 'Noble', 'Sage', 'Soldier',
  'Charlatan', 'Entertainer', 'Guild Artisan', 'Hermit', 'Outlander', 'Sailor',
] as const;

export const ALIGNMENTS = [
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
] as const;

// ── Shared Types ────────────────────────────────────────────────────

export type AbilityName = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

// ── Ability → Skill Mapping ─────────────────────────────────────────

export const SKILL_ABILITIES: Record<string, AbilityName> = {
  Acrobatics: 'dex', 'Animal Handling': 'wis', Arcana: 'int',
  Athletics: 'str', Deception: 'cha', History: 'int',
  Insight: 'wis', Intimidation: 'cha', Investigation: 'int',
  Medicine: 'wis', Nature: 'int', Perception: 'wis',
  Performance: 'cha', Persuasion: 'cha', Religion: 'int',
  'Sleight of Hand': 'dex', Stealth: 'dex', Survival: 'wis',
};

export const ALL_SKILLS = Object.keys(SKILL_ABILITIES);

// ── Class → Primary Ability Priority ────────────────────────────────

export const CLASS_PRIMARY_ABILITIES: Record<string, AbilityName[]> = {
  barbarian: ['str', 'con', 'dex'],
  bard: ['cha', 'dex', 'con'],
  cleric: ['wis', 'con', 'str'],
  druid: ['wis', 'con', 'dex'],
  fighter: ['str', 'con', 'dex'],
  monk: ['dex', 'wis', 'con'],
  paladin: ['str', 'cha', 'con'],
  ranger: ['dex', 'wis', 'con'],
  rogue: ['dex', 'int', 'cha'],
  sorcerer: ['cha', 'con', 'dex'],
  warlock: ['cha', 'con', 'dex'],
  wizard: ['int', 'con', 'dex'],
};

// ── Class → Saving Throw Proficiencies ──────────────────────────────

export const CLASS_SAVE_PROFICIENCIES: Record<string, AbilityName[]> = {
  barbarian: ['str', 'con'],
  bard: ['dex', 'cha'],
  cleric: ['wis', 'cha'],
  druid: ['int', 'wis'],
  fighter: ['str', 'con'],
  monk: ['str', 'dex'],
  paladin: ['wis', 'cha'],
  ranger: ['str', 'dex'],
  rogue: ['dex', 'int'],
  sorcerer: ['con', 'cha'],
  warlock: ['wis', 'cha'],
  wizard: ['int', 'wis'],
};

// ── Class → Skill Options ───────────────────────────────────────────

export const CLASS_SKILL_OPTIONS: Record<string, { choose: number; from: string[] }> = {
  barbarian: { choose: 2, from: ['Animal Handling', 'Athletics', 'Intimidation', 'Nature', 'Perception', 'Survival'] },
  bard: { choose: 3, from: ALL_SKILLS },
  cleric: { choose: 2, from: ['History', 'Insight', 'Medicine', 'Persuasion', 'Religion'] },
  druid: { choose: 2, from: ['Arcana', 'Animal Handling', 'Insight', 'Medicine', 'Nature', 'Perception', 'Religion', 'Survival'] },
  fighter: { choose: 2, from: ['Acrobatics', 'Animal Handling', 'Athletics', 'History', 'Insight', 'Intimidation', 'Perception', 'Survival'] },
  monk: { choose: 2, from: ['Acrobatics', 'Athletics', 'History', 'Insight', 'Religion', 'Stealth'] },
  paladin: { choose: 2, from: ['Athletics', 'Insight', 'Intimidation', 'Medicine', 'Persuasion', 'Religion'] },
  ranger: { choose: 3, from: ['Animal Handling', 'Athletics', 'Insight', 'Investigation', 'Nature', 'Perception', 'Stealth', 'Survival'] },
  rogue: { choose: 4, from: ['Acrobatics', 'Athletics', 'Deception', 'Insight', 'Intimidation', 'Investigation', 'Perception', 'Performance', 'Persuasion', 'Sleight of Hand', 'Stealth'] },
  sorcerer: { choose: 2, from: ['Arcana', 'Deception', 'Insight', 'Intimidation', 'Persuasion', 'Religion'] },
  warlock: { choose: 2, from: ['Arcana', 'Deception', 'History', 'Intimidation', 'Investigation', 'Nature', 'Religion'] },
  wizard: { choose: 2, from: ['Arcana', 'History', 'Insight', 'Investigation', 'Medicine', 'Religion'] },
};

// ── Class → Starting Equipment ──────────────────────────────────────

export const CLASS_EQUIPMENT: Record<string, string> = {
  barbarian: 'Greataxe, 2 Handaxes, Explorer\'s Pack, 4 Javelins',
  bard: 'Rapier, Diplomat\'s Pack, Lute, Leather Armor, Dagger',
  cleric: 'Mace, Scale Mail, Light Crossbow, 20 Bolts, Priest\'s Pack, Shield, Holy Symbol',
  druid: 'Wooden Shield, Scimitar, Leather Armor, Explorer\'s Pack, Druidic Focus',
  fighter: 'Chain Mail, Shield, Longsword, Light Crossbow, 20 Bolts, Dungeoneer\'s Pack',
  monk: 'Shortsword, Dungeoneer\'s Pack, 10 Darts',
  paladin: 'Chain Mail, Shield, Longsword, 5 Javelins, Priest\'s Pack, Holy Symbol',
  ranger: 'Scale Mail, 2 Shortswords, Dungeoneer\'s Pack, Longbow, Quiver, 20 Arrows',
  rogue: 'Rapier, Shortbow, Quiver, 20 Arrows, Burglar\'s Pack, Leather Armor, 2 Daggers, Thieves\' Tools',
  sorcerer: 'Light Crossbow, 20 Bolts, Arcane Focus, Dungeoneer\'s Pack, 2 Daggers',
  warlock: 'Light Crossbow, 20 Bolts, Arcane Focus, Scholar\'s Pack, Leather Armor, Any Simple Weapon, 2 Daggers',
  wizard: 'Quarterstaff, Arcane Focus, Scholar\'s Pack, Spellbook',
};

// ── Class → Weapons ─────────────────────────────────────────────────

export const CLASS_WEAPONS: Record<string, Array<{ name: string; atk: string; dmg: string }>> = {
  barbarian: [{ name: 'Greataxe', atk: '+5', dmg: '1d12+3 S' }, { name: 'Handaxe', atk: '+5', dmg: '1d6+3 S' }],
  bard: [{ name: 'Rapier', atk: '+5', dmg: '1d8+3 P' }, { name: 'Dagger', atk: '+5', dmg: '1d4+3 P' }],
  cleric: [{ name: 'Mace', atk: '+4', dmg: '1d6+2 B' }, { name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }],
  druid: [{ name: 'Scimitar', atk: '+4', dmg: '1d6+2 S' }],
  fighter: [{ name: 'Longsword', atk: '+5', dmg: '1d8+3 S' }, { name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }],
  monk: [{ name: 'Shortsword', atk: '+5', dmg: '1d6+3 P' }, { name: 'Unarmed', atk: '+5', dmg: '1d4+3 B' }],
  paladin: [{ name: 'Longsword', atk: '+5', dmg: '1d8+3 S' }, { name: 'Javelin', atk: '+5', dmg: '1d6+3 P' }],
  ranger: [{ name: 'Shortsword', atk: '+5', dmg: '1d6+3 P' }, { name: 'Longbow', atk: '+5', dmg: '1d8+3 P' }],
  rogue: [{ name: 'Rapier', atk: '+5', dmg: '1d8+3 P' }, { name: 'Shortbow', atk: '+5', dmg: '1d6+3 P' }],
  sorcerer: [{ name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }, { name: 'Dagger', atk: '+4', dmg: '1d4+2 P' }],
  warlock: [{ name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }, { name: 'Dagger', atk: '+4', dmg: '1d4+2 P' }],
  wizard: [{ name: 'Quarterstaff', atk: '+2', dmg: '1d6 B' }],
};

// ── Names by Race ───────────────────────────────────────────────────

export const FIRST_NAMES: Record<string, string[]> = {
  dragonborn: ['Arjhan', 'Balasar', 'Bharash', 'Donaar', 'Ghesh', 'Heskan', 'Medrash', 'Nadarr', 'Pandjed', 'Rhogar', 'Shamash', 'Shedinn', 'Torinn'],
  dwarf: ['Adrik', 'Baern', 'Bruenor', 'Dain', 'Eberk', 'Flint', 'Gardain', 'Harbek', 'Orsik', 'Rurik', 'Tordek', 'Traubon', 'Ulfgar', 'Vondal'],
  elf: ['Adran', 'Aelar', 'Aramil', 'Arannis', 'Berrian', 'Enna', 'Galinndan', 'Hadarai', 'Immeral', 'Laucian', 'Mindartis', 'Quarion', 'Riardon', 'Thia'],
  gnome: ['Alvyn', 'Boddynock', 'Brocc', 'Burgell', 'Dimble', 'Eldon', 'Erky', 'Fonkin', 'Frug', 'Gimble', 'Glim', 'Jebeddo', 'Kellen', 'Wrenn', 'Zook'],
  'half-elf': ['Ander', 'Erevan', 'Galinndan', 'Kieran', 'Lucan', 'Mialee', 'Naivara', 'Quelenna', 'Sariel', 'Shanairra', 'Theren', 'Varis'],
  'half-orc': ['Dench', 'Feng', 'Gell', 'Henk', 'Holg', 'Imsh', 'Keth', 'Krusk', 'Ront', 'Shump', 'Thokk'],
  halfling: ['Alton', 'Beau', 'Cade', 'Corrin', 'Eldon', 'Finnan', 'Garret', 'Lidda', 'Milo', 'Osborn', 'Roscoe', 'Wellby'],
  human: ['Ander', 'Bran', 'Dorn', 'Eldric', 'Falk', 'Grigor', 'Helm', 'Kara', 'Lena', 'Mara', 'Nils', 'Perren', 'Quinn', 'Rowan', 'Theron'],
  tiefling: ['Akta', 'Bryseis', 'Criella', 'Damakos', 'Ekemon', 'Kairon', 'Leucis', 'Makarios', 'Nemeia', 'Orianna', 'Rieta', 'Therai'],
};

// ── Personality by Background ───────────────────────────────────────

export const PERSONALITY_TRAITS: Record<string, string[]> = {
  Acolyte: ['I idolize a particular hero of my faith, and constantly refer to that person\'s deeds.', 'Nothing can shake my optimistic attitude.'],
  Criminal: ['I always have a plan for what to do when things go wrong.', 'I am always calm, no matter what the situation.'],
  'Folk Hero': ['I judge people by their actions, not their words.', 'If someone is in trouble, I\'m always ready to lend help.'],
  Noble: ['My eloquent flattery makes everyone I talk to feel wonderful.', 'I take great pains to always look my best.'],
  Sage: ['I\'m used to helping out those who aren\'t as smart as I am.', 'I\'ve read every book in the world\'s greatest libraries.'],
  Soldier: ['I\'m always polite and respectful.', 'I\'ve lost too many friends, and I\'m slow to make new ones.'],
  Charlatan: ['I fall in and out of love easily, and am always pursuing someone.', 'I have a joke for every occasion.'],
  Entertainer: ['I know a story relevant to almost every situation.', 'I change my mood or my mind as quickly as I change a tune.'],
  'Guild Artisan': ['I believe that anything worth doing is worth doing right.', 'I\'m a snob who looks down on those who can\'t appreciate fine art.'],
  Hermit: ['I feel tremendous empathy for all who suffer.', 'I often get lost in my own thoughts and contemplation.'],
  Outlander: ['I\'m driven by a wanderlust that led me away from home.', 'I watch over my friends as if they were a litter of newborn pups.'],
  Sailor: ['My friends know they can rely on me, no matter what.', 'I stretch the truth for a good story.'],
};

export const IDEALS: Record<string, string> = {
  Acolyte: 'Faith. I trust that my deity will guide my actions.',
  Criminal: 'Freedom. Chains are meant to be broken.',
  'Folk Hero': 'Respect. People deserve to be treated with dignity.',
  Noble: 'Responsibility. It is my duty to respect the authority of those above me.',
  Sage: 'Knowledge. The path to power and self-improvement is through knowledge.',
  Soldier: 'Greater Good. Our lot is to lay down our lives in defense of others.',
  Charlatan: 'Independence. I am a free spirit — no one tells me what to do.',
  Entertainer: 'Beauty. When I perform, I make the world better than it was.',
  'Guild Artisan': 'Community. Everyone\'s duty is to strengthen the bonds of community.',
  Hermit: 'Free Thinking. Inquiry and curiosity are the pillars of progress.',
  Outlander: 'Glory. I must earn glory in battle, for myself and my clan.',
  Sailor: 'Freedom. The sea is freedom — the freedom to go anywhere and do anything.',
};

export const BONDS: Record<string, string> = {
  Acolyte: 'I would die to recover an ancient relic of my faith.',
  Criminal: 'Someone I loved died because of a mistake I made.',
  'Folk Hero': 'I protect those who cannot protect themselves.',
  Noble: 'I will face any challenge to win the approval of my family.',
  Sage: 'I\'ve been searching my whole life for the answer to a certain question.',
  Soldier: 'I\'ll never forget the crushing defeat my company suffered.',
  Charlatan: 'I owe everything to my mentor — a horrible person who\'s probably rotting in jail.',
  Entertainer: 'My instrument is my most treasured possession.',
  'Guild Artisan': 'I owe my guild a great debt for forging me into the person I am today.',
  Hermit: 'I entered seclusion because I loved someone I could not have.',
  Outlander: 'My family, clan, or tribe is the most important thing in my life.',
  Sailor: 'I was cheated out of my fair share of the profits, and I want to get my due.',
};

export const FLAWS: Record<string, string> = {
  Acolyte: 'I judge others harshly, and myself even more severely.',
  Criminal: 'When I see something valuable, I can\'t think about anything but how to steal it.',
  'Folk Hero': 'I\'m convinced of the significance of my destiny, and blind to my shortcomings.',
  Noble: 'I secretly believe that everyone is beneath me.',
  Sage: 'I am easily distracted by the promise of information.',
  Soldier: 'I\'d rather eat my armor than admit when I\'m wrong.',
  Charlatan: 'I can\'t resist swindling people who are more powerful than me.',
  Entertainer: 'I\'ll do anything to win fame and renown.',
  'Guild Artisan': 'I\'ll do anything to get my hands on something rare or priceless.',
  Hermit: 'I harbor dark, bloodthirsty thoughts that my isolation failed to quell.',
  Outlander: 'I am slow to trust members of other races, tribes, and societies.',
  Sailor: 'Once I start drinking, it\'s hard for me to stop.',
};

// ── Pick Utilities ──────────────────────────────────────────────────

export function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pickRandomN<T>(arr: readonly T[], n: number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

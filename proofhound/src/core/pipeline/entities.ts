import type { Entity, EntityKind, Source } from '@/core/types';
import { deterministicId } from '@/core/id';

/**
 * Entity extraction.
 *
 * Deliberately conservative: it lifts named things that actually appear in the
 * claim or in retrieved source titles. It never introduces a name that is not
 * present in the text, because a fabricated institution in a claim card reads
 * exactly like a real one.
 */

/** Words that start a sentence but are not names. */
const STOPWORDS = new Set([
  'A', 'An', 'The', 'This', 'That', 'These', 'Those', 'It', 'Its', 'They', 'There',
  'He', 'She', 'His', 'Her', 'We', 'Our', 'You', 'Your', 'I', 'In', 'On', 'At',
  'By', 'For', 'From', 'With', 'And', 'But', 'Or', 'If', 'When', 'While', 'After',
  'Before', 'Because', 'However', 'Although', 'Researchers', 'Scientists', 'Sources',
  'According', 'Multiple', 'Several', 'Three', 'Two', 'Four', 'Five', 'New', 'Some',
  'Many', 'Most', 'One', 'No', 'Not', 'Is', 'Was', 'Are', 'Were', 'Has', 'Have',
]);

interface KindRule {
  kind: EntityKind;
  patterns: RegExp[];
}

const KIND_RULES: KindRule[] = [
  {
    kind: 'institution',
    patterns: [/\b(Laborator(y|ies)|Institute|University|College|Academy|Hospital|Observatory)\b/],
  },
  {
    kind: 'organization',
    patterns: [/\b(Agency|Department|Bureau|Ministry|Commission|Foundation|Society|Committee|Corporation|Inc\.?|Ltd\.?|LLC|Group|Task Force|Programme|Program Office)\b/],
  },
  { kind: 'publication', patterns: [/\b(Journal|Review|Times|Post|Herald|Tribune|Gazette|Press|News|Podcast|Magazine)\b/] },
  { kind: 'dataset', patterns: [/\b(Dataset|Database|Archive|Repository|Registry|Corpus)\b/] },
  { kind: 'event', patterns: [/\b(Incident|Encounter|Sighting|Expedition|Hearing|Conference|Summit|Launch)\b/] },
  { kind: 'location', patterns: [/\b(County|Forest|Mountain|Range|River|Lake|Valley|Island|National Park|Base|Airport)\b/] },
  { kind: 'artifact', patterns: [/\b(Sample|Specimen|Recording|Footage|Photograph|Document|Report|Memo|Alloy|Fragment)\b/] },
];

/** Two- to five-word Capitalised sequences, optionally joined by of/the/and. */
const PROPER_NOUN = /\b([A-Z][A-Za-z'’-]+(?:\s+(?:of|the|and|de|von|van)\s+[A-Z][A-Za-z'’-]+|\s+[A-Z][A-Za-z'’-]+){0,4})\b/g;
const PERSON_TITLE = /\b(?:Dr|Prof(?:essor)?|Mr|Ms|Mrs|Sgt|Capt(?:ain)?|Cmdr|Lt|Sen(?:ator)?|Rep)\.?\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})/g;

export function inferEntityKind(name: string): EntityKind {
  for (const rule of KIND_RULES) {
    if (rule.patterns.some((p) => p.test(name))) return rule.kind;
  }
  // Two capitalised words with no institutional marker reads as a person.
  return /^[A-Z][a-z'’-]+\s+[A-Z][a-z'’-]+$/.test(name) ? 'person' : 'organization';
}

interface Candidate {
  name: string;
  kind: EntityKind;
  sourceIds: Set<string>;
}

function addCandidate(map: Map<string, Candidate>, rawName: string, kind: EntityKind, sourceId: string | null): void {
  const name = rawName.replace(/\s+/g, ' ').trim().replace(/[.,;:]$/, '');
  if (name.length < 3) return;
  const words = name.split(' ');
  if (words.length === 1 && STOPWORDS.has(name)) return;
  const firstWord = words[0];
  if (words.length === 1 && firstWord && firstWord.length < 4) return;
  // A leading stopword means we caught the start of a sentence, not a name.
  if (firstWord && STOPWORDS.has(firstWord) && words.length <= 2) return;

  const key = name.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    if (sourceId) existing.sourceIds.add(sourceId);
    return;
  }
  map.set(key, { name, kind, sourceIds: new Set(sourceId ? [sourceId] : []) });
}

/** Split an author field ("L. Kwan, R. Adeyemi & P. Sørensen") into names. */
export function splitAuthors(author: string): string[] {
  return author
    .split(/,|\s+&\s+|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2 && /[A-Z]/.test(part));
}

/**
 * Words that mark a candidate as a real organisation, institution, publication
 * or artifact rather than an incidental capitalised phrase in a headline.
 */
const INSTITUTIONAL_MARKER =
  /\b(Laborator|Institute|Universit|College|Academy|Hospital|Observatory|Agency|Department|Bureau|Ministry|Commission|Foundation|Society|Committee|Corporation|Office|Genomics|Genetics|Journal|Review|Archive|Press|Podcast|Dataset|Database|Registry|Report|Filing|Sample|Specimen)\b/;

function harvest(text: string, sourceId: string | null, map: Map<string, Candidate>): void {
  for (const match of text.matchAll(PERSON_TITLE)) {
    if (match[1]) addCandidate(map, match[1], 'person', sourceId);
  }
  for (const match of text.matchAll(PROPER_NOUN)) {
    const name = match[1];
    if (!name) continue;
    if (name.split(' ').length < 2) continue; // single capitalised words are too noisy
    // Source titles are full of capitalised phrases that name nothing —
    // "North American", "Primate DNA". Lifting them all fills the claim card
    // with noise, so a title candidate must look institutional to qualify.
    // Text from the claim itself is not filtered: the claim is the subject.
    if (sourceId !== null && !INSTITUTIONAL_MARKER.test(name)) continue;
    addCandidate(map, name, inferEntityKind(name), sourceId);
  }
}

/**
 * Extract entities from the claim and from retrieved source metadata.
 *
 * `seeded` entities (supplied by a research adapter that already resolved them)
 * take precedence and are never overwritten by the heuristic pass.
 */
export function extractEntities(
  claimText: string,
  sources: Source[],
  investigationId: string,
  seeded: Array<{ name: string; kind: EntityKind; role: string }> = [],
): Entity[] {
  const map = new Map<string, Candidate>();
  harvest(claimText, null, map);
  for (const source of sources) {
    harvest(source.title, source.id, map);
    // Publishers are deliberately not harvested: they already appear in the
    // ledger and the evidence map, and repeating them here crowds out the
    // people, institutions and artifacts the claim actually turns on.
    if (source.author) {
      for (const author of splitAuthors(source.author)) addCandidate(map, author, 'person', source.id);
    }
  }

  dropInitialFormDuplicates(map);

  const seededKeys = new Set(seeded.map((s) => s.name.toLowerCase()));
  const isSeeded = (entity: Entity): boolean => seededKeys.has(entity.name.toLowerCase());
  const entities: Entity[] = seeded.map((s) => ({
    id: deterministicId('entity', investigationId, s.name),
    name: s.name,
    kind: s.kind,
    role: s.role,
    mentionedInSourceIds: sources
      .filter((source) => source.title.includes(s.name) || source.publisher === s.name || source.author === s.name)
      .map((source) => source.id),
  }));

  for (const [key, candidate] of map) {
    if (seededKeys.has(key)) continue;
    entities.push({
      id: deterministicId('entity', investigationId, candidate.name),
      name: candidate.name,
      kind: candidate.kind,
      role: describeRole(candidate.kind),
      mentionedInSourceIds: [...candidate.sourceIds],
    });
  }

  return dropContainedNames(entities).sort((a, b) => {
    // Seeded entities were named as central to the claim, so they lead however
    // often an incidental byline happens to appear.
    const seedRank = Number(isSeeded(b)) - Number(isSeeded(a));
    if (seedRank !== 0) return seedRank;
    return b.mentionedInSourceIds.length - a.mentionedInSourceIds.length || a.name.localeCompare(b.name);
  });
}

/**
 * Collapse "M. Hollowell" into "Marisa Hollowell".
 *
 * Bylines and body text name the same person differently, and a claim card
 * listing both looks like the tool cannot tell people apart.
 */
function dropInitialFormDuplicates(map: Map<string, Candidate>): void {
  const surnameOf = (name: string): string => (name.split(' ').pop() ?? '').toLowerCase();
  const isInitialForm = (name: string): boolean => /^[A-Z]\.?\s/.test(name);

  const fullBySurname = new Map<string, string>();
  for (const candidate of map.values()) {
    if (candidate.kind !== 'person' || isInitialForm(candidate.name)) continue;
    fullBySurname.set(surnameOf(candidate.name), candidate.name);
  }

  for (const [key, candidate] of map) {
    if (candidate.kind !== 'person' || !isInitialForm(candidate.name)) continue;
    const full = fullBySurname.get(surnameOf(candidate.name));
    if (!full) continue;
    const target = map.get(full.toLowerCase());
    if (!target) continue;
    for (const id of candidate.sourceIds) target.sourceIds.add(id);
    map.delete(key);
  }
}

/**
 * Drop a name that is wholly contained in a longer one of the same kind —
 * "Sample Analysis Report" alongside "Sample Analysis Report 4471" reads as two
 * documents when there is only one.
 */
function dropContainedNames(entities: Entity[]): Entity[] {
  return entities.filter(
    (entity) =>
      !entities.some(
        (other) =>
          other !== entity &&
          other.kind === entity.kind &&
          other.name.length > entity.name.length &&
          other.name.toLowerCase().includes(entity.name.toLowerCase()),
      ),
  );
}

function describeRole(kind: EntityKind): string {
  switch (kind) {
    case 'person':
      return 'Named in the claim or in a source';
    case 'institution':
      return 'Institution referenced by the claim';
    case 'organization':
      return 'Organisation referenced by the claim';
    case 'publication':
      return 'Outlet carrying the claim';
    case 'dataset':
      return 'Data referenced by the claim';
    case 'event':
      return 'Event the claim turns on';
    case 'location':
      return 'Place the claim turns on';
    case 'artifact':
      return 'Material the claim turns on';
  }
}

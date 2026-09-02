import type { Claim, ClaimCategory, EpistemicStatus } from '@/core/types';
import { deterministicId } from '@/core/id';

const URL_PATTERN = /^https?:\/\/\S+$/i;

/**
 * Phrases people wrap around a claim when asking about it. Stripping them turns
 * a question into the checkable assertion underneath, which is what the rest of
 * the pipeline reasons about.
 */
const LEADING_FRAMES: RegExp[] = [
  /^is\s+it\s+(really\s+)?true\s+that\s+/i,
  /^is\s+there\s+any\s+truth\s+to\s+(the\s+claim\s+that\s+)?/i,
  /^did\s+(you\s+)?(hear|know)\s+that\s+/i,
  /^can\s+(you|someone)\s+(please\s+)?(fact[-\s]?check|verify|check|investigate)\s+(this|that|the\s+claim)?:?\s*/i,
  /^(please\s+)?(fact[-\s]?check|verify|investigate|debunk|look\s+into)\s*(this|that|the\s+claim)?\s*:?\s*/i,
  /^i\s+(heard|read|saw)\s+(that\s+)?/i,
  /^apparently\s+/i,
  /^so\s+/i,
  /^(the\s+)?claim(\s+is)?:\s*/i,
];

const TRAILING_QUESTIONS: RegExp[] = [
  /\s*[—-]?\s*is\s+this\s+true\??$/i,
  /\s*[—-]?\s*true\s+or\s+false\??$/i,
  /\s*[—-]?\s*real\s+or\s+fake\??$/i,
  /\s*[—-]?\s*thoughts\??$/i,
];

interface CategoryRule {
  category: ClaimCategory;
  patterns: RegExp[];
}

/**
 * Keyword routing. Ordered: the first rule that matches wins, so the most
 * specific niches sit above the general buckets.
 */
const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'UAP',
    patterns: [
      /\buaps?\b/i, /\bufos?\b/i, /\bunidentified (aerial|anomalous) phenomen/i,
      /\bflying saucer/i, /\btic[- ]?tac (object|craft)/i, /\bextraterrestrial (craft|vehicle)/i,
      /\bcraft of (unknown|non-human) origin/i, /\bnon-human (intelligence|biolog)/i,
    ],
  },
  {
    category: 'Cryptid',
    patterns: [
      /\bbigfoot\b/i, /\bsasquatch\b/i, /\byeti\b/i, /\bloch ness\b/i, /\bnessie\b/i,
      /\bchupacabra\b/i, /\bmothman\b/i, /\bcryptid/i, /\bskunk ape\b/i,
      /\bunknown primate\b/i, /\bunknown hominid\b/i,
    ],
  },
  {
    category: 'Paranormal',
    patterns: [
      /\bghost\b/i, /\bhaunt(ed|ing)\b/i, /\bpoltergeist\b/i, /\bapparition\b/i,
      /\bpsychic\b/i, /\btelekinesis\b/i, /\bremote viewing\b/i, /\bexorcis/i,
      /\bnear[- ]death experience/i,
    ],
  },
  {
    category: 'Conspiracy',
    patterns: [
      /\bcover[- ]?up\b/i, /\bconspiracy\b/i, /\bfalse flag\b/i, /\bcrisis actor/i,
      /\bdeep state\b/i, /\bthey don'?t want you to know\b/i, /\bsuppressed by\b/i,
      /\bsecret programme?\b/i, /\bsecret program\b/i, /\bclassified programme?\b/i,
    ],
  },
  {
    category: 'Science',
    patterns: [
      /\bpeer[- ]reviewed\b/i, /\bstudy (found|shows|claims)\b/i, /\bclinical trial\b/i,
      /\bdna\b/i, /\bgenome\b/i, /\bsequenc(ed|ing)\b/i, /\blaborator(y|ies)\b/i,
      /\bresearchers?\b/i, /\bscientists?\b/i, /\breplicat(ed|ion)\b/i, /\bp[- ]value\b/i,
    ],
  },
  {
    category: 'Viral Claim',
    patterns: [
      /\bwent viral\b/i, /\bviral (video|post|clip|photo)\b/i, /\btiktok\b/i,
      /\btwitter\b/i, /\bx\.com\b/i, /\breddit\b/i, /\bfacebook\b/i, /\binstagram\b/i,
      /\btrending\b/i, /\bmillions of views\b/i,
    ],
  },
];

/** Signals that the statement is presented as, or is only, a particular epistemic kind. */
const EPISTEMIC_SIGNALS: Array<{ status: EpistemicStatus; patterns: RegExp[] }> = [
  {
    status: 'ALLEGATION',
    patterns: [/\balleg(ed|es|ation)/i, /\baccus(ed|ation)/i, /\bwhistle-?blower/i, /\bunder oath\b/i],
  },
  {
    status: 'UNVERIFIED_REPORT',
    patterns: [
      /\bunconfirmed\b/i, /\breportedly\b/i, /\brumou?r/i, /\bsources say\b/i,
      /\banonymous (source|official)/i, /\bwitnesses? (say|said|claim)/i, /\bsighting/i,
    ],
  },
  {
    status: 'SPECULATION',
    patterns: [/\bcould be\b/i, /\bmight be\b/i, /\bwhat if\b/i, /\bsuggests? that .* may\b/i, /\bspeculat/i],
  },
  {
    status: 'INTERPRETATION',
    patterns: [/\bindicates?\b/i, /\bimplies\b/i, /\bconsistent with\b/i, /\bpoints to\b/i],
  },
];

const DATE_PATTERNS: RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(?:19|20)\d{2}\b/gi,
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:19|20)\d{2}\b/gi,
  /\b(?:19|20)\d{2}\b/g,
];

export function isUrlInput(input: string): boolean {
  return URL_PATTERN.test(input.trim());
}

/**
 * Reduce free-form user input to a single checkable sentence.
 *
 * This is intentionally conservative: it removes framing, not content. If it
 * cannot find a sentence it returns the cleaned input rather than inventing one.
 */
export function normalizeClaimText(input: string): string {
  let text = input.replace(/\s+/g, ' ').trim();
  if (!text) return '';

  // Unwrap a claim quoted in full.
  const quoted = text.match(/^["“'']([\s\S]+)["”'']$/);
  if (quoted?.[1]) text = quoted[1].trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const frame of LEADING_FRAMES) {
      const next = text.replace(frame, '');
      if (next !== text) {
        text = next.trim();
        changed = true;
      }
    }
  }

  for (const tail of TRAILING_QUESTIONS) {
    text = text.replace(tail, '');
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return input.trim();

  // A leading lowercase letter after frame-stripping reads as a fragment.
  const first = text[0];
  if (first && first === first.toLowerCase() && first !== first.toUpperCase()) {
    text = first.toUpperCase() + text.slice(1);
  }

  if (!/[.!?]$/.test(text)) text = `${text}.`;
  // A stripped question that still ends in "?" is left alone; otherwise "?" → "."
  text = text.replace(/\?\.$/, '?');

  return text;
}

export function categorizeClaim(text: string): ClaimCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.category;
  }
  return 'Other';
}

/**
 * Classify the statement's epistemic category from how it is worded.
 *
 * Defaults to CLAIM. Nothing here ever returns FACT — a statement only becomes
 * a FACT once evidence supports it, which is decided downstream.
 */
export function classifyEpistemicStatus(text: string): EpistemicStatus {
  for (const signal of EPISTEMIC_SIGNALS) {
    if (signal.patterns.some((p) => p.test(text))) return signal.status;
  }
  return 'CLAIM';
}

export function extractReferencedDates(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[0]) found.add(match[0]);
    }
  }
  // Drop bare years already covered by a fuller date string.
  const all = [...found];
  return all.filter((d) => !(/^(?:19|20)\d{2}$/.test(d) && all.some((o) => o !== d && o.includes(d))));
}

/**
 * Split a normalized claim into the separate assertions that would each have to
 * hold. Conjunctions are the only split point — we do not paraphrase.
 */
export function splitAssertions(normalized: string): string[] {
  const body = normalized.replace(/[.?!]+$/, '');
  const parts = body
    .split(/,\s+and\s+|\s+and\s+that\s+|;\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 12);
  if (parts.length <= 1) return [normalized];
  return parts.map((p, i) => {
    const sentence = i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1);
    return /[.?!]$/.test(sentence) ? sentence : `${sentence}.`;
  });
}

export function buildClaim(rawInput: string, investigationId: string): Claim {
  const trimmed = rawInput.trim();
  const url = isUrlInput(trimmed) ? trimmed : null;
  const normalized = url ? trimmed : normalizeClaimText(trimmed);
  const subject = url ? trimmed : normalized;

  return {
    id: deterministicId('claim', investigationId),
    rawInput: trimmed,
    normalized,
    assertions: url ? [normalized] : splitAssertions(normalized),
    category: categorizeClaim(subject),
    epistemicStatus: classifyEpistemicStatus(subject),
    entityIds: [],
    referencedDates: extractReferencedDates(subject),
    sourceUrl: url,
  };
}

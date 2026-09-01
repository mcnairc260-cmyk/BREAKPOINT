import type { RetrievalResult, RetrievedSource } from '@/core/research/types';

/**
 * DEMONSTRATION CASE — entirely fictional.
 *
 * Every outlet, person, institution and document below is invented, and every
 * URL uses the reserved `.invalid` top-level domain so that no link here can
 * ever resolve to a real page. The case is constructed to make ProofHound's
 * central insight visible in one screen:
 *
 *   15 apparent sources → 3 independent source families
 *
 * The largest family — eleven sources, including most of the coverage a search
 * engine would surface — traces back to a single laboratory report that nobody
 * has been able to obtain, and which is dated *after* the interview that cites
 * it. The two families that do carry first-hand material both contradict the
 * claim.
 */

const D = 'https://demo.proofhound.invalid';

const sources: RetrievedSource[] = [
  // -- Family A: everything descending from one unobtainable document --------
  {
    id: 'src_lab_report_4471',
    url: `${D}/documents/whitcombe-report-4471`,
    title: 'Whitcombe Genomics — Sample Analysis Report 4471 (referenced, never released)',
    publisher: 'Whitcombe Genomics',
    author: null,
    publicationDate: '2024-05-02',
    sourceType: 'unknown',
    verification: 'INACCESSIBLE',
    reliabilityOverride: 0.1,
    notes:
      'Referenced by name in the Hollowell interview and by every downstream article, but no copy has been produced by any party. The laboratory has not confirmed that the report exists.',
    evidence: [
      {
        evidenceType: 'absence_of_record',
        directness: 'direct',
        quality: 'unusable',
        stance: 'neutral',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary:
          'The document the entire claim rests on could not be retrieved from the laboratory, the researcher or any outlet that cited it.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_hollowell_podcast',
    url: `${D}/podcasts/deep-field-217`,
    title: 'Deep Field, Episode 217: “Three laboratories saw the same thing”',
    publisher: 'Deep Field Podcast',
    author: 'Marisa Hollowell',
    publicationDate: '2024-02-11',
    sourceType: 'podcast',
    verification: 'VERIFIED',
    reliabilityOverride: 0.3,
    anonymousAttribution: true,
    cites: [{ text: 'Whitcombe Genomics report 4471', sourceId: 'src_lab_report_4471' }],
    notes:
      'The first appearance of the “three laboratories” figure. Hollowell names one laboratory and describes the other two as “partners who asked not to be identified”.',
    evidence: [
      {
        evidenceType: 'expert_opinion',
        directness: 'hearsay',
        quality: 'weak',
        stance: 'supports',
        epistemicStatus: 'CLAIM',
        summary:
          'Hollowell states that three laboratories independently confirmed an unclassified primate mitochondrial sequence.',
        excerpt:
          '“Three separate labs ran it. Three separate labs came back with the same answer, and none of them could match it to anything on file.”',
      },
    ],
  },
  {
    id: 'src_cascade_herald',
    url: `${D}/news/cascade-herald/unknown-primate-dna`,
    title: 'Researcher says unknown primate DNA confirmed by three labs',
    publisher: 'Cascade Herald',
    author: 'T. Bramley',
    publicationDate: '2024-02-14',
    sourceType: 'news_article',
    verification: 'VERIFIED',
    reliabilityOverride: 0.5,
    anonymousAttribution: true,
    cites: [{ text: 'a recent interview on the Deep Field podcast', sourceId: 'src_hollowell_podcast' }],
    notes: 'Reports the interview. Does not appear to have contacted any of the three laboratories.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'weak',
        stance: 'supports',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary: 'Restates the three-laboratory figure, attributed to Hollowell.',
        excerpt: '“Dr Hollowell told the programme that three laboratories had reached the same conclusion.”',
      },
    ],
  },
  {
    id: 'src_cryptidwire',
    url: `${D}/cryptidwire/three-labs-confirm`,
    title: 'THREE LABS CONFIRM: unknown primate walks North America',
    publisher: 'CryptidWire',
    author: null,
    publicationDate: '2024-02-15',
    sourceType: 'aggregator',
    verification: 'VERIFIED',
    reliabilityOverride: 0.15,
    cites: [{ text: 'Cascade Herald', sourceId: 'src_cascade_herald' }],
    notes: 'Aggregated rewrite of the Herald piece. Adds no reporting of its own.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary: 'Repeats the Herald summary with stronger wording and no additional sourcing.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_youtube_essay',
    url: `${D}/video/what-the-labs-found`,
    title: 'What the labs actually found (37 min)',
    publisher: 'Northlight Files',
    author: null,
    publicationDate: '2024-02-19',
    sourceType: 'video',
    verification: 'VERIFIED',
    reliabilityOverride: 0.2,
    cites: [
      { text: 'Cascade Herald report', sourceId: 'src_cascade_herald' },
      { text: 'CryptidWire', sourceId: 'src_cryptidwire' },
    ],
    notes: 'Video essay. On-screen “lab documents” are recreations, stated as such at 31:40.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'INTERPRETATION',
        summary: 'Presents a reconstruction of the unreleased report as if it were the document itself.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_reddit_thread',
    url: `${D}/forum/r-unexplained/2024-02-20`,
    title: 'Someone finally got the lab results — megathread',
    publisher: 'r/unexplained',
    author: null,
    publicationDate: '2024-02-20',
    sourceType: 'forum_thread',
    verification: 'VERIFIED',
    reliabilityOverride: 0.12,
    cites: [{ text: 'Northlight Files video', sourceId: 'src_youtube_essay' }],
    notes: '2,400-comment thread. The top comment correctly notes that no document has been posted.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'SPECULATION',
        summary: 'Community discussion treating the video reconstruction as the primary document.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_viral_post',
    url: `${D}/social/post/1782299110`,
    title: '“Three labs. Same result. Nobody is talking about this.”',
    publisher: 'Social post (2.1M views)',
    author: null,
    publicationDate: '2024-02-21',
    sourceType: 'social_post',
    verification: 'VERIFIED',
    reliabilityOverride: 0.1,
    cites: [{ text: 'CryptidWire', sourceId: 'src_cryptidwire' }],
    notes: 'The single largest driver of traffic to the claim. Links to the aggregator, not to any document.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'SPECULATION',
        summary: 'Viral restatement of the aggregator headline.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_tiktok_clip',
    url: `${D}/social/clip/8830021`,
    title: '60-second explainer: the primate DNA story',
    publisher: 'Short-form video clip',
    author: null,
    publicationDate: '2024-02-23',
    sourceType: 'social_post',
    verification: 'VERIFIED',
    reliabilityOverride: 0.1,
    cites: [{ text: 'the viral thread', sourceId: 'src_viral_post' }],
    notes: 'Condenses the viral post. No sourcing shown on screen.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'SPECULATION',
        summary: 'Short-form restatement of the viral post.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_northern_journal',
    url: `${D}/northern-journal/primate-dna-what-we-know`,
    title: 'Primate DNA: what we know so far',
    publisher: 'The Northern Journal',
    author: null,
    publicationDate: '2024-03-02',
    sourceType: 'blog',
    verification: 'VERIFIED',
    reliabilityOverride: 0.25,
    cites: [
      { text: 'the viral thread', sourceId: 'src_viral_post' },
      { text: 'Global Mystery Digest', sourceId: 'src_mystery_digest' },
    ],
    notes: 'Cites Global Mystery Digest, which in turn cites this article — a closed loop between the two outlets.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary: 'Summary article whose only cited corroboration is an outlet that cites this article back.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_mystery_digest',
    url: `${D}/mystery-digest/labs-independently-verified`,
    title: 'Independently verified: the primate sequence',
    publisher: 'Global Mystery Digest',
    author: null,
    publicationDate: '2024-03-05',
    sourceType: 'blog',
    verification: 'VERIFIED',
    reliabilityOverride: 0.2,
    retracted: true,
    cites: [{ text: 'The Northern Journal', sourceId: 'src_northern_journal' }],
    notes:
      'Withdrawn on 20 September 2024 with an editor’s note stating the outlet could not substantiate the word “independently”.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary: 'Asserted independent verification, then withdrew the article.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'src_hollowell_preprint',
    url: `${D}/preprints/hollowell-2024-mitochondrial`,
    title: 'Mitochondrial divergence in an unclassified North American primate',
    publisher: 'Open Preprint Archive',
    author: 'M. Hollowell',
    publicationDate: '2024-04-18',
    sourceType: 'preprint',
    verification: 'VERIFIED',
    reliabilityOverride: 0.55,
    cites: [{ text: 'Whitcombe Genomics report 4471', sourceId: 'src_lab_report_4471' }],
    notes:
      'Not peer reviewed. Reports one sequencing run by the author. Does not name the other two laboratories and does not include negative controls.',
    evidence: [
      {
        evidenceType: 'laboratory_result',
        directness: 'direct',
        quality: 'moderate',
        stance: 'supports',
        epistemicStatus: 'CLAIM',
        summary:
          'Reports a mitochondrial sequence the author could not match to a reference primate genome.',
        excerpt:
          '“The consensus sequence returned no match above 94% identity against the reference set used in this study.”',
      },
      {
        evidenceType: 'absence_of_record',
        directness: 'direct',
        quality: 'moderate',
        stance: 'contradicts',
        epistemicStatus: 'FACT',
        summary:
          'The preprint documents one laboratory run by the author, not three independent confirmations — the paper itself does not support the claim made about it.',
        excerpt: '“Analysis was performed at a single facility; replication is left to future work.”',
      },
    ],
  },

  // -- Family B: an independent replication attempt --------------------------
  {
    id: 'src_kwan_replication',
    url: `${D}/journals/comparative-genomics/kwan-2024`,
    title: 'Failure to replicate a reported unclassified primate mitochondrial sequence',
    publisher: 'Journal of Comparative Genomics',
    author: 'L. Kwan, R. Adeyemi, P. Sørensen',
    publicationDate: '2024-09-12',
    sourceType: 'peer_reviewed',
    verification: 'VERIFIED',
    reliabilityOverride: 0.93,
    notes:
      'Peer-reviewed replication attempt using a split of the same material, with contamination controls published in full.',
    evidence: [
      {
        evidenceType: 'laboratory_result',
        directness: 'direct',
        quality: 'strong',
        stance: 'contradicts',
        epistemicStatus: 'FACT',
        summary:
          'Independent sequencing of a split of the same material resolved to American black bear with human handling contamination.',
        excerpt:
          '“All three extractions resolved to Ursus americanus, with a secondary human component consistent with handling contamination.”',
      },
    ],
  },
  {
    id: 'src_meridian_newswire',
    url: `${D}/meridian/primate-dna-replication-fails`,
    title: 'Replication attempt finds bear DNA in “unknown primate” sample',
    publisher: 'Meridian Newswire',
    author: 'S. Okonjo',
    publicationDate: '2024-09-13',
    sourceType: 'wire_service',
    verification: 'VERIFIED',
    reliabilityOverride: 0.85,
    cites: [{ text: 'Journal of Comparative Genomics', sourceId: 'src_kwan_replication' }],
    notes: 'Wire report of the replication paper. Quotes Hollowell’s response.',
    evidence: [
      {
        evidenceType: 'documentary_record',
        directness: 'indirect',
        quality: 'strong',
        stance: 'contradicts',
        epistemicStatus: 'CLAIM',
        summary: 'Reports the replication failure and Hollowell’s statement that the split sample was “degraded”.',
        excerpt:
          '“Hollowell said the material supplied for replication had degraded. The authors said the controls rule that out.”',
      },
    ],
  },

  // -- Family C: the named institution answering for itself -------------------
  {
    id: 'src_university_statement',
    url: `${D}/university-northern-cascadia/statement-2024-03-08`,
    title: 'Statement regarding reports of primate genetic analysis',
    publisher: 'University of Northern Cascadia',
    author: null,
    publicationDate: '2024-03-08',
    sourceType: 'press_release',
    verification: 'VERIFIED',
    reliabilityOverride: 0.75,
    notes:
      'First-party statement from one of the institutions publicly named as a confirming laboratory.',
    evidence: [
      {
        evidenceType: 'documentary_record',
        directness: 'direct',
        quality: 'strong',
        stance: 'contradicts',
        epistemicStatus: 'FACT',
        summary:
          'The university states it never received, handled or analysed the sample, and did not authorise its name being used.',
        excerpt:
          '“No sample of this description has been received by this institution, and no analysis of it has been performed here.”',
      },
    ],
  },
  {
    id: 'src_local_broadcast',
    url: `${D}/kcnw/university-denies-involvement`,
    title: 'University denies involvement in primate DNA claim',
    publisher: 'KCNW Regional News',
    author: null,
    publicationDate: '2024-03-09',
    sourceType: 'news_article',
    verification: 'VERIFIED',
    reliabilityOverride: 0.55,
    cites: [{ text: 'University of Northern Cascadia statement', sourceId: 'src_university_statement' }],
    notes: 'Local coverage of the university statement.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'indirect',
        quality: 'moderate',
        stance: 'contradicts',
        epistemicStatus: 'CLAIM',
        summary: 'Reports the denial and notes that the other two laboratories remain unnamed.',
        excerpt: null,
      },
    ],
  },
];

export const CRYPTID_DNA_CASE: RetrievalResult = {
  mode: 'DEMONSTRATION',
  adapter: 'fixture-corpus',
  note:
    'This is a built-in demonstration case. Every source, person, outlet and document in it is fictional, and every link uses the reserved .invalid domain so that none of them can resolve. Nothing here was retrieved from the web.',
  isDemonstration: true,
  demoId: 'cryptid-dna',
  sources,
  entities: [
    { name: 'Marisa Hollowell', kind: 'person', role: 'Researcher who first made the claim' },
    { name: 'Whitcombe Genomics', kind: 'institution', role: 'Laboratory named as the source of report 4471' },
    {
      name: 'University of Northern Cascadia',
      kind: 'institution',
      role: 'Named publicly as a confirming laboratory; denies any involvement',
    },
    { name: 'Journal of Comparative Genomics', kind: 'publication', role: 'Published the replication attempt' },
    { name: 'Sample Analysis Report 4471', kind: 'artifact', role: 'The document the whole claim rests on' },
  ],
  events: [
    {
      date: '2023-11',
      approximate: true,
      description: 'Hair and tissue material said to have been collected in the Cascade foothills. No collection log has been produced.',
      sourceIds: ['src_hollowell_podcast'],
      confidence: 'LOW',
      kind: 'origin',
    },
    {
      date: '2024-09-20',
      approximate: false,
      description: 'Global Mystery Digest withdraws its article, stating it could not substantiate the word “independently”.',
      sourceIds: ['src_mystery_digest'],
      confidence: 'HIGH',
      kind: 'correction',
    },
  ],
};

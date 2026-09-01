import type { RetrievalResult, RetrievedSource } from '@/core/research/types';

/**
 * DEMONSTRATION CASE — entirely fictional.
 *
 * The deliberate counterweight to the cryptid case. ProofHound is not a
 * debunking machine: run against a *well-evidenced* claim it should say so, and
 * this corpus is built so that it does. The narrow, checkable claim — a
 * fragment was accessioned, and two laboratories analysed it and found ordinary
 * composition — is carried by first-party documents and independent laboratory
 * work, and it scores accordingly.
 *
 * The Source DNA panel still earns its place: six of the nine sources form one
 * chain in which an anonymous quote from a magazine feature is progressively
 * re-attributed to the government filing itself, which never said it.
 *
 * 9 apparent sources → 3 independent source families.
 */

const D = 'https://demo.proofhound.invalid';

const sources: RetrievedSource[] = [
  // -- Family A: the custody filing and its coverage --------------------------
  {
    id: 'uap_custody_filing',
    url: `${D}/records/materials-custody-filing-2022`,
    title: 'Materials Custody Filing 22-0117 (redacted release)',
    publisher: 'Office of Anomalous Materials Review',
    author: null,
    publicationDate: '2022-06-14',
    sourceType: 'government_document',
    verification: 'VERIFIED',
    reliabilityOverride: 0.8,
    notes:
      'Released with redactions. Confirms that a metallic fragment was accessioned and assigned a custody number. Says nothing about its origin.',
    evidence: [
      {
        evidenceType: 'documentary_record',
        directness: 'direct',
        quality: 'strong',
        stance: 'supports',
        epistemicStatus: 'FACT',
        summary:
          'A metallic fragment was accessioned under custody number 22-0117 by the office named, and held for compositional analysis.',
        excerpt: '“Item 22-0117: metallic fragment, 41 g, received and held pending compositional analysis.”',
      },
    ],
  },
  {
    id: 'uap_wire_report',
    url: `${D}/meridian/custody-filing-released`,
    title: 'Redacted filing confirms fragment held for analysis',
    publisher: 'Meridian Newswire',
    author: 'S. Okonjo',
    publicationDate: '2022-06-16',
    sourceType: 'wire_service',
    verification: 'VERIFIED',
    reliabilityOverride: 0.85,
    cites: [{ text: 'Materials Custody Filing 22-0117', sourceId: 'uap_custody_filing' }],
    notes: 'Accurate report of what the filing does and does not say.',
    evidence: [
      {
        evidenceType: 'documentary_record',
        directness: 'indirect',
        quality: 'strong',
        stance: 'supports',
        epistemicStatus: 'FACT',
        summary: 'Reports the accession and notes explicitly that the filing makes no claim about origin.',
        excerpt: '“The filing records receipt of the item. It does not characterise where it came from.”',
      },
    ],
  },
  {
    id: 'uap_magazine_feature',
    url: `${D}/atlas-quarterly/the-fragment`,
    title: 'The fragment they cannot explain',
    publisher: 'Atlas Quarterly',
    author: 'D. Renn',
    publicationDate: '2022-08-01',
    sourceType: 'news_article',
    verification: 'VERIFIED',
    reliabilityOverride: 0.6,
    anonymousAttribution: true,
    cites: [{ text: 'Meridian Newswire report', sourceId: 'uap_wire_report' }],
    notes:
      'Where the phrase “cannot be of terrestrial origin” first appears, attributed to an unnamed official rather than to the filing.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'weak',
        stance: 'supports',
        epistemicStatus: 'ALLEGATION',
        summary:
          'An unnamed official is quoted describing the fragment as impossible to manufacture terrestrially — a characterisation that appears nowhere in the filing and is contradicted by the later analyses.',
        excerpt: '“One official, who was not authorised to speak publicly, called the isotope ratios ‘not from here’.”',
      },
    ],
  },
  {
    id: 'uap_aggregator',
    url: `${D}/cryptidwire/non-terrestrial-alloy`,
    title: 'GOVERNMENT DOCUMENT CONFIRMS NON-TERRESTRIAL ALLOY',
    publisher: 'CryptidWire',
    author: null,
    publicationDate: '2022-08-03',
    sourceType: 'aggregator',
    verification: 'VERIFIED',
    reliabilityOverride: 0.15,
    cites: [{ text: 'Atlas Quarterly', sourceId: 'uap_magazine_feature' }],
    notes: 'Attributes the anonymous quote to the government filing itself. This is the point where the claim changes meaning.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary:
          'Presents an anonymous quote from a magazine feature as the content of an official document.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'uap_viral_thread',
    url: `${D}/social/post/9930481`,
    title: '“It is in the official filing. Read it yourself.”',
    publisher: 'Social post (4.4M views)',
    author: null,
    publicationDate: '2022-08-04',
    sourceType: 'social_post',
    verification: 'VERIFIED',
    reliabilityOverride: 0.1,
    cites: [{ text: 'CryptidWire', sourceId: 'uap_aggregator' }],
    notes: 'Links to the aggregator while telling readers to read the filing.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'SPECULATION',
        summary: 'Viral restatement asserting the filing says something it does not say.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'uap_video_breakdown',
    url: `${D}/video/filing-breakdown`,
    title: 'Line-by-line breakdown of filing 22-0117',
    publisher: 'Northlight Files',
    author: null,
    publicationDate: '2022-08-11',
    sourceType: 'video',
    verification: 'VERIFIED',
    reliabilityOverride: 0.25,
    cites: [{ text: 'the viral thread', sourceId: 'uap_viral_thread' }],
    notes: 'Reads the filing aloud, then attributes the magazine’s anonymous quote to it.',
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'unusable',
        stance: 'supports',
        epistemicStatus: 'INTERPRETATION',
        summary: 'Conflates the document’s text with the magazine’s anonymous characterisation.',
        excerpt: null,
      },
    ],
  },

  // -- Family B: the actual compositional analysis ----------------------------
  {
    id: 'uap_materials_paper',
    url: `${D}/journals/applied-materials/isotope-2023`,
    title: 'Isotopic and compositional analysis of accessioned fragment 22-0117',
    publisher: 'Journal of Applied Materials Analysis',
    author: 'H. Nakamura, E. Vargas',
    publicationDate: '2023-04-27',
    sourceType: 'peer_reviewed',
    verification: 'VERIFIED',
    reliabilityOverride: 0.92,
    notes: 'Peer-reviewed compositional analysis of the accessioned item, with full method and instrument calibration.',
    evidence: [
      {
        evidenceType: 'laboratory_result',
        directness: 'direct',
        quality: 'strong',
        stance: 'supports',
        epistemicStatus: 'FACT',
        summary:
          'Isotope ratios fall within the terrestrial range, and the layering is consistent with an industrial magnesium–zinc process in use since the 1940s.',
        excerpt:
          '“All measured ratios fall within terrestrial variation. The layering is consistent with known industrial production.”',
      },
      {
        evidenceType: 'statistical_analysis',
        directness: 'direct',
        quality: 'strong',
        stance: 'supports',
        epistemicStatus: 'FACT',
        summary: 'The reported “anomalous” purity is within two standard deviations of commercial reference samples.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'uap_followup_analysis',
    url: `${D}/journals/applied-materials/replication-2023`,
    title: 'Independent re-measurement of fragment 22-0117',
    publisher: 'Journal of Applied Materials Analysis',
    author: 'P. Aldridge',
    publicationDate: '2023-11-02',
    sourceType: 'peer_reviewed',
    verification: 'VERIFIED',
    reliabilityOverride: 0.9,
    cites: [{ text: 'Nakamura & Vargas 2023', sourceId: 'uap_materials_paper' }],
    // Cites the earlier paper but re-measures the fragment itself, so it is a
    // genuinely separate origin rather than a repetition of one.
    independentOfParents: true,
    notes: 'Second laboratory, same conclusion, different instrument and independently collected measurements.',
    evidence: [
      {
        evidenceType: 'laboratory_result',
        directness: 'direct',
        quality: 'strong',
        stance: 'supports',
        epistemicStatus: 'FACT',
        summary: 'A second laboratory reproduced the terrestrial isotope result on a different instrument.',
        excerpt: null,
      },
    ],
  },
  {
    id: 'uap_congressional_ref',
    url: `${D}/hearings/oversight-transcript-2023-05`,
    title: 'Oversight hearing transcript, 11 May 2023 (extract)',
    publisher: 'Committee on Oversight',
    author: null,
    publicationDate: '2023-05-11',
    sourceType: 'government_document',
    verification: 'UNVERIFIED_SOURCE',
    reliabilityOverride: 0.45,
    cites: [{ text: 'Materials Custody Filing 22-0117', sourceId: 'uap_custody_filing' }],
    notes:
      'Only a circulating extract could be located; the full transcript could not be retrieved to confirm the surrounding context.',
    evidence: [
      {
        evidenceType: 'documentary_record',
        directness: 'indirect',
        quality: 'weak',
        stance: 'neutral',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary: 'An extract in which a member asks about item 22-0117 and receives no substantive answer.',
        excerpt: null,
      },
    ],
  },
];

export const UAP_ALLOY_CASE: RetrievalResult = {
  mode: 'DEMONSTRATION',
  adapter: 'fixture-corpus',
  note:
    'This is a built-in demonstration case. Every source, person, outlet and document in it is fictional, and every link uses the reserved .invalid domain so that none of them can resolve. Nothing here was retrieved from the web.',
  isDemonstration: true,
  demoId: 'uap-alloy',
  sources,
  entities: [
    { name: 'Office of Anomalous Materials Review', kind: 'organization', role: 'Holder of the accessioned fragment' },
    { name: 'Fragment 22-0117', kind: 'artifact', role: 'The material the claim turns on' },
    { name: 'Journal of Applied Materials Analysis', kind: 'publication', role: 'Published both compositional analyses' },
    { name: 'Atlas Quarterly', kind: 'publication', role: 'Where the “non-terrestrial” wording first appears' },
  ],
  events: [
    {
      date: '2022-08-03',
      approximate: false,
      description:
        'The claim changes meaning: an anonymous quote from a magazine feature is re-attributed to the official filing itself.',
      sourceIds: ['uap_aggregator', 'uap_magazine_feature'],
      confidence: 'HIGH',
      kind: 'amplification',
    },
  ],
};

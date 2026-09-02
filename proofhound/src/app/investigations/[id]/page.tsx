import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Workspace } from '@/components/workspace/workspace';
import { getStore } from '@/core/store';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const investigation = await getStore().get(id);
  if (!investigation) return { title: 'Investigation not found — ProofHound' };
  return {
    title: `${investigation.claim.normalized.slice(0, 70)} — ProofHound`,
    description: investigation.score.explanation,
  };
}

export default async function InvestigationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const investigation = await getStore().get(id);
  if (!investigation) notFound();
  return <Workspace investigation={investigation} />;
}

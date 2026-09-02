import { NextResponse } from 'next/server';
import { getStore } from '@/core/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const investigation = await getStore().get(id);
  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found.' }, { status: 404 });
  }
  return NextResponse.json({ investigation });
}

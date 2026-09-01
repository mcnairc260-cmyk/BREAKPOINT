import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { StageRecord } from '@/core/types';
import { runInvestigation } from '@/core/pipeline';
import { getStore } from '@/core/store';
import { DEMO_CASE_IDS } from '@/core/research';

/**
 * Investigation creation.
 *
 * Runs on the server so that provider keys stay on the server. The response is
 * Server-Sent Events: each pipeline stage is reported as it completes, which is
 * how the UI shows real progress rather than an invented percentage.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  input: z.string().trim().max(4000).default(''),
  demoId: z.enum(DEMO_CASE_IDS as [string, ...string[]]).optional(),
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(): Promise<NextResponse> {
  const rows = await getStore().list(30);
  return NextResponse.json({ investigations: rows });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const { input, demoId } = parsed.data;
  if (!demoId && input.length < 8) {
    return NextResponse.json(
      { error: 'Enter a claim, question or URL of at least 8 characters.' },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sse(event, data)));
      };
      try {
        const investigation = await runInvestigation(input, {
          demoId,
          onStage: (record: StageRecord) => send('stage', record),
        });
        await getStore().save(investigation);
        send('done', { id: investigation.id });
      } catch (error) {
        send('error', {
          message: error instanceof Error ? error.message : 'The investigation failed to run.',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

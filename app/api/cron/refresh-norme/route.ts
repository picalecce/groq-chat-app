import { refreshStaleEntries } from '@/lib/law-cache';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return Response.json({ skipped: true, reason: 'DATABASE_URL non configurato' });
  }

  const result = await refreshStaleEntries();
  return Response.json(result);
}

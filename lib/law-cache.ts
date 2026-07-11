import { neon } from '@neondatabase/serverless';
import { fetchNormattivaArticle, type NormArticle } from '@/lib/normattiva';

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni

let schemaReady: Promise<void> | null = null;

function sql() {
  return neon(process.env.DATABASE_URL!);
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = sql()`
      CREATE TABLE IF NOT EXISTS law_cache (
        urn TEXT PRIMARY KEY,
        titolo TEXT,
        testo TEXT,
        data_inizio_vigenza TEXT,
        data_fine_vigenza TEXT,
        ultimo_controllo TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.then(() => undefined);
  }
  return schemaReady;
}

export type CachedArticle = NormArticle & {
  fromCache: boolean;
  changed?: boolean;
};

export async function getArticle(urn: string): Promise<CachedArticle> {
  await ensureSchema();
  const db = sql();

  const rows = await db`SELECT * FROM law_cache WHERE urn = ${urn}`;
  const cached = rows[0] as
    | {
        titolo: string | null;
        testo: string | null;
        data_inizio_vigenza: string | null;
        data_fine_vigenza: string | null;
        ultimo_controllo: string;
      }
    | undefined;

  const isFresh =
    cached && Date.now() - new Date(cached.ultimo_controllo).getTime() < STALE_MS;

  if (isFresh && cached) {
    return {
      found: true,
      fromCache: true,
      titolo: cached.titolo ?? undefined,
      text: cached.testo ?? undefined,
      dataInizioVigenza: cached.data_inizio_vigenza ?? undefined,
      dataFineVigenza: cached.data_fine_vigenza ?? undefined,
    };
  }

  const fresh = await fetchNormattivaArticle(urn);

  if (!fresh.found) {
    if (cached) {
      return {
        found: true,
        fromCache: true,
        titolo: cached.titolo ?? undefined,
        text: cached.testo ?? undefined,
        dataInizioVigenza: cached.data_inizio_vigenza ?? undefined,
        dataFineVigenza: cached.data_fine_vigenza ?? undefined,
      };
    }
    return { found: false, fromCache: false };
  }

  const changed = Boolean(cached && cached.data_inizio_vigenza !== fresh.dataInizioVigenza);

  await db`
    INSERT INTO law_cache (urn, titolo, testo, data_inizio_vigenza, data_fine_vigenza, ultimo_controllo)
    VALUES (${urn}, ${fresh.titolo ?? null}, ${fresh.text ?? null}, ${fresh.dataInizioVigenza ?? null}, ${fresh.dataFineVigenza ?? null}, now())
    ON CONFLICT (urn) DO UPDATE SET
      titolo = EXCLUDED.titolo,
      testo = EXCLUDED.testo,
      data_inizio_vigenza = EXCLUDED.data_inizio_vigenza,
      data_fine_vigenza = EXCLUDED.data_fine_vigenza,
      ultimo_controllo = now()
  `;

  return { ...fresh, fromCache: false, changed };
}

export async function refreshStaleEntries(maxEntries = 50) {
  await ensureSchema();
  const db = sql();
  const stale = await db`
    SELECT urn FROM law_cache
    WHERE ultimo_controllo < now() - interval '30 days'
    LIMIT ${maxEntries}
  `;

  let checked = 0;
  let changed = 0;
  for (const row of stale as { urn: string }[]) {
    const result = await getArticle(row.urn);
    checked += 1;
    if (result.changed) changed += 1;
  }
  return { checked, changed };
}

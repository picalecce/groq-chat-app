const BASE_URL = 'https://api.normattiva.it/t/normattiva.api/bff-opendata/v1/api/v1';

export type NormAtto = {
  denominazioneAtto: string;
  numeroProvvedimento: string;
  dataEmanazione: string;
  descrizioneAtto: string;
  titoloAtto: string;
};

export type NormArticle = {
  found: boolean;
  titolo?: string;
  sottoTitolo?: string;
  text?: string;
  dataInizioVigenza?: string;
  dataFineVigenza?: string;
};

// Mappa tipo atto (come restituito dalla ricerca) -> slug URN-NIR usato da Normattiva.
// Verificato per "decreto legislativo" con una chiamata reale; gli altri seguono la stessa
// convenzione standard ma non sono stati testati singolarmente.
const ACT_TYPE_SLUGS: Record<string, string> = {
  'LEGGE COSTITUZIONALE': 'legge.costituzionale',
  LEGGE: 'legge',
  'DECRETO LEGISLATIVO': 'decreto.legislativo',
  'DECRETO-LEGGE': 'decreto.legge',
  'DECRETO LEGGE': 'decreto.legge',
  'DECRETO DEL PRESIDENTE DELLA REPUBBLICA': 'decreto.del.presidente.della.repubblica',
  'DECRETO DEL PRESIDENTE DEL CONSIGLIO DEI MINISTRI':
    'decreto.del.presidente.del.consiglio.dei.ministri',
  'REGIO DECRETO': 'regio.decreto',
  'REGIO DECRETO LEGGE': 'regio.decreto.legge',
  'REGIO DECRETO LEGISLATIVO': 'regio.decreto.legislativo',
  COSTITUZIONE: 'costituzione',
  'DECRETO MINISTERIALE': 'decreto.ministeriale',
};

// Codici verificati con una chiamata reale all'API (denominazione, data, numero corretti
// e URN che risponde con testo reale). Bypassano la ricerca libera, che si è dimostrata
// inaffidabile nel restituire l'atto giusto anche per titoli esatti.
export const KNOWN_CODES: Record<string, NormAtto> = {
  codice_della_strada: {
    denominazioneAtto: 'DECRETO LEGISLATIVO',
    numeroProvvedimento: '285',
    dataEmanazione: '1992-04-30',
    descrizioneAtto: 'Nuovo Codice della Strada',
    titoloAtto: 'Nuovo codice della strada',
  },
  codice_civile: {
    denominazioneAtto: 'REGIO DECRETO',
    numeroProvvedimento: '262',
    dataEmanazione: '1942-03-16',
    descrizioneAtto: 'Codice Civile',
    titoloAtto: 'Codice Civile',
  },
  codice_penale: {
    denominazioneAtto: 'REGIO DECRETO',
    numeroProvvedimento: '1398',
    dataEmanazione: '1930-10-19',
    descrizioneAtto: 'Codice Penale',
    titoloAtto: 'Codice Penale',
  },
};

export function buildUrn(atto: NormAtto, articolo?: string): string | null {
  const slug = ACT_TYPE_SLUGS[atto.denominazioneAtto?.toUpperCase().trim()];
  if (!slug) return null;
  const date = atto.dataEmanazione?.slice(0, 10);
  if (!date) return null;
  let urn = `urn:nir:stato:${slug}:${date}`;
  if (atto.numeroProvvedimento) urn += `;${atto.numeroProvvedimento}`;
  if (articolo) urn += `~art${articolo}`;
  return urn;
}

export async function searchNormattiva(query: string, limit = 5): Promise<NormAtto[]> {
  try {
    const res = await fetch(`${BASE_URL}/ricerca/semplice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testoRicerca: query,
        paginazione: { pagina: 0, numeroElementiPerPagina: limit },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.listaAtti ?? []).map((a: Record<string, unknown>) => ({
      denominazioneAtto: a.denominazioneAtto,
      numeroProvvedimento: a.numeroProvvedimento,
      dataEmanazione: a.dataEmanazione,
      descrizioneAtto: a.descrizioneAtto,
      titoloAtto: a.titoloAtto,
    }));
  } catch {
    return [];
  }
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&egrave;/g, 'è')
    .replace(/&eacute;/g, 'é')
    .replace(/&ograve;/g, 'ò')
    .replace(/&agrave;/g, 'à')
    .replace(/&igrave;/g, 'ì')
    .replace(/&ugrave;/g, 'ù')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchNormattivaArticle(urn: string): Promise<NormArticle> {
  try {
    const res = await fetch(`${BASE_URL}/atto/dettaglio-atto-urn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn }),
    });
    if (!res.ok) return { found: false };
    const data = await res.json();
    const atto = data?.data?.atto;
    if (!data.success || !atto?.articoloHtml) return { found: false };
    return {
      found: true,
      titolo: atto.titolo,
      sottoTitolo: atto.sottoTitolo,
      text: htmlToPlainText(atto.articoloHtml),
      dataInizioVigenza: atto.articoloDataInizioVigenza,
      dataFineVigenza: atto.articoloDataFineVigenza,
    };
  } catch {
    return { found: false };
  }
}

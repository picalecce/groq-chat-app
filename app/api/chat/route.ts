import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  streamText,
  generateText,
  tool,
  stepCountIs,
  UIMessage,
  ModelMessage,
  ToolSet,
  convertToModelMessages,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from 'ai';
import { z } from 'zod';
import { getPersona } from '@/lib/personas';
import { searchNormattiva, buildUrn, KNOWN_CODES } from '@/lib/normattiva';
import { getArticle } from '@/lib/law-cache';

function hasImageAttachment(messages: UIMessage[]) {
  return messages.some((m) =>
    m.parts.some((part) => part.type === 'file' && part.mediaType?.startsWith('image/')),
  );
}

const SELF_CRITIQUE_INSTRUCTION =
  'Rivedi criticamente la tua risposta precedente: controlla errori, allucinazioni, riferimenti normativi inventati e lacune. Poi fornisci solo la risposta finale corretta e completa, senza elencare separatamente gli errori trovati.';

const normLookupTools: ToolSet = {
  leggi_codice: tool({
    description:
      "Legge il testo vigente reale di un articolo di uno dei codici principali italiani, verificati e affidabili: usa questo strumento invece di cerca_norma ogni volta che la domanda riguarda uno di questi codici, perché è più affidabile della ricerca libera.",
    inputSchema: z.object({
      codice: z
        .enum(['codice_della_strada', 'codice_civile', 'codice_penale'])
        .describe('Quale codice consultare'),
      articolo: z
        .string()
        .optional()
        .describe('Numero dell\'articolo, es. "142". Se omesso legge l\'inizio del codice.'),
    }),
    execute: async ({ codice, articolo }) => {
      const atto = KNOWN_CODES[codice];
      const urn = buildUrn(atto, articolo);
      if (!urn) return { trovato: false, errore: 'Riferimento interno non valido.' };
      const article = await getArticle(urn);
      if (!article.found) {
        return { trovato: false, errore: 'Articolo non trovato su Normattiva con questo numero.' };
      }
      return {
        trovato: true,
        titolo: article.titolo,
        testo: article.text,
        vigenteDal: article.dataInizioVigenza,
        vigenteFino: article.dataFineVigenza,
        dallaCache: article.fromCache,
      };
    },
  }),
  cerca_norma: tool({
    description:
      'Cerca una norma italiana (legge, decreto) per testo libero sul portale ufficiale Normattiva. Restituisce una lista di atti candidati con tipo, numero e data. Chiamala sempre PRIMA di leggi_norma: attendi il risultato, scegli l\'atto giusto dalla lista, e usa i suoi campi denominazioneAtto/dataEmanazione/numeroProvvedimento esattamente come restituiti (mai un valore inventato o segnaposto) per chiamare leggi_norma.',
    inputSchema: z.object({
      query: z
        .string()
        .describe('Testo di ricerca, es. "codice della strada" o "TUIR redditi impresa"'),
    }),
    execute: async ({ query }) => {
      const results = await searchNormattiva(query);
      if (results.length === 0) return { trovati: 0, risultati: [] };
      return {
        trovati: results.length,
        risultati: results.map((r) => ({
          denominazioneAtto: r.denominazioneAtto,
          numeroProvvedimento: r.numeroProvvedimento,
          dataEmanazione: r.dataEmanazione,
          descrizione: r.descrizioneAtto,
        })),
      };
    },
  }),
  leggi_norma: tool({
    description:
      "Legge il testo vigente reale di un articolo o di un intero atto normativo italiano da Normattiva. Chiamala SOLO dopo aver ricevuto un risultato da cerca_norma, e passa i valori denominazioneAtto/dataEmanazione/numeroProvvedimento esattamente identici a quelli di un atto nella lista dei risultati di cerca_norma. Non inventare, abbreviare o usare segnaposto (es. \"-\") per questi campi: se non li conosci con certezza, chiama prima cerca_norma.",
    inputSchema: z.object({
      denominazioneAtto: z
        .string()
        .describe(
          'Il campo denominazioneAtto esatto di un risultato di cerca_norma, es. "DECRETO LEGISLATIVO". Mai un segnaposto.',
        ),
      dataEmanazione: z
        .string()
        .describe(
          'Il campo dataEmanazione esatto di un risultato di cerca_norma, es. "1992-04-30T00:00:00Z".',
        ),
      numeroProvvedimento: z
        .string()
        .describe('Il campo numeroProvvedimento esatto di un risultato di cerca_norma, es. "285".'),
      articolo: z
        .string()
        .optional()
        .describe(
          "Numero dell'articolo specifico da leggere, se noto, es. \"142\". Se omesso legge l'inizio dell'atto.",
        ),
    }),
    execute: async ({ denominazioneAtto, dataEmanazione, numeroProvvedimento, articolo }) => {
      const urn = buildUrn(
        {
          denominazioneAtto,
          dataEmanazione,
          numeroProvvedimento,
          descrizioneAtto: '',
          titoloAtto: '',
        },
        articolo,
      );
      if (!urn) {
        return {
          trovato: false,
          errore: 'Tipo di atto non riconosciuto, impossibile costruire il riferimento.',
        };
      }
      const article = await getArticle(urn);
      if (!article.found) {
        return { trovato: false, errore: 'Norma non trovata su Normattiva con questi dati.' };
      }
      return {
        trovato: true,
        titolo: article.titolo,
        testo: article.text,
        vigenteDal: article.dataInizioVigenza,
        vigenteFino: article.dataFineVigenza,
        dallaCache: article.fromCache,
      };
    },
  }),
};

export async function POST(req: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'GROQ_API_KEY non configurata. Aggiungila a .env.local.' },
      { status: 500 },
    );
  }

  const groq = createOpenAICompatible({
    name: 'groq',
    apiKey,
    baseURL: process.env.GROQ_API_URL ?? 'https://api.groq.com/openai/v1',
  });

  const {
    messages,
    personaId,
    memory,
  }: { messages: UIMessage[]; personaId?: string; memory?: string } = await req.json();

  const persona = getPersona(personaId);
  const basePrompt =
    persona.id === 'generico' && process.env.SYSTEM_PROMPT
      ? process.env.SYSTEM_PROMPT
      : persona.systemPrompt;
  const systemPrompt = memory?.trim()
    ? `${basePrompt}\n\nNote su questo utente da conversazioni precedenti con questo professionista: ${memory.trim()}`
    : basePrompt;

  const model = hasImageAttachment(messages)
    ? (process.env.GROQ_VISION_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct')
    : (process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant');
  const languageModel = groq(model);
  const modelMessages = await convertToModelMessages(messages);

  const tools = persona.normLookup && process.env.DATABASE_URL ? normLookupTools : undefined;
  const stopWhen = tools ? stepCountIs(6) : undefined;

  if (persona.selfCritique) {
    const draft = await generateText({
      model: languageModel,
      system: systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen,
    });

    const critiqueMessages: ModelMessage[] = [
      ...modelMessages,
      { role: 'assistant', content: draft.text },
      { role: 'user', content: SELF_CRITIQUE_INSTRUCTION },
    ];

    const result = streamText({
      model: languageModel,
      system: systemPrompt,
      messages: critiqueMessages,
      tools,
      stopWhen,
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  }

  const result = streamText({
    model: languageModel,
    system: systemPrompt,
    messages: modelMessages,
    tools,
    stopWhen,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}

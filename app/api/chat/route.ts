import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  streamText,
  generateText,
  tool,
  stepCountIs,
  APICallError,
  RetryError,
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

type ChatModel = ReturnType<ReturnType<typeof createOpenAICompatible>>;

function hasImageAttachment(messages: UIMessage[]) {
  return messages.some((m) =>
    m.parts.some((part) => part.type === 'file' && part.mediaType?.startsWith('image/')),
  );
}

function isRetryableError(error: unknown): boolean {
  // streamText/generateText ritentano già da soli lo STESSO modello (maxRetries) prima di
  // arrendersi: se falliscono tutti i tentativi, avvolgono l'ultimo errore in un RetryError,
  // un tipo diverso da APICallError. Senza questo controllo il fallback su un altro modello
  // non scattava mai per un errore che aveva già esaurito i retry interni (es. quota
  // giornaliera esaurita), che è esattamente il caso in cui serve di più.
  if (RetryError.isInstance(error)) {
    return isRetryableError(error.lastError);
  }
  return APICallError.isInstance(error) && error.isRetryable;
}

// Prova i modelli in ordine; passa al successivo solo su errori transitori
// (rate limit, timeout, 5xx). Usato per generateText (il draft del self-critique).
async function generateTextWithFallback(
  models: ChatModel[],
  opts: Parameters<typeof generateText>[0],
): Promise<{ result: Awaited<ReturnType<typeof generateText>>; model: ChatModel }> {
  let lastError: unknown;
  for (const model of models) {
    try {
      // maxRetries basso: se un modello fallisce conviene passare subito al successivo
      // della catena piuttosto che perdere tempo ritentando lo stesso modello saturo.
      const result = await generateText({ maxRetries: 1, ...opts, model });
      return { result, model };
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err)) throw err;
      console.warn(`[chat] modello '${model.modelId}' non disponibile, provo il successivo`, err);
    }
  }
  console.error('[chat] tutti i modelli della catena hanno fallito (generateText)', lastError);
  throw lastError;
}

// Chunk puramente strutturali che Groq/l'SDK emette sempre all'inizio, prima
// che la vera chiamata HTTP al modello sia anche solo tentata. Un fallimento
// (es. 429, modello inesistente) NON arriva come chunk separato: fa fallire
// (reject) la lettura successiva. Per questo continuiamo a leggere, con ogni
// singola lettura protetta da try/catch, finché non vediamo contenuto vero
// (testo, tool call, ecc.), un errore o la fine dello stream.
const STREAM_PREAMBLE_TYPES = new Set(['start', 'start-step']);

// Passa al modello successivo solo su errori transitori (rate limit, timeout,
// 5xx) rilevati PRIMA che sia stato inoltrato contenuto reale al client:
// finché almeno un modello della catena risponde, l'utente non vede un errore.
async function streamTextWithFallback(
  models: ChatModel[],
  opts: Parameters<typeof streamText>[0],
): Promise<{ stream: ReadableStream; model: ChatModel; usedFallback: boolean }> {
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLast = i === models.length - 1;
    const result = streamText({ maxRetries: 1, ...opts, model });
    const reader = result.stream.getReader();

    const buffered: unknown[] = [];
    let errorValue: unknown;
    let hasError = false;
    let errorAlreadyBuffered = false;
    let streamEnded = false;

    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        hasError = true;
        errorValue = err;
        break;
      }
      if (chunk.done) {
        streamEnded = true;
        break;
      }
      buffered.push(chunk.value);
      const part = chunk.value as { type: string; error?: unknown };
      if (part.type === 'error') {
        hasError = true;
        errorAlreadyBuffered = true;
        errorValue = part.error;
        break;
      }
      if (!STREAM_PREAMBLE_TYPES.has(part.type)) break; // contenuto vero: smettiamo di bufferizzare
    }

    if (hasError) {
      try {
        reader.cancel();
      } catch {
        // no-op: la lettura ha già fallito, l'annullamento è solo pulizia
      }
      lastError = errorValue;
      if (isRetryableError(errorValue) && !isLast) {
        console.warn(`[chat] modello '${model.modelId}' non disponibile, provo il successivo`, errorValue);
        continue;
      }
      console.error(
        `[chat] modello '${model.modelId}' ha fallito, nessun altro in catena`,
        errorValue,
      );
      if (!errorAlreadyBuffered) buffered.push({ type: 'error', error: errorValue });
      streamEnded = true;
    }

    const shouldContinuePulling = !hasError && !streamEnded;
    const stream = new ReadableStream({
      start(controller) {
        for (const c of buffered) controller.enqueue(c);
        if (!shouldContinuePulling) controller.close();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          controller.enqueue({ type: 'error', error: err });
          controller.close();
        }
      },
      cancel: () => reader.cancel(),
    });

    return { stream, model, usedFallback: i > 0 };
  }
  throw lastError;
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

  const isVision = hasImageAttachment(messages);
  const modelIds = isVision
    ? [process.env.GROQ_VISION_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct']
    : Array.from(
        new Set([
          process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
          process.env.GROQ_FALLBACK_MODEL ?? 'openai/gpt-oss-120b',
        ]),
      );
  const models = modelIds.map((id) => groq(id));
  const modelMessages = await convertToModelMessages(messages);

  const tools = persona.normLookup && process.env.DATABASE_URL ? normLookupTools : undefined;
  const stopWhen = tools ? stepCountIs(6) : undefined;

  if (persona.selfCritique) {
    const { result: draft, model: draftModel } = await generateTextWithFallback(models, {
      model: models[0],
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

    // Riparte dal modello che ha appena risposto, per evitare di ritentare
    // inutilmente quello che sappiamo essere già saturo in questa richiesta.
    const orderedModels = [draftModel, ...models.filter((m) => m !== draftModel)];
    const { stream, usedFallback: draftFallbackForFinalCall } = await streamTextWithFallback(
      orderedModels,
      {
        model: orderedModels[0],
        system: systemPrompt,
        messages: critiqueMessages,
        tools,
        stopWhen,
      },
    );
    // "usedFallback" deve riflettere l'intero scambio (bozza + revisione), non solo
    // se QUESTA chiamata ha dovuto ritentare: se la bozza aveva già scartato il
    // modello principale, l'utente non ha comunque ricevuto la risposta del
    // modello principale, anche se la chiamata finale è partita subito da quello buono.
    const usedFallback = draftModel !== models[0] || draftFallbackForFinalCall;

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream,
        messageMetadata: ({ part }) =>
          part.type === 'finish' ? { usedFallback } : undefined,
      }),
    });
  }

  const { stream, usedFallback } = await streamTextWithFallback(models, {
    model: models[0],
    system: systemPrompt,
    messages: modelMessages,
    tools,
    stopWhen,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream,
      messageMetadata: ({ part }) => (part.type === 'finish' ? { usedFallback } : undefined),
    }),
  });
}

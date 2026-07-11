import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const MAX_MEMORY_CHARS = 1000;

export async function POST(req: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'GROQ_API_KEY non configurata.' }, { status: 500 });
  }

  const {
    personaLabel,
    existingMemory,
    question,
    answer,
  }: {
    personaLabel: string;
    existingMemory?: string;
    question: string;
    answer: string;
  } = await req.json();

  if (!question?.trim() || !answer?.trim()) {
    return Response.json({ memory: existingMemory ?? '' });
  }

  const groq = createOpenAICompatible({
    name: 'groq',
    apiKey,
    baseURL: process.env.GROQ_API_URL ?? 'https://api.groq.com/openai/v1',
  });

  const prompt = `Sei un sistema di estrazione memoria per un assistente "${personaLabel}".
Memoria attuale su questo utente: ${existingMemory?.trim() ? `"${existingMemory.trim()}"` : 'nessuna'}

Nuovo scambio:
Utente: ${question}
Assistente: ${answer}

Aggiorna la memoria: mantieni solo fatti stabili e utili per conversazioni future con questo professionista (dati rilevanti, preferenze, progetti in corso, dettagli tecnici del caso). Scarta dettagli irrilevanti o transitori. Se non c'è nulla di nuovo da ricordare, restituisci la memoria attuale invariata. Rispondi SOLO con il testo della memoria aggiornata, massimo ${MAX_MEMORY_CHARS} caratteri, senza commenti o introduzioni. Se non c'è nulla da ricordare in assoluto, rispondi con una stringa vuota.`;

  try {
    const result = await generateText({
      model: groq(process.env.GROQ_MEMORY_MODEL ?? 'llama-3.1-8b-instant'),
      prompt,
    });
    const memory = result.text.trim().slice(0, MAX_MEMORY_CHARS);
    return Response.json({ memory });
  } catch {
    return Response.json({ memory: existingMemory ?? '' });
  }
}

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  streamText,
  generateText,
  UIMessage,
  ModelMessage,
  convertToModelMessages,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from 'ai';
import { getPersona } from '@/lib/personas';

function hasImageAttachment(messages: UIMessage[]) {
  return messages.some((m) =>
    m.parts.some((part) => part.type === 'file' && part.mediaType?.startsWith('image/')),
  );
}

const SELF_CRITIQUE_INSTRUCTION =
  'Rivedi criticamente la tua risposta precedente: controlla errori, allucinazioni, riferimenti normativi inventati e lacune. Poi fornisci solo la risposta finale corretta e completa, senza elencare separatamente gli errori trovati.';

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

  if (persona.selfCritique) {
    const draft = await generateText({
      model: languageModel,
      system: systemPrompt,
      messages: modelMessages,
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
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  }

  const result = streamText({
    model: languageModel,
    system: systemPrompt,
    messages: modelMessages,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}

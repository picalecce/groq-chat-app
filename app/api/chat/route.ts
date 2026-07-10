import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  streamText,
  UIMessage,
  convertToModelMessages,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from 'ai';
import { getPersona } from '@/lib/personas';

function hasImageAttachment(messages: UIMessage[]) {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  return (
    lastUserMessage?.parts.some(
      (part) => part.type === 'file' && part.mediaType?.startsWith('image/'),
    ) ?? false
  );
}

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
  }: { messages: UIMessage[]; personaId?: string } = await req.json();

  const persona = getPersona(personaId);
  const systemPrompt =
    persona.id === 'generico' && process.env.SYSTEM_PROMPT
      ? process.env.SYSTEM_PROMPT
      : persona.systemPrompt;

  const model = hasImageAttachment(messages)
    ? (process.env.GROQ_VISION_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct')
    : (process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant');

  const result = streamText({
    model: groq(model),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}

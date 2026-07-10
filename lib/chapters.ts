import type { UIMessage } from 'ai';

export type Chapter = {
  id: string;
  title: string;
  createdAt: number;
  messages: UIMessage[];
};

const chaptersKey = (personaId: string) => `groq-chat-chapters-${personaId}`;
const activeChapterKey = (personaId: string) => `groq-chat-active-chapter-${personaId}`;
const legacyHistoryKey = (personaId: string) => `groq-chat-history-${personaId}`;

export function loadChapters(personaId: string): Chapter[] {
  const raw = localStorage.getItem(chaptersKey(personaId));
  if (raw) {
    try {
      return JSON.parse(raw) as Chapter[];
    } catch {
      return [];
    }
  }

  const legacy = localStorage.getItem(legacyHistoryKey(personaId));
  if (legacy) {
    try {
      const messages = JSON.parse(legacy) as UIMessage[];
      if (messages.length > 0) {
        const migrated: Chapter[] = [
          {
            id: crypto.randomUUID(),
            title: 'Cronologia precedente',
            createdAt: Date.now(),
            messages,
          },
        ];
        localStorage.setItem(chaptersKey(personaId), JSON.stringify(migrated));
        localStorage.removeItem(legacyHistoryKey(personaId));
        return migrated;
      }
    } catch {
      // ignore corrupted legacy history
    }
  }

  return [];
}

export function saveChapters(personaId: string, chapters: Chapter[]) {
  localStorage.setItem(chaptersKey(personaId), JSON.stringify(chapters));
}

export function getActiveChapterId(personaId: string): string | null {
  return localStorage.getItem(activeChapterKey(personaId));
}

export function setActiveChapterId(personaId: string, chapterId: string) {
  localStorage.setItem(activeChapterKey(personaId), chapterId);
}

export function chapterTranscript(chapter: Chapter): string {
  const lines: string[] = [];
  for (const message of chapter.messages) {
    const role = message.role === 'user' ? 'Utente' : 'Assistente';
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => ('text' in part ? part.text : ''))
      .join(' ')
      .trim();
    if (text) {
      lines.push(`${role}: ${text}`);
    }
  }
  return lines.join('\n\n');
}

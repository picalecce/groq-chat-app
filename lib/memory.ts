const memoryKey = (personaId: string) => `groq-chat-memory-${personaId}`;

export function loadMemory(personaId: string): string {
  return localStorage.getItem(memoryKey(personaId)) ?? '';
}

export function saveMemory(personaId: string, memory: string) {
  if (memory.trim()) {
    localStorage.setItem(memoryKey(personaId), memory.trim());
  } else {
    localStorage.removeItem(memoryKey(personaId));
  }
}

export function clearMemory(personaId: string) {
  localStorage.removeItem(memoryKey(personaId));
}

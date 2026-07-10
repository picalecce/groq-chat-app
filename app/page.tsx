'use client';

import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState } from 'react';
import type { FileUIPart, UIMessage } from 'ai';
import { DEFAULT_PERSONA_ID, getPersona, personasByCategory } from '@/lib/personas';

const historyKey = (personaId: string) => `groq-chat-history-${personaId}`;
const LEGACY_STORAGE_KEY = 'groq-chat-history';

const DOC_EXTENSIONS = ['.pdf', '.docx', '.txt'];

function isImagePart(part: UIMessage['parts'][number]) {
  return part.type === 'file' && part.mediaType?.startsWith('image/');
}

function isDocPart(part: UIMessage['parts'][number]) {
  return (
    part.type === 'file' &&
    !part.mediaType?.startsWith('image/') &&
    DOC_EXTENSIONS.some((ext) => part.filename?.toLowerCase().endsWith(ext))
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function textToDataUrl(text: string) {
  const base64 = btoa(unescape(encodeURIComponent(text)));
  return `data:text/plain;base64,${base64}`;
}

export default function Chat() {
  const [input, setInput] = useState('');
  const [activePersonaId, setActivePersonaId] = useState(DEFAULT_PERSONA_ID);
  const [pendingFiles, setPendingFiles] = useState<FileUIPart[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedRef = useRef(false);

  const { messages, sendMessage, status, error, setMessages } = useChat();

  useEffect(() => {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && !localStorage.getItem(historyKey(DEFAULT_PERSONA_ID))) {
      localStorage.setItem(historyKey(DEFAULT_PERSONA_ID), legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }

    const saved = localStorage.getItem(historyKey(DEFAULT_PERSONA_ID));
    if (saved) {
      try {
        setMessages(JSON.parse(saved) as UIMessage[]);
      } catch {
        // ignore corrupted history
      }
    }
    hydratedRef.current = true;
  }, [setMessages]);

  useEffect(() => {
    if (hydratedRef.current) {
      localStorage.setItem(historyKey(activePersonaId), JSON.stringify(messages));
    }
  }, [messages, activePersonaId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function selectPersona(id: string) {
    setSidebarOpen(false);
    if (id === activePersonaId) return;
    setActivePersonaId(id);
    const saved = localStorage.getItem(historyKey(id));
    try {
      setMessages(saved ? (JSON.parse(saved) as UIMessage[]) : []);
    } catch {
      setMessages([]);
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    setAttachError(null);
    setAttaching(true);

    try {
      for (const file of files) {
        const name = file.name.toLowerCase();

        if (file.type.startsWith('image/')) {
          const url = await readFileAsDataUrl(file);
          setPendingFiles((prev) => [
            ...prev,
            { type: 'file', filename: file.name, mediaType: file.type, url },
          ]);
          continue;
        }

        if (name.endsWith('.txt')) {
          const url = await readFileAsDataUrl(file);
          setPendingFiles((prev) => [
            ...prev,
            { type: 'file', filename: file.name, mediaType: 'text/plain', url },
          ]);
          continue;
        }

        if (name.endsWith('.pdf') || name.endsWith('.docx')) {
          const formData = new FormData();
          formData.append('file', file);
          const res = await fetch('/api/extract', { method: 'POST', body: formData });
          const data = await res.json();
          if (!res.ok) {
            setAttachError(data.error ?? `Impossibile leggere ${file.name}.`);
            continue;
          }
          setPendingFiles((prev) => [
            ...prev,
            {
              type: 'file',
              filename: file.name,
              mediaType: 'text/plain',
              url: textToDataUrl(data.text),
            },
          ]);
          continue;
        }

        setAttachError(`Formato non supportato: ${file.name}`);
      }
    } finally {
      setAttaching(false);
    }
  }

  function removePendingFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() && pendingFiles.length === 0) return;
    sendMessage(
      { text: input, files: pendingFiles.length > 0 ? pendingFiles : undefined },
      { body: { personaId: activePersonaId } },
    );
    setInput('');
    setPendingFiles([]);
  }

  function clearHistory() {
    setMessages([]);
    localStorage.removeItem(historyKey(activePersonaId));
  }

  const activePersona = getPersona(activePersonaId);

  return (
    <div className="flex h-dvh bg-zinc-50 dark:bg-black">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } fixed inset-y-0 left-0 z-30 w-64 transform overflow-y-auto border-r border-zinc-200 bg-zinc-50 transition-transform duration-200 ease-in-out md:static md:translate-x-0 dark:border-zinc-800 dark:bg-black`}
      >
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h1 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Groq Chat
          </h1>
        </div>
        <nav className="flex flex-col gap-4 p-3">
          {personasByCategory().map(([category, personas]) => (
            <div key={category}>
              <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                {category}
              </div>
              <div className="flex flex-col gap-1">
                {personas.map((persona) => (
                  <button
                    key={persona.id}
                    onClick={() => selectPersona(persona.id)}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                      persona.id === activePersonaId
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black'
                        : 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <span>{persona.emoji}</span>
                    <span>{persona.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="text-zinc-500 hover:text-zinc-900 md:hidden dark:hover:text-zinc-100"
              aria-label="Apri elenco professionisti"
            >
              ☰
            </button>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {activePersona.emoji} {activePersona.label}
            </h2>
          </div>
          <button
            onClick={clearHistory}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Cancella cronologia
          </button>
        </header>

        <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${
                message.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                  message.role === 'user'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black'
                    : 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                }`}
              >
                {message.parts.map((part, i) => {
                  if (part.type === 'text') {
                    return <span key={`${message.id}-${i}`}>{part.text}</span>;
                  }
                  if (isImagePart(part) && part.type === 'file') {
                    return (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={`${message.id}-${i}`}
                        src={part.url}
                        alt={part.filename}
                        className="mt-2 max-h-48 rounded-lg"
                      />
                    );
                  }
                  if (isDocPart(part) && part.type === 'file') {
                    return (
                      <div
                        key={`${message.id}-${i}`}
                        className="mt-2 inline-flex items-center gap-1 rounded-lg bg-black/10 px-2 py-1 text-xs dark:bg-white/10"
                      >
                        📄 {part.filename}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          ))}
          {status === 'submitted' && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-zinc-200 px-4 py-2 text-sm text-zinc-500 dark:bg-zinc-800">
                ...
              </div>
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-100 px-4 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              Errore: {error.message}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-200 dark:border-zinc-800 p-4"
      >
        <div className="mx-auto max-w-2xl">
          {attachError && (
            <div className="mb-2 text-xs text-red-600 dark:text-red-400">
              {attachError}
            </div>
          )}
          {pendingFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingFiles.map((file, i) => (
                <div
                  key={`${file.filename}-${i}`}
                  className="flex items-center gap-1 rounded-lg bg-zinc-200 px-2 py-1 text-xs dark:bg-zinc-800"
                >
                  {file.mediaType?.startsWith('image/') ? '🖼️' : '📄'} {file.filename}
                  <button
                    type="button"
                    onClick={() => removePendingFile(i)}
                    className="ml-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              accept="image/*,.pdf,.docx,.txt"
              multiple
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attaching}
              title="Allega documento o immagine"
              className="rounded-full border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
            >
              {attaching ? '...' : '📎'}
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Scrivi un messaggio..."
              className="flex-1 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <button
              type="submit"
              disabled={status === 'submitted' || status === 'streaming' || attaching}
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              Invia
            </button>
          </div>
        </div>
      </form>
      </div>
    </div>
  );
}

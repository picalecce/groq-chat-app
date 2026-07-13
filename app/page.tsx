'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileUIPart, UIMessage } from 'ai';
import { DEFAULT_PERSONA_ID, getPersona, personasByCategory } from '@/lib/personas';
import {
  type Chapter,
  chapterTranscript,
  getActiveChapterId as getStoredActiveChapterId,
  loadChapters,
  saveChapters,
  setActiveChapterId as persistActiveChapterId,
} from '@/lib/chapters';
import { clearMemory, loadMemory, saveMemory } from '@/lib/memory';

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
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [activeChapterId, setActiveChapterIdState] = useState<string | null>(null);
  const [chapterMenuOpen, setChapterMenuOpen] = useState(false);
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [showNewChapterForm, setShowNewChapterForm] = useState(false);
  const [chapterPendingDeleteId, setChapterPendingDeleteId] = useState<string | null>(null);
  const [newChapterName, setNewChapterName] = useState('');
  const [pendingFiles, setPendingFiles] = useState<FileUIPart[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [memoryText, setMemoryText] = useState('');
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedRef = useRef(false);
  const lastSubmitAtRef = useRef(0);
  const activePersonaIdRef = useRef(activePersonaId);
  const activeChapterIdRef = useRef(activeChapterId);

  useEffect(() => {
    activePersonaIdRef.current = activePersonaId;
  }, [activePersonaId]);

  useEffect(() => {
    activeChapterIdRef.current = activeChapterId;
  }, [activeChapterId]);

  const handleChatFinish = useCallback(
    ({
      message,
      messages: allMessages,
      isError,
      isAbort,
    }: {
      message: UIMessage;
      messages: UIMessage[];
      isError: boolean;
      isAbort: boolean;
    }) => {
      if (isAbort) return;

      const personaIdAtFinish = activePersonaIdRef.current;
      const chapterIdAtFinish = activeChapterIdRef.current;
      if (chapterIdAtFinish) {
        setChapters((prev) => {
          const updated = prev.map((c) =>
            c.id === chapterIdAtFinish ? { ...c, messages: allMessages } : c,
          );
          saveChapters(personaIdAtFinish, updated);
          return updated;
        });
      }

      if (isError) return;
      const answer = message.parts
        .filter((p) => p.type === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join(' ')
        .trim();
      if (!answer) return;
      const priorUser = [...allMessages].reverse().find(
        (m) => m.role === 'user' && m.id !== message.id,
      );
      const question = priorUser?.parts
        .filter((p) => p.type === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join(' ')
        .trim();
      if (!question) return;

      const persona = getPersona(personaIdAtFinish);
      const existingMemory = loadMemory(personaIdAtFinish);

      fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaLabel: persona.label, existingMemory, question, answer }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (typeof data.memory === 'string') {
            saveMemory(personaIdAtFinish, data.memory);
            if (activePersonaIdRef.current === personaIdAtFinish) setMemoryText(data.memory);
          }
        })
        .catch(() => {});
    },
    [],
  );

  const { messages, sendMessage, status, error, setMessages, stop, clearError } = useChat({
    onFinish: handleChatFinish,
  });
  const [retryCooldown, setRetryCooldown] = useState(false);

  useEffect(() => {
    if (!error) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRetryCooldown(true);
    const timer = setTimeout(() => setRetryCooldown(false), 3000);
    return () => clearTimeout(timer);
  }, [error]);

  // One-time hydration from localStorage (client-only external system) on mount.
  useEffect(() => {
    const loaded = loadChapters(DEFAULT_PERSONA_ID);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChapters(loaded);
    let chapterId = getStoredActiveChapterId(DEFAULT_PERSONA_ID);
    if (!chapterId || !loaded.some((c) => c.id === chapterId)) {
      chapterId = loaded[0]?.id ?? null;
    }
    setActiveChapterIdState(chapterId);
    const chapter = loaded.find((c) => c.id === chapterId);
    if (chapter) setMessages(chapter.messages);
    setMemoryText(loadMemory(DEFAULT_PERSONA_ID));
    hydratedRef.current = true;
  }, [setMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function selectPersona(id: string) {
    setSidebarOpen(false);
    if (id === activePersonaId) return;
    stop();
    if (error) clearError();
    setActivePersonaId(id);
    const loaded = loadChapters(id);
    setChapters(loaded);
    let chapterId = getStoredActiveChapterId(id);
    if (!chapterId || !loaded.some((c) => c.id === chapterId)) {
      chapterId = loaded[0]?.id ?? null;
    }
    setActiveChapterIdState(chapterId);
    const chapter = loaded.find((c) => c.id === chapterId);
    setMessages(chapter ? chapter.messages : []);
    setPendingFiles([]);
    setMemoryText(loadMemory(id));
    setMemoryPanelOpen(false);
  }

  function selectChapter(id: string) {
    stop();
    if (error) clearError();
    setActiveChapterIdState(id);
    persistActiveChapterId(activePersonaId, id);
    const chapter = chapters.find((c) => c.id === id);
    setMessages(chapter ? chapter.messages : []);
    setChapterMenuOpen(false);
    setChapterPendingDeleteId(null);
  }

  function createChapter() {
    const title = newChapterName.trim();
    if (!title) return;
    stop();
    if (error) clearError();
    const newChapter: Chapter = {
      id: crypto.randomUUID(),
      title,
      createdAt: Date.now(),
      messages: [],
    };
    const updated = [...chapters, newChapter];
    setChapters(updated);
    saveChapters(activePersonaId, updated);
    setActiveChapterIdState(newChapter.id);
    persistActiveChapterId(activePersonaId, newChapter.id);
    setMessages([]);
    setNewChapterName('');
    setShowNewChapterForm(false);
    setChapterMenuOpen(false);
    setChapterPendingDeleteId(null);
  }

  function deleteChapter(id: string) {
    const updated = chapters.filter((c) => c.id !== id);
    setChapters(updated);
    saveChapters(activePersonaId, updated);
    setChapterPendingDeleteId(null);
    if (activeChapterId === id) {
      stop();
      if (error) clearError();
      const next = updated[0]?.id ?? null;
      setActiveChapterIdState(next);
      if (next) persistActiveChapterId(activePersonaId, next);
      setMessages(next ? (updated.find((c) => c.id === next)?.messages ?? []) : []);
    }
  }

  function attachChapterReference(chapter: Chapter) {
    const transcript = chapterTranscript(chapter);
    if (!transcript) return;
    setPendingFiles((prev) => [
      ...prev,
      {
        type: 'file',
        filename: `capitolo-${chapter.title}.txt`,
        mediaType: 'text/plain',
        url: textToDataUrl(transcript),
      },
    ]);
    setReferenceMenuOpen(false);
  }

  function saveMemoryEdit() {
    saveMemory(activePersonaId, memoryText);
    setMemoryPanelOpen(false);
  }

  function clearMemoryNow() {
    clearMemory(activePersonaId);
    setMemoryText('');
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
    if (!activeChapterId) return;
    // Un Invio nella casella di testo attiva comunque il submit del form anche se il
    // pulsante "Invia" è disabilitato: senza questi controlli, premere Invio più volte
    // di seguito (o rapidissimamente) mentre una richiesta è già in corso crea messaggi
    // duplicati, perché lo stato React non fa in tempo ad aggiornarsi tra un tasto e l'altro.
    if (status !== 'ready') return;
    const now = Date.now();
    if (now - lastSubmitAtRef.current < 800) return;
    if (!input.trim() && pendingFiles.length === 0) return;
    lastSubmitAtRef.current = now;
    if (error) clearError();
    sendMessage(
      { text: input, files: pendingFiles.length > 0 ? pendingFiles : undefined },
      { body: { personaId: activePersonaId, memory: loadMemory(activePersonaId) } },
    );
    setInput('');
    setPendingFiles([]);
  }

  function clearHistory() {
    setMessages([]);
  }

  const activePersona = getPersona(activePersonaId);
  const activeChapter = chapters.find((c) => c.id === activeChapterId) ?? null;
  const otherChapters = chapters.filter((c) => c.id !== activeChapterId);

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
        <header className="border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center justify-between px-4 py-3">
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
              disabled={!activeChapterId}
              className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100"
            >
              Cancella cronologia
            </button>
          </div>

          <div className="flex items-start gap-2 border-t border-zinc-100 px-4 py-2 dark:border-zinc-900">
          <div className="relative">
            <button
              onClick={() => {
                setChapterMenuOpen((v) => !v);
                setChapterPendingDeleteId(null);
              }}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              📑 {activeChapter ? activeChapter.title : 'Nessun capitolo'} ▾
            </button>

            {chapterMenuOpen && (
              <div className="absolute left-4 top-10 z-10 w-64 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {chapters.map((chapter) =>
                  chapterPendingDeleteId === chapter.id ? (
                    <div
                      key={chapter.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-red-50 px-2 py-1.5 text-sm dark:bg-red-950"
                    >
                      <span className="flex-1 truncate text-red-700 dark:text-red-300">
                        Eliminare &ldquo;{chapter.title}&rdquo;?
                      </span>
                      <button
                        onClick={() => deleteChapter(chapter.id)}
                        className="shrink-0 rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
                      >
                        Elimina
                      </button>
                      <button
                        onClick={() => setChapterPendingDeleteId(null)}
                        className="shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      >
                        Annulla
                      </button>
                    </div>
                  ) : (
                    <div
                      key={chapter.id}
                      className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-sm ${
                        chapter.id === activeChapterId
                          ? 'bg-zinc-100 dark:bg-zinc-800'
                          : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <button
                        onClick={() => selectChapter(chapter.id)}
                        className="flex-1 truncate text-left text-zinc-800 dark:text-zinc-200"
                      >
                        {chapter.title}
                      </button>
                      <button
                        onClick={() => setChapterPendingDeleteId(chapter.id)}
                        className="ml-2 shrink-0 rounded-lg px-1.5 py-0.5 text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950"
                        title="Elimina capitolo"
                      >
                        ✕
                      </button>
                    </div>
                  ),
                )}

                {showNewChapterForm ? (
                  <div className="mt-2 flex gap-1">
                    <input
                      autoFocus
                      value={newChapterName}
                      onChange={(e) => setNewChapterName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && createChapter()}
                      placeholder="Nome del capitolo..."
                      className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    />
                    <button
                      onClick={createChapter}
                      className="rounded-lg bg-zinc-900 px-2 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
                    >
                      Crea
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowNewChapterForm(true)}
                    className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    + Nuovo capitolo
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => setMemoryPanelOpen((v) => !v)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
              title="Memoria automatica su questo professionista"
            >
              🧠 Memoria
            </button>

            {memoryPanelOpen && (
              <div className="absolute left-0 top-10 z-10 w-80 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                <p className="mb-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                  Aggiornata automaticamente dopo ogni risposta. Puoi modificarla o cancellarla.
                </p>
                <textarea
                  value={memoryText}
                  onChange={(e) => setMemoryText(e.target.value)}
                  rows={5}
                  placeholder="Ancora nessuna memoria per questo professionista."
                  className="w-full resize-none rounded-lg border border-zinc-300 bg-white p-2 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={clearMemoryNow}
                    className="rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    Cancella
                  </button>
                  <button
                    onClick={saveMemoryEdit}
                    className="rounded-lg bg-zinc-900 px-2 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
                  >
                    Salva
                  </button>
                </div>
              </div>
            )}
          </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
            {!activeChapter && (
              <div className="rounded-lg bg-zinc-100 px-4 py-3 text-sm text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                Crea un capitolo per iniziare a scrivere con {activePersona.label}.
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex flex-col ${
                  message.role === 'user' ? 'items-end' : 'items-start'
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
                {message.role === 'assistant' &&
                  (message.metadata as { usedFallback?: boolean } | undefined)?.usedFallback && (
                    <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-500">
                      ⚠️ Modello principale non disponibile al momento, risposta generata con un
                      modello di riserva.
                    </div>
                  )}
              </div>
            ))}
            {status === 'submitted' && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-zinc-200 px-4 py-2 text-sm text-zinc-500 dark:bg-zinc-800">
                  ...
                </div>
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
            {error && (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-red-100 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                <span>
                  Errore: {error.message}
                  {retryCooldown && ' — riprova tra un attimo'}
                </span>
                <button
                  type="button"
                  onClick={() => clearError()}
                  className="shrink-0 text-red-700 hover:underline dark:text-red-300"
                >
                  Chiudi
                </button>
              </div>
            )}
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
                disabled={attaching || !activeChapterId}
                title="Allega documento o immagine"
                className="rounded-full border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
              >
                {attaching ? '...' : '📎'}
              </button>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setReferenceMenuOpen((v) => !v)}
                  disabled={!activeChapterId || otherChapters.length === 0}
                  title="Allega un capitolo precedente come riferimento"
                  className="rounded-full border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
                >
                  📖
                </button>
                {referenceMenuOpen && (
                  <div className="absolute bottom-12 left-0 z-10 w-64 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                    {otherChapters.map((chapter) => (
                      <button
                        key={chapter.id}
                        type="button"
                        onClick={() => attachChapterReference(chapter)}
                        className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        {chapter.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  activeChapterId
                    ? 'Scrivi un messaggio...'
                    : 'Crea prima un capitolo dal menu sopra'
                }
                disabled={!activeChapterId}
                className="flex-1 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <button
                type="submit"
                disabled={
                  status === 'submitted' ||
                  status === 'streaming' ||
                  attaching ||
                  !activeChapterId ||
                  retryCooldown
                }
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

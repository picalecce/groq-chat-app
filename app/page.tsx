'use client';

import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';

const STORAGE_KEY = 'groq-chat-history';

export default function Chat() {
  const [input, setInput] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error, setMessages } = useChat();

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setMessages(JSON.parse(saved) as UIMessage[]);
      } catch {
        // ignore corrupted history
      }
    }
    setHydrated(true);
  }, [setMessages]);

  useEffect(() => {
    if (hydrated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
  }, [messages, hydrated]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput('');
  }

  function clearHistory() {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <div className="flex flex-col h-dvh bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Groq Chat
        </h1>
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
                {message.parts.map((part, i) =>
                  part.type === 'text' ? (
                    <span key={`${message.id}-${i}`}>{part.text}</span>
                  ) : null,
                )}
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
        <div className="mx-auto flex max-w-2xl gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Scrivi un messaggio..."
            className="flex-1 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={status === 'submitted' || status === 'streaming'}
            className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            Invia
          </button>
        </div>
      </form>
    </div>
  );
}

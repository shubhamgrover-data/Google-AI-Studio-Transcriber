import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  SendHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { AskAiContext, AskAiMessage } from '../types/askAi';
import { MarkdownRenderer } from './MarkdownRenderer';

interface AskAiWidgetProps {
  isOpen: boolean;
  context: AskAiContext | null;
  onClose: () => void;
}

const SESSION_THREADS_KEY = 'cuescript_ask_ai_threads_v1';

function loadSessionThreads(): Record<string, AskAiMessage[]> {
  try {
    const raw = sessionStorage.getItem(SESSION_THREADS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, AskAiMessage[]>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function AskAiWidget({ isOpen, context, onClose }: AskAiWidgetProps) {
  const [threadsByContext, setThreadsByContext] =
    useState<Record<string, AskAiMessage[]>>(loadSessionThreads);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAttachedDocs, setShowAttachedDocs] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [streamingContextKey, setStreamingContextKey] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

  const activeContextKey = context?.contextKey ?? '';
  const activeMessages = activeContextKey ? threadsByContext[activeContextKey] ?? [] : [];
  const isStreamingActive = Boolean(activeContextKey && streamingContextKey === activeContextKey);

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_THREADS_KEY, JSON.stringify(threadsByContext));
    } catch {
      // Ignore sessionStorage quota errors
    }
  }, [threadsByContext]);

  useEffect(() => {
    setShowAttachedDocs(false);
    shouldAutoScrollRef.current = true;
  }, [activeContextKey]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 120);
    return () => clearTimeout(timer);
  }, [isOpen, activeContextKey]);

  // Close with Escape when open
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  // Auto-scroll when new messages arrive, unless user manually scrolled up
  useEffect(() => {
    if (!isOpen || !shouldAutoScrollRef.current) return;
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [activeMessages, isOpen, isExpanded]);

  // Abort any in-flight request on unmount
  useEffect(() => {
    return () => {
      if (activeJobIdRef.current) {
        void fetch(`/api/ask-ai/jobs/${encodeURIComponent(activeJobIdRef.current)}/cancel`, {
          method: 'POST',
        }).catch(() => {});
        activeJobIdRef.current = null;
      }
      abortControllerRef.current?.abort();
    };
  }, []);

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 64;
  }

  function stopStreaming() {
    if (activeJobIdRef.current) {
      void fetch(`/api/ask-ai/jobs/${encodeURIComponent(activeJobIdRef.current)}/cancel`, {
        method: 'POST',
      }).catch(() => {});
      activeJobIdRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStreamingContextKey(null);
  }

  function handleClearThread() {
    if (!activeContextKey) return;
    if (isStreamingActive) {
      stopStreaming();
    }
    setThreadsByContext((prev) => {
      const next = { ...prev };
      delete next[activeContextKey];
      return next;
    });
  }

  async function handleCopyMessage(msgId: string, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMsgId(msgId);
      setTimeout(() => setCopiedMsgId((curr) => (curr === msgId ? null : curr)), 1800);
    } catch {
      // Clipboard unavailable
    }
  }

  async function sendQuestion(rawQuestion: string, retryExistingUserMessageId?: string) {
    if (!context) return;
    const question = rawQuestion.trim();
    if (!question) return;

    // Abort any prior stream before launching a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    const targetContextKey = context.contextKey;
    const existingThread = threadsByContext[targetContextKey] ?? [];

    // If retrying an error message, strip trailing failed assistant reply
    const baseThread = retryExistingUserMessageId
      ? existingThread.filter((m) => !m.isError)
      : existingThread;

    const userMessage: AskAiMessage | null = retryExistingUserMessageId
      ? null
      : {
          id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          role: 'user',
          content: question,
          createdAt: new Date().toISOString(),
        };

    const assistantMsgId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const assistantPlaceholder: AskAiMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };

    const conversationForApi = (userMessage ? [...baseThread, userMessage] : baseThread)
      .filter((m) => !m.isError && m.content.trim().length > 0)
      .slice(-16)
      .map((m) => ({ role: m.role, content: m.content }));

    shouldAutoScrollRef.current = true;
    setInputValue('');
    setStreamingContextKey(targetContextKey);
    setThreadsByContext((prev) => ({
      ...prev,
      [targetContextKey]: [
        ...baseThread,
        ...(userMessage ? [userMessage] : []),
        assistantPlaceholder,
      ],
    }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const updateAssistantMessage = (updater: (msg: AskAiMessage) => AskAiMessage) => {
      setThreadsByContext((prev) => {
        const list = prev[targetContextKey] ?? [];
        const updated = list.map((msg) => (msg.id === assistantMsgId ? updater(msg) : msg));
        return { ...prev, [targetContextKey]: updated };
      });
    };

    try {
      const response = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: context.scopeType,
          contextSummary: context.contextSummary,
          documents: context.documents,
          messages: conversationForApi,
        }),
        signal: controller.signal,
      });

      const startJson = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        askAiJobId?: string;
        message?: string;
      };

      if (!response.ok || !startJson.askAiJobId) {
        updateAssistantMessage((msg) => ({
          ...msg,
          content: startJson.message || `Ask AI request failed (HTTP ${response.status}).`,
          isError: true,
        }));
        return;
      }

      const jobId = startJson.askAiJobId;
      activeJobIdRef.current = jobId;

      // Poll async job status matching Gen AI Analysis & Recommendations
      const maxPollDurationMs = 315_000;
      const pollStartedAt = Date.now();
      let consecutivePollErrors = 0;

      while (!controller.signal.aborted) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, 1200);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });

        if (Date.now() - pollStartedAt > maxPollDurationMs) {
          updateAssistantMessage((msg) => ({
            ...msg,
            content: 'Ask AI timed out waiting for OpenAI to respond. Please retry.',
            isError: true,
          }));
          return;
        }

        let pollRes: Response;
        try {
          pollRes = await fetch(`/api/ask-ai/jobs/${encodeURIComponent(jobId)}`, {
            signal: controller.signal,
          });
        } catch (pollErr) {
          if ((pollErr as Error)?.name === 'AbortError') throw pollErr;
          consecutivePollErrors += 1;
          if (consecutivePollErrors >= 5) {
            throw pollErr;
          }
          continue;
        }

        const pollData = (await pollRes.json().catch(() => ({}))) as {
          ok?: boolean;
          status?: 'processing' | 'completed' | 'failed';
          reply?: string;
          engineUsed?: string;
          error?: string;
          message?: string;
        };

        if (!pollRes.ok) {
          updateAssistantMessage((msg) => ({
            ...msg,
            content: pollData.message || `Ask AI status check failed (HTTP ${pollRes.status}).`,
            isError: true,
          }));
          return;
        }

        consecutivePollErrors = 0;

        if (pollData.status === 'completed') {
          const finalReply = (pollData.reply || '').trim();
          if (!finalReply) {
            updateAssistantMessage((msg) => ({
              ...msg,
              content: 'No response was returned from OpenAI. Please try again.',
              isError: true,
            }));
            return;
          }
          updateAssistantMessage((msg) => ({
            ...msg,
            content: finalReply,
            engineUsed: pollData.engineUsed,
          }));
          return;
        }

        if (pollData.status === 'failed') {
          updateAssistantMessage((msg) => ({
            ...msg,
            content: pollData.error || 'Ask AI could not complete your request. Please retry.',
            isError: true,
          }));
          return;
        }
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        updateAssistantMessage((msg) =>
          msg.content.trim()
            ? msg
            : {
                ...msg,
                content: 'Response stopped.',
              }
        );
      } else {
        updateAssistantMessage((msg) => ({
          ...msg,
          content:
            err instanceof Error
              ? `Network error contacting Ask AI server: ${err.message}`
              : 'Could not reach Ask AI server.',
          isError: true,
        }));
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        activeJobIdRef.current = null;
      }
      setStreamingContextKey((curr) => (curr === targetContextKey ? null : curr));
    }
  }

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    if (isStreamingActive) {
      stopStreaming();
      return;
    }
    void sendQuestion(inputValue);
  }

  function handleTextareaKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreamingActive && inputValue.trim()) {
        void sendQuestion(inputValue);
      }
    }
  }

  function handleRetryLastUserMessage() {
    const lastUser = [...activeMessages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    void sendQuestion(lastUser.content, lastUser.id);
  }

  if (!isOpen || !context) return null;

  return (
    <aside
      role="dialog"
      aria-label={context.title}
      aria-modal="false"
      className={`fixed bottom-4 right-4 z-50 flex flex-col overflow-hidden rounded-xl border border-[#CBD5E1] bg-white shadow-2xl transition-[width,height] duration-200 sm:bottom-5 sm:right-5 ${
        isExpanded
          ? 'h-[min(780px,calc(100vh-3.5rem))] w-[min(860px,calc(100vw-2rem))]'
          : 'h-[min(600px,calc(100vh-5rem))] w-[min(420px,calc(100vw-2rem))]'
      }`}
    >
      {/* Solid High-Contrast Header matching Market Intelligence Widget Anatomy */}
      <header className="flex shrink-0 items-center justify-between gap-2 bg-[#0F172A] px-4 py-3 text-white">
        <div className="flex min-w-0 items-center gap-2.5">
          <Bot className="h-4 w-4 shrink-0 text-[#FDA4AF]" aria-hidden="true" />
          <h2 className="truncate text-sm font-semibold tracking-tight text-white">
            {context.title}
          </h2>
          <span className="shrink-0 rounded bg-white/15 px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-slate-100">
            {context.countLabel}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {activeMessages.length > 0 && (
            <button
              type="button"
              onClick={handleClearThread}
              title="Clear chat history for this context"
              aria-label="Clear chat history"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsExpanded((v) => !v)}
            title={isExpanded ? 'Restore compact size' : 'Expand chat window'}
            aria-label={isExpanded ? 'Restore compact size' : 'Expand chat window'}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
          >
            {isExpanded ? (
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close Ask AI"
            aria-label="Close Ask AI"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Quiet Context Scope Strip */}
      <div className="shrink-0 border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2 text-xs text-[#475569]">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-[#334155]" title={context.contextSummary}>
            {context.contextSummary}
          </span>
          {context.documents.length > 1 && (
            <button
              type="button"
              onClick={() => setShowAttachedDocs((v) => !v)}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium text-[#0F172A] hover:text-[#E11D48] cursor-pointer"
            >
              {showAttachedDocs ? 'Hide sources' : 'View sources'}
              {showAttachedDocs ? (
                <ChevronUp className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              )}
            </button>
          )}
        </div>

        {showAttachedDocs && context.documents.length > 1 && (
          <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto border-t border-[#E2E8F0] pt-2 text-[11px] text-[#475569]">
            {context.documents.map((doc, idx) => (
              <li key={doc.id} className="flex items-baseline gap-1.5 truncate">
                <span className="font-mono tabular-nums text-[#94A3B8]">
                  {String(idx + 1).padStart(2, '0')}.
                </span>
                <span className="truncate font-medium text-[#0F172A]">{doc.title}</span>
                {doc.label && <span className="shrink-0 text-[#64748B]">· {doc.label}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Scrollable Chat Thread Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 space-y-3.5 overflow-y-auto bg-[#F8FAFC] p-4"
      >
        {activeMessages.length === 0 ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
              <p className="text-xs font-semibold text-[#0F172A]">
                Grounded Q&amp;A on your active data
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[#475569]">
                Ask any follow-up question below. Responses are generated directly from your fed{' '}
                {context.scopeType === 'studio_transcript'
                  ? 'transcript'
                  : context.scopeType === 'single_analysis'
                    ? 'Gen AI analysis'
                    : context.scopeType === 'selected_analyses'
                      ? `${context.documents.length} selected analysis files`
                      : 'latest recommendations'}{' '}
                with exact citations and Markdown tables.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-[#64748B]">Quick prompts</p>
              <div className="space-y-1.5">
                {context.starterPrompts.map((prompt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => void sendQuestion(prompt)}
                    className="block w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2.5 text-left text-xs leading-snug text-[#1E293B] transition-colors hover:border-[#0F172A] hover:bg-[#FFFFFF] cursor-pointer"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          activeMessages.map((msg, idx) => {
            const isLastAssistantStreaming =
              isStreamingActive &&
              msg.role === 'assistant' &&
              idx === activeMessages.length - 1;

            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-xl rounded-br-xs bg-[#0F172A] px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-white">
                    {msg.content}
                  </div>
                </div>
              );
            }

            if (msg.isError) {
              return (
                <div
                  key={msg.id}
                  role="alert"
                  className="rounded-xl border border-[#FECDD3] bg-[#FFF1F2] p-3.5 text-xs text-[#881337]"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#BE123C]" aria-hidden="true" />
                    <p className="flex-1 leading-relaxed">{msg.content}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRetryLastUserMessage}
                    className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-[#FDA4AF] bg-white px-2.5 py-1 text-[11px] font-medium text-[#9F1239] transition-colors hover:bg-[#FFF1F2] cursor-pointer"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Retry
                  </button>
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-xs"
              >
                {msg.content ? (
                  <MarkdownRenderer markdown={msg.content} compact />
                ) : (
                    <div className="flex items-center gap-2 text-xs text-[#64748B]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E11D48]" aria-hidden="true" />
                      <span>Analyzing context with OpenAI...</span>
                    </div>
                  )}

                  {isLastAssistantStreaming && msg.content && (
                    <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[#64748B]">
                      <Loader2 className="h-3 w-3 animate-spin text-[#E11D48]" aria-hidden="true" />
                      <span>Generating...</span>
                    </div>
                  )}

                {!isLastAssistantStreaming && msg.content && (
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#F1F5F9] pt-2 text-[11px] text-[#64748B]">
                    <span className="truncate">{msg.engineUsed || 'AI Assistant'}</span>
                    <button
                      type="button"
                      onClick={() => void handleCopyMessage(msg.id, msg.content)}
                      className="inline-flex shrink-0 items-center gap-1 font-medium text-[#475569] hover:text-[#0F172A] cursor-pointer"
                    >
                      {copiedMsgId === msg.id ? (
                        <>
                          <Check className="h-3 w-3 text-[#15803D]" aria-hidden="true" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" aria-hidden="true" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Bottom Follow-Up Composer Bar matching Screenshot */}
      <form
        onSubmit={handleFormSubmit}
        className="flex shrink-0 items-end gap-2 border-t border-[#E2E8F0] bg-white p-3"
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleTextareaKeyDown}
          placeholder="Ask follow up questions..."
          aria-label="Ask follow up questions"
          disabled={isStreamingActive}
          className="max-h-28 min-h-[38px] flex-1 resize-none rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs leading-relaxed text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#0F172A] focus:bg-white focus:outline-none disabled:opacity-60"
        />

        {isStreamingActive ? (
          <button
            type="button"
            onClick={stopStreaming}
            title="Stop generating"
            aria-label="Stop generating"
            className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-[#0F172A] text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!inputValue.trim()}
            title="Send question"
            aria-label="Send question"
            className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-[#E11D48] text-white transition-colors hover:bg-[#BE123C] disabled:cursor-not-allowed disabled:bg-[#CBD5E1] disabled:text-[#64748B] cursor-pointer"
          >
            <SendHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </form>
    </aside>
  );
}

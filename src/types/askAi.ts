export type AskAiScopeType =
  | 'studio_transcript'
  | 'single_analysis'
  | 'selected_analyses'
  | 'latest_recommendations';

export interface AskAiDocument {
  id: string;
  title: string;
  label?: string;
  content: string;
}

export interface AskAiContext {
  /** Deterministic thread key so each source context keeps an isolated chat history */
  contextKey: string;
  scopeType: AskAiScopeType;
  /** Header title shown in the floating assistant */
  title: string;
  /** Compact item/scope count shown next to header title (e.g. "Transcript", "7 Items") */
  countLabel: string;
  /** Quiet one-line context summary shown in the sub-header strip */
  contextSummary: string;
  /** Documents fed to the reusable Ask AI backend */
  documents: AskAiDocument[];
  /** Context-aware 1-click starter questions */
  starterPrompts: string[];
}

export interface AskAiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  engineUsed?: string;
  isError?: boolean;
}

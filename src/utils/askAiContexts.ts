import type { AskAiContext, AskAiDocument } from '../types/askAi';
import type { RecommendationSnapshot, TranscriptJob } from '../types/transcript';
import {
  formatDisplayTimestamp,
  getSourceShortLabel,
  serializeToTXT,
  truncateTitle,
} from './exporters';

const PLATFORM_NAMES: Record<TranscriptJob['sourceType'], string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  direct_url: 'Direct Media',
  file_upload: 'Uploaded Media',
};

export function buildStudioTranscriptAskAiContext(job: TranscriptJob): AskAiContext {
  const transcriptTxt = serializeToTXT(job);
  const chaptersSection =
    job.chapters.length > 0
      ? `\n\nKEY CHAPTERS:\n${job.chapters
          .map(
            (ch) =>
              `- [${formatDisplayTimestamp(ch.startSeconds)} - ${formatDisplayTimestamp(ch.endSeconds)}] ${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`
          )
          .join('\n')}`
      : '';

  const content = [
    `VIDEO TITLE: ${job.title}`,
    `PLATFORM: ${PLATFORM_NAMES[job.sourceType]}`,
    job.author ? `CREATOR / CHANNEL: ${job.author}` : null,
    `LANGUAGE: ${job.language}`,
    `DURATION: ${formatDisplayTimestamp(job.durationSeconds)}`,
    job.summary ? `\nEXECUTIVE SUMMARY:\n${job.summary}` : null,
    chaptersSection || null,
    `\nFULL TIMESTAMPED TRANSCRIPT:\n${transcriptTxt}`,
  ]
    .filter(Boolean)
    .join('\n');

  const doc: AskAiDocument = {
    id: job.id,
    title: job.title,
    label: `${getSourceShortLabel(job.sourceType)} · Transcript`,
    content,
  };

  return {
    contextKey: `studio:${job.id}`,
    scopeType: 'studio_transcript',
    title: 'Ask AI Assistant',
    countLabel: 'Transcript',
    contextSummary: `${truncateTitle(job.title, 54)} · ${job.language} · ${formatDisplayTimestamp(job.durationSeconds)}`,
    documents: [doc],
    starterPrompts: [
      'Summarize the main takeaways and actionable points with exact timestamps.',
      'List every stock, sector, or asset mentioned along with the speaker’s stance and timestamps.',
      'What specific price levels, targets, or dip zones did the speaker mention?',
      'Highlight any risks, warnings, or caveats raised in this video.',
    ],
  };
}

export function buildSingleAnalysisAskAiContext(job: TranscriptJob): AskAiContext | null {
  const markdown = job.analysis?.markdown?.trim();
  if (!markdown) return null;

  const content = [
    `VIDEO TITLE: ${job.title}`,
    `PLATFORM: ${PLATFORM_NAMES[job.sourceType]}`,
    `LANGUAGE: ${job.language}`,
    `DURATION: ${formatDisplayTimestamp(job.durationSeconds)}`,
    job.analysis?.engineUsed ? `ANALYSIS ENGINE: ${job.analysis.engineUsed}` : null,
    `\nGEN AI ANALYSIS REPORT (analysis.md):\n${markdown}`,
  ]
    .filter(Boolean)
    .join('\n');

  const doc: AskAiDocument = {
    id: job.id,
    title: job.driveFolderName?.trim() || job.title,
    label: `${getSourceShortLabel(job.sourceType)} · analysis.md`,
    content,
  };

  return {
    contextKey: `analysis:${job.id}`,
    scopeType: 'single_analysis',
    title: 'Ask AI Assistant',
    countLabel: '1 Analysis',
    contextSummary: `${truncateTitle(job.title, 54)} · Gen AI Analysis`,
    documents: [doc],
    starterPrompts: [
      'Summarize the highest-conviction Strong Buy stocks from this analysis in a quick table.',
      'Which ATF Top 60 stocks are covered here, and what exact entry levels were given?',
      'Which stocks had cautionary notes, hold calls, or wait-for-dip advice?',
      'Compare the ATF Top 60 calls vs. outside-ATF ideas from this video.',
    ],
  };
}

export function buildSelectedAnalysesAskAiContext(
  selectedJobs: TranscriptJob[]
): AskAiContext | null {
  const eligible = selectedJobs.filter((j) => Boolean(j.analysis?.markdown?.trim()));
  if (eligible.length === 0) return null;

  const sortedIds = [...eligible]
    .map((j) => j.sourceKey || j.id)
    .sort()
    .join('|');

  const documents: AskAiDocument[] = eligible.map((job) => {
    const displayTitle = job.driveFolderName?.trim() || job.title;
    return {
      id: job.id,
      title: displayTitle,
      label: `${getSourceShortLabel(job.sourceType)} · ${formatDisplayTimestamp(job.durationSeconds)} · analysis.md`,
      content: job.analysis!.markdown.trim(),
    };
  });

  const count = documents.length;

  return {
    contextKey: `rec-sources:${sortedIds}`,
    scopeType: 'selected_analyses',
    title: 'Ask AI Assistant',
    countLabel: `${count} ${count === 1 ? 'Item' : 'Items'}`,
    contextSummary:
      count === 1
        ? `${truncateTitle(documents[0].title, 56)} · analysis.md`
        : `${count} selected analysis.md files from Recent Transcriptions`,
    documents,
    starterPrompts: [
      'Which stocks appear repeatedly across multiple selected videos? Show a table with sources and timestamps.',
      'Where do different videos conflict on buy levels, targets, or stance for the same stock?',
      'List all ATF Top 60 Strong Buy calls across the selected files with their exact dip/entry prices.',
      'Extract all short-term or swing trade setups with targets and stop-losses.',
    ],
  };
}

export function buildLatestRecommendationsAskAiContext(
  snapshot: RecommendationSnapshot
): AskAiContext {
  const sourceAudit =
    snapshot.sourceVideos.length > 0
      ? `\nSOURCE ANALYSIS FILES INCLUDED (${snapshot.sourceVideos.length}):\n${snapshot.sourceVideos
          .map((s, idx) => `${idx + 1}. ${s.title} (${s.folderName ? `${s.folderName}/analysis.md` : s.fileName})`)
          .join('\n')}`
      : '';

  const content = [
    `RECOMMENDATIONS TIMESTAMP: ${snapshot.formattedTimestamp}`,
    `ENGINE: ${snapshot.engineUsed}`,
    `COUNTS: ${snapshot.strongBuys.length} Strong Buys · ${snapshot.swingTrades.length} Swing Trades`,
    snapshot.executiveSummary ? `\nEXECUTIVE SUMMARY:\n${snapshot.executiveSummary}` : null,
    sourceAudit || null,
    `\nLATEST RECOMMENDATIONS REPORT:\n${snapshot.markdown}`,
  ]
    .filter(Boolean)
    .join('\n');

  const doc: AskAiDocument = {
    id: snapshot.id,
    title: `Latest Recommendations (${snapshot.formattedTimestamp})`,
    label: `${snapshot.strongBuys.length} Strong Buys · ${snapshot.swingTrades.length} Swing Trades`,
    content,
  };

  return {
    contextKey: `rec-latest:${snapshot.id}`,
    scopeType: 'latest_recommendations',
    title: 'Ask AI Assistant',
    countLabel: 'Recommendations',
    contextSummary: `Latest Recommendations · ${snapshot.strongBuys.length} Strong Buys · ${snapshot.swingTrades.length} Swing Trades`,
    documents: [doc],
    starterPrompts: [
      'Which stocks have the strongest multi-video conviction in the latest recommendations?',
      'Show all stocks with flagged conflicting levels or stances across sources.',
      'Create a concise watchlist table of ATF Top 60 Strong Buys that have explicit entry or dip prices.',
      'Summarize the Swing Trades with exact entry bands, targets, and stop-losses.',
    ],
  };
}

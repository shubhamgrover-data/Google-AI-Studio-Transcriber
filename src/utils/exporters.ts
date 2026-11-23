import type { TranscriptJob } from '../types/transcript';

/** Formats seconds into MM:SS or HH:MM:SS for UI display */
export function formatDisplayTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/** Formats seconds into HH:MM:SS,mmm (SRT) or HH:MM:SS.mmm (VTT) */
function formatSubtitleTime(totalSeconds: number, separator: ',' | '.'): string {
  const safe = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000) % 1000;

  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}` +
    `${separator}${String(millis).padStart(3, '0')}`
  );
}

export function getSpeakerDisplayName(job: TranscriptJob, speakerId: string): string {
  return job.speakers[speakerId]?.trim() || speakerId;
}

export function serializeToSRT(job: TranscriptJob): string {
  return job.segments
    .map((seg, idx) => {
      const start = formatSubtitleTime(seg.startSeconds, ',');
      const end = formatSubtitleTime(Math.max(seg.endSeconds, seg.startSeconds + 1), ',');
      const speaker = getSpeakerDisplayName(job, seg.speakerId);
      return `${idx + 1}\n${start} --> ${end}\n${speaker}: ${seg.text}`;
    })
    .join('\n\n');
}

export function serializeToVTT(job: TranscriptJob): string {
  const body = job.segments
    .map((seg) => {
      const start = formatSubtitleTime(seg.startSeconds, '.');
      const end = formatSubtitleTime(Math.max(seg.endSeconds, seg.startSeconds + 1), '.');
      const speaker = getSpeakerDisplayName(job, seg.speakerId);
      return `${start} --> ${end}\n<v ${speaker}>${seg.text}`;
    })
    .join('\n\n');

  return `WEBVTT\n\nNOTE Title: ${job.title}\n\n${body}`;
}

export function serializeToTXT(job: TranscriptJob): string {
  const header = [
    job.title,
    job.sourceUrl ? `Source: ${job.sourceUrl}` : job.fileName ? `File: ${job.fileName}` : '',
    `Language: ${job.language} · Duration: ${formatDisplayTimestamp(job.durationSeconds)}`,
    '',
    'SUMMARY',
    job.summary,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const chaptersBlock =
    job.chapters.length > 0
      ? [
          'CHAPTERS',
          ...job.chapters.map(
            (ch) => `[${formatDisplayTimestamp(ch.startSeconds)}] ${ch.title} — ${ch.summary}`
          ),
          '',
        ].join('\n')
      : '';

  const transcriptBlock = [
    'TRANSCRIPT',
    ...job.segments.map((seg) => {
      const speaker = getSpeakerDisplayName(job, seg.speakerId);
      return `[${formatDisplayTimestamp(seg.startSeconds)} - ${formatDisplayTimestamp(seg.endSeconds)}] ${speaker}: ${seg.text}`;
    }),
  ].join('\n');

  return `${header}\n${chaptersBlock}\n${transcriptBlock}\n`;
}

export function serializeToJSON(job: TranscriptJob): string {
  const payload = {
    id: job.id,
    title: job.title,
    sourceType: job.sourceType,
    sourceUrl: job.sourceUrl ?? null,
    language: job.language,
    durationSeconds: job.durationSeconds,
    summary: job.summary,
    speakers: job.speakers,
    chapters: job.chapters.map((ch) => ({
      title: ch.title,
      startTime: formatDisplayTimestamp(ch.startSeconds),
      startSeconds: ch.startSeconds,
      endSeconds: ch.endSeconds,
      summary: ch.summary,
    })),
    segments: job.segments.map((seg) => ({
      startTime: formatDisplayTimestamp(seg.startSeconds),
      endTime: formatDisplayTimestamp(seg.endSeconds),
      startSeconds: seg.startSeconds,
      endSeconds: seg.endSeconds,
      speaker: getSpeakerDisplayName(job, seg.speakerId),
      text: seg.text,
    })),
  };

  return JSON.stringify(payload, null, 2);
}

export function slugifyFilename(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'transcript';
}

export function truncateTitle(title: string, maxChars = 50): string {
  const cleaned = (title || 'Untitled Transcript').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled Transcript';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).trimEnd()}…`;
}

export function getSourceShortLabel(sourceType: TranscriptJob['sourceType']): string {
  switch (sourceType) {
    case 'facebook':
      return 'FB';
    case 'instagram':
      return 'Insta';
    case 'youtube':
      return 'YT';
    case 'direct_url':
      return 'URL';
    case 'file_upload':
    default:
      return 'Upload';
  }
}

export function formatDriveVideoFolderName(
  sourceType: TranscriptJob['sourceType'],
  title: string
): string {
  const prefix = getSourceShortLabel(sourceType);
  const sanitized = (title || 'Untitled Video')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
    .trim();
  return `${prefix} - ${sanitized || 'Untitled Video'}`;
}

export function triggerFileDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function detectPlatformFromInput(rawUrl: string): {
  platform: 'youtube' | 'facebook' | 'instagram' | 'direct_url' | null;
  label: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { platform: null, label: '' };

  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtu.be' ||
      host === 'music.youtube.com'
    ) {
      return { platform: 'youtube', label: 'YouTube' };
    }
    if (host === 'facebook.com' || host === 'm.facebook.com' || host === 'fb.watch' || host === 'web.facebook.com') {
      return { platform: 'facebook', label: 'Facebook' };
    }
    if (host === 'instagram.com' || host === 'm.instagram.com' || host === 'instagr.am') {
      return { platform: 'instagram', label: 'Instagram' };
    }
    if (/\.(mp4|mov|webm|mp3|wav|m4a|ogg|aac)(\?.*)?$/i.test(parsed.pathname + parsed.search)) {
      return { platform: 'direct_url', label: 'Direct Media' };
    }
    return { platform: null, label: 'Unrecognized URL' };
  } catch {
    return { platform: null, label: '' };
  }
}

export interface PipelineStage {
  id: string;
  order: string;
  title: string;
  role: string;
  recommendedStack: string;
  summary: string;
  responsibilities: string[];
  failureModes: string[];
  codeTitle: string;
  codeLanguage: string;
  codeSnippet: string;
}

export interface PlatformSpec {
  id: 'youtube' | 'facebook' | 'instagram';
  name: string;
  urlPatterns: string[];
  extractionStrategy: string;
  authAndAntiBot: string;
  reliabilityRating: string;
  primaryHurdles: string[];
  recommendedFallback: string;
}

export interface ChecklistItem {
  id: string;
  step: string;
  title: string;
  category: string;
  detail: string;
  effort: string;
}

export interface CostEngineProfile {
  id: 'gemini_multimodal' | 'managed_stt' | 'self_hosted_whisper';
  name: string;
  tagline: string;
  sttPerMinuteUsd: number;
  diarizationIncluded: boolean;
  llmPostProcessPerMinuteUsd: number;
  extractionInfraPerMinuteUsd: number;
  fixedMonthlyOverheadUsd: number;
  speedMultiplier: number; // e.g., 12x real-time
  bestFor: string;
  tradeoff: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: 'gateway',
    order: '01',
    title: 'API Gateway & Async Job Queue',
    role: 'Ingestion & Deduplication',
    recommendedStack: 'Node.js (Express/Fastify) or FastAPI · Redis + BullMQ / Temporal',
    summary:
      'Never transcribe synchronously inside a single HTTP request at scale. Accept the URL, validate the host, hash the canonical video ID for cache hits, return 202 Accepted immediately, and hand work to an async queue.',
    responsibilities: [
      'Normalize URLs (strip tracking params like si, fbclid, igsh) and compute a SHA-256 cache key so duplicate links return instant cached transcripts.',
      'Return a job_id immediately and expose GET /v1/jobs/:id plus signed HMAC webhooks or Server-Sent Events (SSE) for live status updates.',
      'Enforce per-user rate limits, maximum video duration guards (e.g. 2 hours), and SSRF protections against internal IP addresses.',
    ],
    failureModes: [
      'HTTP 504 gateway timeouts on 30+ minute videos if processed synchronously.',
      'Duplicate concurrent workers downloading the same viral video without an idempotency lock.',
    ],
    codeTitle: 'POST /v1/transcriptions (Async Enqueue)',
    codeLanguage: 'typescript',
    codeSnippet: `app.post('/v1/transcriptions', async (req, res) => {
  const { url, webhookUrl, language } = req.body;
  const canonical = normalizeVideoUrl(url); // strips fbclid, si, igsh
  const cacheKey = sha256(\`\${canonical}:\${language ?? 'auto'}\`);

  const cached = await db.transcripts.findUnique({ where: { cacheKey } });
  if (cached) return res.status(200).json({ status: 'completed', job: cached });

  const job = await db.jobs.create({ data: { url: canonical, status: 'queued', webhookUrl } });
  await transcriptionQueue.add('ingest-video', { jobId: job.id, url: canonical }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 4000 },
  });

  return res.status(202).json({ jobId: job.id, status: 'queued' });
});`,
  },
  {
    id: 'extractor',
    order: '02',
    title: 'Multi-Platform Media Extractor',
    role: 'YouTube · Facebook · Instagram',
    recommendedStack: 'yt-dlp (auto-updated nightly) · Residential Proxies · Cookie Vault',
    summary:
      'This is the hardest operational layer of any YT/FB/IG service. YouTube offers direct streams and native Gemini URL ingestion, whereas Facebook and Instagram aggressively gate cloud datacenter IPs behind login walls.',
    responsibilities: [
      'Run yt-dlp in audio-only mode (-f bestaudio) to avoid downloading multi-gigabyte 4K video tracks when you only need speech.',
      'For YouTube: pass public URLs directly to Gemini multimodal fileUri or fetch existing auto/manual caption tracks first as a fast path.',
      'For Facebook & Instagram: route extraction workers through rotating residential proxies with managed session cookies, and return a structured LOGIN_WALL_FALLBACK code when content is private.',
    ],
    failureModes: [
      'Meta silently returns an HTML login page (HTTP 200) instead of a 403 error, breaking naive scrapers.',
      'Stale yt-dlp binaries break within days after YouTube/Instagram signature changes.',
    ],
    codeTitle: 'Worker: Audio-Only Extraction with Duration Guard',
    codeLanguage: 'bash',
    codeSnippet: `# 1. Inspect metadata first (enforce duration limit before downloading)
yt-dlp --dump-json --no-playlist \\
  --proxy "$RESIDENTIAL_PROXY_URL" \\
  --cookies "/run/secrets/meta_cookies.txt" \\
  "$VIDEO_URL"

# 2. Extract best audio stream only (skips 1080p/4K video payload)
yt-dlp -x --audio-format mp3 --audio-quality 5 \\
  --max-filesize 150M \\
  --no-playlist \\
  -o "/tmp/jobs/%(id)s.%(ext)s" \\
  "$VIDEO_URL"`,
  },
  {
    id: 'normalize',
    order: '03',
    title: 'Audio Normalization & Chunking',
    role: 'FFmpeg Pre-Processing',
    recommendedStack: 'FFmpeg · ffprobe · Ephemeral NVMe / S3 Lifecycle Bucket',
    summary:
      'Speech models perform fastest and cheapest on lightweight mono 16 kHz audio. Stripping video and splitting hour-long recordings into overlapping chunks unlocks parallel transcription and prevents memory spikes.',
    responsibilities: [
      'Convert any input codec (AAC, Opus, MP4, MOV) into 16 kHz mono MP3 or WAV (16-bit PCM) — reducing a 500 MB video to ~15 MB of audio.',
      'Apply optional silence detection or voice activity detection (VAD) to avoid hallucinated subtitles during long music intros.',
      'Split files exceeding 20 minutes into 15-minute segments with a 2-second overlap so workers transcribe chunks concurrently and stitch timestamps back accurately.',
    ],
    failureModes: [
      'Corrupted container timestamps in Instagram Reels causing drifting subtitle offsets if not re-muxed.',
      'Disk exhaustion on worker containers when temporary media files are not deleted inside finally blocks.',
    ],
    codeTitle: 'FFmpeg Speech Normalization & 15-Min Chunking',
    codeLanguage: 'bash',
    codeSnippet: `# Normalize to 16kHz mono 64kbps MP3 (ideal for Gemini & Whisper)
ffmpeg -y -i /tmp/jobs/input.webm \\
  -vn -ac 1 -ar 16000 -b:a 64k \\
  /tmp/jobs/normalized.mp3

# Split long audio into 15-minute (900s) chunks for parallel STT
ffmpeg -i /tmp/jobs/normalized.mp3 \\
  -f segment -segment_time 900 -c copy \\
  /tmp/jobs/chunk_%03d.mp3`,
  },
  {
    id: 'stt',
    order: '04',
    title: 'Speech-to-Text & Diarization Engine',
    role: 'Timestamps + Speaker Labels',
    recommendedStack: 'Gemini Multimodal (gemini-4-hydrogen) or WhisperX + pyannote.audio',
    summary:
      'Choose between a unified multimodal model (which outputs transcripts, timestamps, speaker labels, and chapter summaries in one structured JSON call) or a dedicated forced-alignment STT pipeline for massive batch volume.',
    responsibilities: [
      'Gemini Path (used live in CueScript): Send public YouTube fileUri or uploaded audio/video directly with a strict JSON responseSchema returning startSeconds, endSeconds, speakerId, text, and chapters.',
      'WhisperX Path (high-volume self-hosted): Run faster-whisper on L4/T4 GPU spot instances, align word timestamps with wav2vec2, and assign speakers via pyannote diarization.',
      'Detect source language automatically and preserve proper nouns, technical acronyms, and punctuation.',
    ],
    failureModes: [
      'Overlapping crosstalk in podcasts confusing speaker labels without explicit diarization constraints.',
      'Timestamp drift on 60+ minute recordings when not chunked or forced-aligned.',
    ],
    codeTitle: 'Server-Side Gemini Structured Transcription Call',
    codeLanguage: 'typescript',
    codeSnippet: `const response = await ai.models.generateContent({
  model: 'gemini-4-hydrogen',
  contents: [
    { fileData: { fileUri: youtubeUrl, mimeType: 'video/*' } },
    { text: 'Transcribe verbatim with exact timestamps, speaker IDs, and chapters.' },
  ],
  config: {
    responseMimeType: 'application/json',
    responseSchema: transcriptSchema, // enforces segments[] + chapters[]
  },
});`,
  },
  {
    id: 'postprocess',
    order: '05',
    title: 'Subtitle Formatting & Chaptering',
    role: 'SRT · VTT · TXT · JSON',
    recommendedStack: 'Deterministic TypeScript Serializers · PostgreSQL + pgvector',
    summary:
      'Store a single canonical JSON timeline in your database and generate SRT, WebVTT, plain text, and semantic chapters on demand so user edits (like renaming Speaker 1 to Host) immediately propagate to every export format.',
    responsibilities: [
      'Enforce monotonic timestamps (endSeconds > startSeconds) and wrap subtitle cues to <= 42 characters per line for broadcast readability.',
      'Store canonical JSON in PostgreSQL alongside generated chapter summaries and optional vector embeddings for "ask this video" search.',
      'Immediately delete raw downloaded audio/video files once JSON persistence succeeds to minimize storage bills and copyright exposure.',
    ],
    failureModes: [
      'Using a period instead of a comma in SRT milliseconds (00:01:02,500 for SRT vs 00:01:02.500 for VTT) breaks video editors like Premiere and CapCut.',
      'Missing chunk time offsets when merging parallel worker transcripts.',
    ],
    codeTitle: 'Canonical JSON -> SRT & WebVTT Serializer',
    codeLanguage: 'typescript',
    codeSnippet: `export function toSRT(segments: Segment[], speakers: Record<string, string>) {
  return segments.map((seg, i) => [
    i + 1,
    \`\${fmtTime(seg.startSeconds, ',')} --> \${fmtTime(seg.endSeconds, ',')}\`,
    \`\${speakers[seg.speakerId] ?? seg.speakerId}: \${seg.text}\`,
  ].join('\\n')).join('\\n\\n');
}`,
  },
  {
    id: 'delivery',
    order: '06',
    title: 'Delivery, Webhooks & Compliance',
    role: 'Client UX & Legal Guardrails',
    recommendedStack: 'Signed Webhooks · Cloud Run / ECS Autoscaling · Ephemeral Retention',
    summary:
      'Production transcription services succeed on developer ergonomics and operational safety: signed webhook delivery, graceful upload fallbacks when social platforms block bots, and strict ephemeral media handling.',
    responsibilities: [
      'Sign webhook payloads with HMAC-SHA256 headers and retry failed deliveries with exponential backoff for up to 24 hours.',
      'Provide a first-class local file upload fallback in your client UI whenever a Facebook or Instagram Reel is private, region-locked, or behind a login challenge.',
      'Publish clear Terms of Service requiring users to hold rights/permission to transcribe submitted links and never permanently host or redistribute third-party videos.',
    ],
    failureModes: [
      'Storing third-party MP4 files permanently creates unnecessary copyright liability and skyrocketing S3 egress costs.',
      'Silent failures on private Instagram links instead of guiding users to upload the file directly.',
    ],
    codeTitle: 'Signed Webhook Completion Payload',
    codeLanguage: 'json',
    codeSnippet: `{
  "event": "transcription.completed",
  "jobId": "job_9f82c1a4",
  "platform": "youtube",
  "durationSeconds": 412,
  "language": "English",
  "speakers": ["Host", "Guest"],
  "exports": {
    "srt": "https://api.example.com/v1/jobs/job_9f82c1a4.srt",
    "vtt": "https://api.example.com/v1/jobs/job_9f82c1a4.vtt",
    "json": "https://api.example.com/v1/jobs/job_9f82c1a4.json"
  }
}`,
  },
];

export const PLATFORM_SPECS: PlatformSpec[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    urlPatterns: ['youtube.com/watch?v=...', 'youtu.be/...', 'youtube.com/shorts/...'],
    extractionStrategy:
      'Direct multimodal URL ingestion via Gemini fileUri (used live in CueScript), or yt-dlp audio stream extraction / YouTube TimedText caption fast-path for public videos.',
    authAndAntiBot:
      'Low friction for public videos via Gemini fileUri. Self-hosted yt-dlp from AWS/GCP IPs frequently triggers "Sign in to confirm you are not a bot" PO-token checks unless routed through residential IPs.',
    reliabilityRating: 'High (Public URLs)',
    primaryHurdles: [
      'Private, members-only, and age-restricted videos cannot be read without OAuth or cookies.',
      'Very long livestreams (2+ hours) require audio chunking to prevent context or timeout limits.',
      'Auto-generated YouTube captions lack punctuation and speaker diarization compared to full audio transcription.',
    ],
    recommendedFallback:
      'Prompt user to verify the video is Public/Unlisted, or upload the exported audio/video file directly.',
  },
  {
    id: 'facebook',
    name: 'Facebook Videos & Reels',
    urlPatterns: ['facebook.com/*/videos/...', 'facebook.com/reel/...', 'fb.watch/...'],
    extractionStrategy:
      'Public HTML/OpenGraph media stream parsing for openly shared watch pages, backed by yt-dlp with residential proxy + authenticated cookie pool in dedicated worker clusters.',
    authAndAntiBot:
      'Strict. Meta blocks most datacenter IP ranges, redirects fb.watch links through login walls, and obfuscates DASH video/audio manifests dynamically.',
    reliabilityRating: 'Medium (Public) / Blocked (Private)',
    primaryHurdles: [
      'Private group videos and friends-only posts are strictly inaccessible without user-authorized Graph API tokens.',
      'Meta separates HD video and audio into distinct DASH streams that must be fetched via the audio track URL.',
      'Session cookies expire frequently and trigger account checkpoints if reused at high concurrency.',
    ],
    recommendedFallback:
      'Return a clear LOGIN_WALL_FALLBACK diagnostic and accept direct MP4/MP3 upload from the user.',
  },
  {
    id: 'instagram',
    name: 'Instagram Reels & Posts',
    urlPatterns: ['instagram.com/reel/...', 'instagram.com/p/...', 'instagram.com/tv/...'],
    extractionStrategy:
      'Public embed/OpenGraph video URL resolution where exposed, or yt-dlp with rotating residential proxies and dedicated Instagram Graph API webhooks for business accounts.',
    authAndAntiBot:
      'Very Strict. Instagram aggressively rate-limits unauthenticated requests from cloud servers, serving login redirects after just a handful of requests per IP.',
    reliabilityRating: 'Low Unauthenticated / High via Upload or Graph API',
    primaryHurdles: [
      'Unauthenticated scraping from cloud servers hits HTTP 429 or silent login redirects within minutes.',
      'Official Instagram Graph API only grants media URLs for Business/Creator accounts that explicitly OAuth into your app.',
      'Reels often contain loud background music tracks requiring robust speech isolation during transcription.',
    ],
    recommendedFallback:
      'Offer one-click file upload fallback (MP4/MOV/M4A) or an optional browser extension that grabs the authenticated client-side media stream.',
  },
];

export const BUILD_CHECKLIST: ChecklistItem[] = [
  {
    id: 'step-1',
    step: '01',
    title: 'Design the Async Job Contract & Webhook API',
    category: 'Backend API',
    detail:
      'Expose POST /v1/transcriptions (returns 202 + jobId) and GET /v1/transcriptions/:id. Add URL normalization and hash-based caching so repeat links cost $0.',
    effort: '1–2 days',
  },
  {
    id: 'step-2',
    step: '02',
    title: 'Deploy Isolated Extraction Workers (yt-dlp + FFmpeg)',
    category: 'Media Ingestion',
    detail:
      'Containerize yt-dlp and FFmpeg on autoscaling workers separate from your web server. Extract 16 kHz mono audio only, enforce max duration caps, and automate nightly yt-dlp updates.',
    effort: '2–3 days',
  },
  {
    id: 'step-3',
    step: '03',
    title: 'Configure Meta Resilience & Upload Fallback UX',
    category: 'Platform Reliability',
    detail:
      'Add residential proxy routing and encrypted cookie rotation if scraping public FB/IG links, plus a frictionless local media upload fallback whenever Meta enforces a login wall.',
    effort: '2–4 days',
  },
  {
    id: 'step-4',
    step: '04',
    title: 'Wire Your Transcription + Diarization Pipeline',
    category: 'AI & Speech',
    detail:
      'Start with Gemini Multimodal (gemini-4-hydrogen) for instant YouTube URL support, speaker labels, and chaptering; add WhisperX or Deepgram later if high volume requires lower unit cost.',
    effort: '1–2 days',
  },
  {
    id: 'step-5',
    step: '05',
    title: 'Build Canonical Timeline Storage & Subtitle Serializers',
    category: 'Data & Export',
    detail:
      'Persist canonical JSON segments in PostgreSQL and generate SRT, WebVTT, TXT, and JSON exports deterministically so inline speaker renames update every export instantly.',
    effort: '1–2 days',
  },
  {
    id: 'step-6',
    step: '06',
    title: 'Add Ephemeral Storage Cleanup & Cost Guards',
    category: 'Operations',
    detail:
      'Delete raw downloaded audio/video immediately after transcription succeeds, configure 24-hour S3/R2 bucket lifecycle rules as a safety net, and cap free-tier clip lengths.',
    effort: '1 day',
  },
  {
    id: 'step-7',
    step: '07',
    title: 'Implement Rate Limiting, Billing & ToS Guardrails',
    category: 'Production Launch',
    detail:
      'Meter usage by audio minutes processed, protect endpoints against SSRF and abuse, and require users to confirm transcription rights for third-party social URLs.',
    effort: '2 days',
  },
];

export const COST_ENGINES: CostEngineProfile[] = [
  {
    id: 'gemini_multimodal',
    name: 'Gemini Multimodal (gemini-4-hydrogen)',
    tagline: 'Direct YouTube URL + uploaded audio/video with speakers & chapters in one call',
    sttPerMinuteUsd: 0.0024,
    diarizationIncluded: true,
    llmPostProcessPerMinuteUsd: 0.0,
    extractionInfraPerMinuteUsd: 0.0005,
    fixedMonthlyOverheadUsd: 25,
    speedMultiplier: 18,
    bestFor: 'Fastest time-to-market, native YouTube URL ingestion, rich chaptering + speaker labeling',
    tradeoff: 'Word-level millisecond sync is slightly coarser than forced-alignment STT models on noisy audio',
  },
  {
    id: 'managed_stt',
    name: 'Managed Speech API (Deepgram / AssemblyAI) + LLM',
    tagline: 'Dedicated word-level STT API with diarization plus LLM chapter pass',
    sttPerMinuteUsd: 0.0058,
    diarizationIncluded: true,
    llmPostProcessPerMinuteUsd: 0.0006,
    extractionInfraPerMinuteUsd: 0.0012,
    fixedMonthlyOverheadUsd: 45,
    speedMultiplier: 25,
    bestFor: 'Broadcast-grade word timestamps, high concurrency without managing GPUs',
    tradeoff: 'Requires extracting and uploading audio for every YouTube, Facebook, and Instagram link',
  },
  {
    id: 'self_hosted_whisper',
    name: 'Self-Hosted WhisperX + pyannote (GPU Workers)',
    tagline: 'Open-weights faster-whisper large-v3 on autoscaling L4/T4 GPU containers',
    sttPerMinuteUsd: 0.0014,
    diarizationIncluded: true,
    llmPostProcessPerMinuteUsd: 0.0006,
    extractionInfraPerMinuteUsd: 0.0015,
    fixedMonthlyOverheadUsd: 190,
    speedMultiplier: 12,
    bestFor: 'High-volume workloads (50,000+ minutes/month) needing lowest marginal cost and strict data residency',
    tradeoff: 'Higher baseline GPU hosting overhead, cold-start tuning, and DevOps maintenance',
  },
];

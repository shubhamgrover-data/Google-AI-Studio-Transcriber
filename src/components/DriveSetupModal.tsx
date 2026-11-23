import { useEffect, useState } from 'react';
import { Check, Copy, HardDrive, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { DriveStatusResponse } from '../types/transcript';

interface DriveSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  driveStatus: DriveStatusResponse | null;
  onVerifyConnection: () => Promise<void>;
  isVerifying: boolean;
}

export function DriveSetupModal({
  isOpen,
  onClose,
  driveStatus,
  onVerifyConnection,
  isVerifying,
}: DriveSetupModalProps) {
  const [manifestText, setManifestText] = useState('');
  const [scriptText, setScriptText] = useState('');
  const [isLoadingScript, setIsLoadingScript] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<'manifest' | 'script' | null>(null);

  useEffect(() => {
    if (!isOpen || (scriptText && manifestText)) return;
    let active = true;
    setIsLoadingScript(true);
    fetch('/api/drive/setup-script')
      .then((res) => res.json())
      .then((data: { ok?: boolean; manifest?: string; script?: string }) => {
        if (!active || !data.ok) return;
        if (data.manifest) setManifestText(data.manifest);
        if (data.script) setScriptText(data.script);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIsLoadingScript(false);
      });
    return () => {
      active = false;
    };
  }, [isOpen, scriptText, manifestText]);

  if (!isOpen) return null;

  async function handleCopy(target: 'manifest' | 'script', content: string) {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedTarget(target);
      setTimeout(() => setCopiedTarget(null), 2200);
    } catch {
      // Clipboard fallback ignored
    }
  }

  const isConnected = Boolean(driveStatus?.configured && driveStatus?.unlocked && driveStatus?.reachable);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-setup-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F172A]/45 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] px-6 py-4">
          <div className="min-w-0">
            <h2
              id="drive-setup-modal-title"
              className="text-base font-semibold tracking-tight text-[#0F172A]"
            >
              Personal Google Drive Bridge Setup (App-Folder Only)
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-[#475569]">
              Scoped strictly to <span className="font-mono text-[#0F172A]">drive.file</span>—Google never requests full Drive access and only exposes the <span className="font-mono text-[#0F172A]">CueScript/</span> folder created by this script.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close setup guide"
            className="rounded-lg p-1.5 text-[#64748B] transition-colors hover:bg-[#F1F5F9] hover:text-[#0F172A] cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Live Status Summary */}
          <div
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-xs ${
              isConnected
                ? 'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]'
                : driveStatus?.configured && !driveStatus.reachable
                  ? 'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]'
                  : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#334155]'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <HardDrive className="h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                {isConnected ? (
                  <p className="font-medium">
                    Connected to Google Drive ({driveStatus?.folderName || 'CueScript'}/) ·{' '}
                    <span className="font-mono tabular-nums">
                      {driveStatus?.transcriptCount ?? 0} videos
                    </span>{' '}
                    ·{' '}
                    <span className="font-mono tabular-nums">
                      {driveStatus?.audioCount ?? 0} audio files
                    </span>
                  </p>
                ) : driveStatus?.configured && !driveStatus.unlocked ? (
                  <p className="font-medium">
                    Drive Bridge configured and protected by your OWNER_PASSCODE. Unlock it from the workspace bar.
                  </p>
                ) : driveStatus?.configured && !driveStatus.reachable ? (
                  <p className="font-medium">
                    Bridge unreachable: {driveStatus.error || 'Verify your Apps Script deployment and secret.'}
                  </p>
                ) : driveStatus?.configError ? (
                  <p className="font-medium">{driveStatus.configError}</p>
                ) : (
                  <p className="font-medium">
                    Waiting for <span className="font-mono">DRIVE_BRIDGE_URL</span> and{' '}
                    <span className="font-mono">DRIVE_BRIDGE_SECRET</span> in AI Studio Settings → Secrets.
                  </p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void onVerifyConnection()}
              disabled={isVerifying}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-current/25 bg-white px-3 py-1.5 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] disabled:opacity-50 cursor-pointer"
            >
              {isVerifying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Verify Connection
            </button>
          </div>

          {/* Least-Privilege & Per-Video Folder Notice */}
          <div className="flex items-start gap-2.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-xs text-[#334155]">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#16A34A]" aria-hidden="true" />
            <p className="leading-relaxed">
              Each transcribed video gets its own folder <span className="font-mono text-[#0F172A]">CueScript/&lt;FB|Insta|YT&gt; - &lt;Title (50 chars)&gt;/</span> containing <span className="font-mono">audio.*</span>, <span className="font-mono">transcript.json/.srt/.txt</span>, and <span className="font-mono">analysis.md</span>. Consolidated stock picks are archived inside <span className="font-mono text-[#0F172A]">CueScript/Recommendations/</span> as <span className="font-mono">Recommendations_&lt;dd/mm/yyyy HH:MM:SS&gt;.md/.json</span>. Scoped strictly to <span className="font-mono text-[#0F172A]">drive.file</span>—your other Drive files remain hidden.
            </p>
          </div>

          {/* 4-Step Checklist */}
          <ol className="space-y-3 text-sm text-[#334155]">
            <li className="flex gap-3">
              <span className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-[#E11D48]">
                01.
              </span>
              <div>
                <p className="font-semibold text-[#0F172A]">
                  Reveal &amp; update <span className="font-mono">appsscript.json</span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-[#475569]">
                  In Apps Script, click the <strong>gear icon (Project Settings)</strong> on the left sidebar and check <strong>Show “appsscript.json” manifest file in editor</strong>. Return to the <strong>Editor (&lt;&gt;)</strong>, click <span className="font-mono text-[#0F172A]">appsscript.json</span>, replace its contents with the JSON below, and save (<span className="font-mono">Ctrl+S</span>).
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-[#E11D48]">
                02.
              </span>
              <div>
                <p className="font-semibold text-[#0F172A]">
                  Replace <span className="font-mono">Code.gs</span> with the <span className="font-mono">drive.file</span> script
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-[#475569]">
                  Click <span className="font-mono text-[#0F172A]">Code.gs</span>, select all and replace it with the updated script below (zero <span className="font-mono">DriveApp</span> calls), and save (<span className="font-mono">Ctrl+S</span>).
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-[#E11D48]">
                03.
              </span>
              <div>
                <p className="font-semibold text-[#0F172A]">
                  Set <span className="font-mono">BRIDGE_SECRET</span> &amp; deploy a New Version
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-[#475569]">
                  In <strong>Project Settings → Script Properties</strong>, add Property <span className="font-mono text-[#0F172A]">BRIDGE_SECRET</span> with your own strong random secret. Then click <strong>Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy</strong>, and click <strong>Authorize access</strong> (confirm it shows only specific-files Drive access).
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-[#E11D48]">
                04.
              </span>
              <div>
                <p className="font-semibold text-[#0F172A]">
                  Add secrets in AI Studio Settings → Secrets
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-[#475569]">
                  Add <span className="font-mono text-[#0F172A]">DRIVE_BRIDGE_URL</span> (your Web App URL) and <span className="font-mono text-[#0F172A]">DRIVE_BRIDGE_SECRET</span> (matching <span className="font-mono">BRIDGE_SECRET</span>). Optionally add <span className="font-mono text-[#0F172A]">OWNER_PASSCODE</span> if you ever share the app link.
                </p>
              </div>
            </li>
          </ol>

          {/* Copyable appsscript.json */}
          <div className="overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#0F172A]">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
              <span className="font-mono text-xs font-medium text-slate-200">appsscript.json</span>
              <button
                type="button"
                onClick={() => void handleCopy('manifest', manifestText)}
                disabled={isLoadingScript || !manifestText}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 py-1 text-xs font-medium text-[#0F172A] transition-colors hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
              >
                {copiedTarget === 'manifest' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-[#16A34A]" aria-hidden="true" />
                    Copied appsscript.json
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Copy appsscript.json
                  </>
                )}
              </button>
            </div>
            <pre className="max-h-48 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-slate-200">
              {isLoadingScript ? 'Loading appsscript.json...' : manifestText}
            </pre>
          </div>

          {/* Copyable Code.gs */}
          <div className="overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#0F172A]">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
              <span className="font-mono text-xs font-medium text-slate-200">Code.gs</span>
              <button
                type="button"
                onClick={() => void handleCopy('script', scriptText)}
                disabled={isLoadingScript || !scriptText}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 py-1 text-xs font-medium text-[#0F172A] transition-colors hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
              >
                {copiedTarget === 'script' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-[#16A34A]" aria-hidden="true" />
                    Copied Code.gs
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Copy Code.gs
                  </>
                )}
              </button>
            </div>
            <pre className="max-h-64 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-slate-200">
              {isLoadingScript ? 'Loading Code.gs template...' : scriptText}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-[#E2E8F0] bg-[#F8FAFC] px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

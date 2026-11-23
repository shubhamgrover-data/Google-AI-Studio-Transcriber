import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react';
import type { TranscriptJob } from '../types/transcript';
import { formatDriveVideoFolderName, truncateTitle } from '../utils/exporters';

interface ConfirmDeleteModalProps {
  job: TranscriptJob | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirmLocalOnly: () => void;
  onConfirmDeleteDrive: () => void;
}

export function ConfirmDeleteModal({
  job,
  isDeleting,
  onCancel,
  onConfirmLocalOnly,
  onConfirmDeleteDrive,
}: ConfirmDeleteModalProps) {
  if (!job) return null;

  const folderDisplayName =
    job.driveFolderName || formatDriveVideoFolderName(job.sourceType, job.title);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F172A]/45 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDeleting) onCancel();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] px-6 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#BE123C]" aria-hidden="true" />
            <div>
              <h2
                id="confirm-delete-modal-title"
                className="text-base font-semibold tracking-tight text-[#0F172A]"
              >
                Delete Drive-backed transcript?
              </h2>
              <p className="mt-0.5 text-xs text-[#475569]">
                Choose whether to remove this entry only from your current view or move its video folder to Google Drive Trash.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isDeleting}
            onClick={onCancel}
            aria-label="Cancel deletion"
            className="rounded-lg p-1.5 text-[#64748B] transition-colors hover:bg-[#F1F5F9] hover:text-[#0F172A] disabled:opacity-50 cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 px-6 py-4 text-xs text-[#334155]">
          <p title={job.title} className="font-medium text-[#0F172A]">
            {truncateTitle(job.title, 50)}
          </p>
          {job.sourceKey && (
            <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 font-mono text-[11px] leading-relaxed text-[#475569]">
              <p className="font-sans text-xs font-medium text-[#0F172A]">
                Google Drive folder moved to Trash if selected:
              </p>
              <p className="mt-1.5 font-semibold text-[#0F172A]">
                CueScript/{folderDisplayName}/
              </p>
              <ul className="mt-1 space-y-0.5 pl-3">
                {job.driveAudioFileId && <li>audio.* (archived audio)</li>}
                <li>transcript.json, transcript.srt, transcript.txt</li>
                {job.analysis && <li>analysis.md (Gen AI Analysis)</li>}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#E2E8F0] bg-[#F8FAFC] px-6 py-3">
          <button
            type="button"
            disabled={isDeleting}
            onClick={onCancel}
            className="rounded-lg border border-[#CBD5E1] bg-white px-3.5 py-2 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] disabled:opacity-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isDeleting}
            onClick={onConfirmLocalOnly}
            className="rounded-lg border border-[#CBD5E1] bg-white px-3.5 py-2 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] disabled:opacity-50 cursor-pointer"
          >
            Remove from view only
          </button>
          <button
            type="button"
            disabled={isDeleting}
            onClick={onConfirmDeleteDrive}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#BE123C] disabled:opacity-50 cursor-pointer"
          >
            {isDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Move Drive files to Trash
          </button>
        </div>
      </div>
    </div>
  );
}

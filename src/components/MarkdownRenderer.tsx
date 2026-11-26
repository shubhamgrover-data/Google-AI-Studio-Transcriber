import { useMemo } from 'react';
import type { ReactNode } from 'react';

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; language: string; code: string }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code blocks
    const fenceMatch = trimmed.match(/^```(\w*)$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || '';
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i += 1;
      }
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    // Tables
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const headers = splitTableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes('|')) break;
        if (isTableSeparatorLine(rowLine)) {
          i += 1;
          continue;
        }
        rows.push(splitTableRow(rowLine));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Unordered list
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (
        !cur ||
        cur.startsWith('```') ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(cur) ||
        /^#{1,4}\s+/.test(cur) ||
        /^[-*•]\s+/.test(cur) ||
        /^\d+[.)]\s+/.test(cur) ||
        (cur.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(cur);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}

function renderInlineFormatting(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(
        <strong key={`b_${keyIdx++}`} className="font-semibold text-[#0F172A]">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      tokens.push(
        <em key={`i_${keyIdx++}`} className="italic text-[#334155]">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(
        <code
          key={`c_${keyIdx++}`}
          className="rounded bg-[#F1F5F9] px-1.5 py-0.5 font-mono text-[11.5px] text-[#0F172A]"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens;
}

function isMonospaceColumn(header: string): boolean {
  const lower = header.toLowerCase();
  return (
    lower.includes('atf #') ||
    lower === '#' ||
    lower.includes('timestamp') ||
    lower.includes('price') ||
    lower.includes('target') ||
    lower.includes('level')
  );
}

function isStanceColumn(header: string): boolean {
  return header.toLowerCase().includes('stance') || header.toLowerCase().includes('category');
}

interface MarkdownRendererProps {
  markdown: string;
  /** Compact mode for floating Ask AI chat cards; default mode for full Gen AI Analysis tables */
  compact?: boolean;
}

export function MarkdownRenderer({ markdown, compact = false }: MarkdownRendererProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);

  return (
    <div className={compact ? 'space-y-3' : 'space-y-5'}>
      {blocks.map((block, idx) => {
        if (block.type === 'hr') {
          return <hr key={`hr_${idx}`} className="border-[#E2E8F0]" />;
        }

        if (block.type === 'code') {
          return (
            <pre
              key={`code_${idx}`}
              className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 font-mono text-xs leading-relaxed text-[#0F172A]"
            >
              <code>{block.code}</code>
            </pre>
          );
        }

        if (block.type === 'heading') {
          if (compact) {
            return (
              <h4
                key={`h_${idx}`}
                className={`font-semibold tracking-tight text-[#0F172A] ${
                  block.level <= 2 ? 'pt-1 text-[14px]' : 'pt-0.5 text-[13px]'
                }`}
              >
                {renderInlineFormatting(block.text)}
              </h4>
            );
          }
          return (
            <h3
              key={`h_${idx}`}
              className={`font-semibold tracking-tight text-[#0F172A] ${
                block.level <= 2 ? 'pt-2 text-lg' : 'pt-1 text-base'
              }`}
            >
              {renderInlineFormatting(block.text)}
            </h3>
          );
        }

        if (block.type === 'table') {
          return (
            <div
              key={`t_${idx}`}
              className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-white"
            >
              <table
                className={`w-full border-collapse text-left ${
                  compact ? 'min-w-[340px] text-xs' : 'min-w-[540px] text-sm'
                }`}
              >
                <thead>
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                    {block.headers.map((header, hIdx) => (
                      <th
                        key={`th_${hIdx}`}
                        className={`${
                          compact ? 'px-2.5 py-2 text-[11px]' : 'px-3.5 py-2.5 text-xs'
                        } font-semibold text-[#475569] ${
                          isMonospaceColumn(header) || isStanceColumn(header)
                            ? 'whitespace-nowrap'
                            : ''
                        }`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {block.rows.map((row, rIdx) => (
                    <tr
                      key={`tr_${rIdx}`}
                      className="transition-colors hover:bg-[#F8FAFC]"
                    >
                      {block.headers.map((header, cIdx) => {
                        const cell = row[cIdx] ?? '';
                        const mono = isMonospaceColumn(header);
                        const stance = isStanceColumn(header);
                        return (
                          <td
                            key={`td_${cIdx}`}
                            className={`align-top ${
                              compact ? 'px-2.5 py-2 leading-snug' : 'px-3.5 py-2.5 leading-relaxed'
                            } ${
                              mono
                                ? 'font-mono text-[11.5px] tabular-nums text-[#0F172A]'
                                : stance
                                  ? 'whitespace-nowrap text-xs font-medium text-[#0F172A]'
                                  : compact
                                    ? 'text-xs text-[#1E293B]'
                                    : 'text-sm text-[#1E293B]'
                            }`}
                          >
                            {renderInlineFormatting(cell)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag
              key={`l_${idx}`}
              className={`${block.ordered ? 'list-decimal' : 'list-disc'} ${
                compact ? 'space-y-1 pl-4 text-[13px]' : 'space-y-1.5 pl-5 text-sm'
              } text-[#334155]`}
            >
              {block.items.map((item, iIdx) => (
                <li key={`li_${iIdx}`} className="leading-relaxed">
                  {renderInlineFormatting(item)}
                </li>
              ))}
            </ListTag>
          );
        }

        if (compact) {
          return (
            <p key={`p_${idx}`} className="text-[13px] leading-[1.6] text-[#1E293B]">
              {renderInlineFormatting(block.text)}
            </p>
          );
        }

        return (
          <p
            key={`p_${idx}`}
            className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-sm leading-relaxed text-[#334155]"
          >
            {renderInlineFormatting(block.text)}
          </p>
        );
      })}
    </div>
  );
}

// A deterministic, generated markdown document for measuring the viewer on large inputs.
// Usage (as a module): import { largeDocument } from './large-document.mjs'; largeDocument(3000)
// Usage (CLI):         node scripts/large-document.mjs 3000 > /tmp/large.md
// Every section has a heading and a paragraph; every 5th adds a sub-section with a list, every 50th a
// table and every 100th a fenced code block, so the reading aids (outline, search, read-aloud, folding)
// all have realistic work to do. No Mermaid: its rendering is asynchronous and would dominate the timing.
import { fileURLToPath } from 'node:url';

const TOPICS = ['Ingestion', 'Storage', 'Indexing', 'Queries', 'Caching', 'Replication', 'Backups', 'Alerts'];

export function largeDocument(sections = 3000) {
  const out = ['# A large generated document', '', `This document has ${sections} sections.`, ''];
  for (let i = 1; i <= sections; i++) {
    const topic = TOPICS[i % TOPICS.length];
    out.push(`## Section ${i}: ${topic}`, '');
    out.push(`Paragraph ${i} explains how **${topic.toLowerCase()}** behaves under load, with a [link](#section-${i}) and some \`inline code\`.`, '');
    if (i % 5 === 0) {
      out.push(`### Detail ${i}`, '', `- First point about ${topic.toLowerCase()} ${i}`, `- Second point about ${topic.toLowerCase()} ${i}`, '');
    }
    if (i % 50 === 0) {
      out.push('| Metric | Value |', '|---|---|', `| Requests | ${i * 10} |`, `| Errors | ${i % 7} |`, '');
    }
    if (i % 100 === 0) {
      out.push('```js', `const section = ${i};`, 'console.log(section);', '```', '');
    }
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(largeDocument(Number(process.argv[2] || 3000)));
}

import { describe, it, expect } from 'vitest';
import {
  parseCharter,
  serializeCharter,
  detectConceptTasks,
  absorbText,
  type CharterFields,
} from './charter';
import type { FpTask } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(content: string, description = ''): FpTask {
  return {
    id: 'test',
    content,
    description,
    cardId: 'test-card',
    labels: [],
    due: null,
    priority: 1,
    isCompleted: false,
    url: '',
    meta: {},
  };
}

// ─── parseCharter ─────────────────────────────────────────────────────────────

describe('parseCharter', () => {
  it('returns empty fields for empty input', () => {
    expect(parseCharter('')).toEqual({ msc: '', conception: '', planning: '', execution: '' });
  });

  it('returns empty fields for whitespace-only input', () => {
    expect(parseCharter('   \n  ')).toEqual({ msc: '', conception: '', planning: '', execution: '' });
  });

  it('parses all four sections', () => {
    const desc = [
      '## Minimum Standard of Care',
      'Kitchen is clean to guest-ready standard.',
      '',
      '## Conception',
      'Notice when supplies run low.',
      '',
      '## Planning',
      'Order weekly shop on Thursday.',
      '',
      '## Execution',
      'Carry out the shop before Friday.',
    ].join('\n');

    const fields = parseCharter(desc);
    expect(fields.msc).toBe('Kitchen is clean to guest-ready standard.');
    expect(fields.conception).toBe('Notice when supplies run low.');
    expect(fields.planning).toBe('Order weekly shop on Thursday.');
    expect(fields.execution).toBe('Carry out the shop before Friday.');
  });

  it('missing sections default to empty string', () => {
    const desc = '## Minimum Standard of Care\nDone means done.';
    const fields = parseCharter(desc);
    expect(fields.msc).toBe('Done means done.');
    expect(fields.conception).toBe('');
    expect(fields.planning).toBe('');
    expect(fields.execution).toBe('');
  });

  it('preserves multi-line section content', () => {
    const desc = '## Conception\nLine one.\nLine two.\nLine three.';
    const fields = parseCharter(desc);
    expect(fields.conception).toBe('Line one.\nLine two.\nLine three.');
  });

  it('tolerates content before first section header', () => {
    const desc = 'Some preamble\n## Execution\nDo it.';
    const fields = parseCharter(desc);
    expect(fields.execution).toBe('Do it.');
    expect(fields.msc).toBe('');
  });
});

// ─── serializeCharter ─────────────────────────────────────────────────────────

describe('serializeCharter', () => {
  it('emits all four sections when all non-empty', () => {
    const fields: CharterFields = {
      msc: 'Clean.',
      conception: 'Notice.',
      planning: 'Plan.',
      execution: 'Do it.',
    };
    const result = serializeCharter(fields);
    expect(result).toContain('## Minimum Standard of Care\nClean.');
    expect(result).toContain('## Conception\nNotice.');
    expect(result).toContain('## Planning\nPlan.');
    expect(result).toContain('## Execution\nDo it.');
  });

  it('skips empty sections', () => {
    const fields: CharterFields = { msc: 'Done.', conception: '', planning: '', execution: '' };
    const result = serializeCharter(fields);
    expect(result).toBe('## Minimum Standard of Care\nDone.');
    expect(result).not.toContain('## Conception');
  });

  it('returns empty string when all fields are empty', () => {
    const fields: CharterFields = { msc: '', conception: '', planning: '', execution: '' };
    expect(serializeCharter(fields)).toBe('');
  });
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe('parseCharter / serializeCharter round-trip', () => {
  it('round-trips all four fields', () => {
    const original: CharterFields = {
      msc: 'Kitchen clean.',
      conception: 'Notice supplies.',
      planning: 'Shop Thursday.',
      execution: 'Do the shop.',
    };
    const serialized = serializeCharter(original);
    const parsed = parseCharter(serialized);
    expect(parsed.msc).toBe(original.msc);
    expect(parsed.conception).toBe(original.conception);
    expect(parsed.planning).toBe(original.planning);
    expect(parsed.execution).toBe(original.execution);
  });

  it('round-trips partial fields', () => {
    const original: CharterFields = { msc: 'Done.', conception: '', planning: 'Plan it.', execution: '' };
    const serialized = serializeCharter(original);
    const parsed = parseCharter(serialized);
    expect(parsed.msc).toBe('Done.');
    expect(parsed.conception).toBe('');
    expect(parsed.planning).toBe('Plan it.');
    expect(parsed.execution).toBe('');
  });
});

// ─── detectConceptTasks ────────────────────────────────────────────────────────

describe('detectConceptTasks', () => {
  it('matches seeded template task with colon', () => {
    const tasks = [makeTask('Minimum Standard of Care: define what "done" looks like')];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('msc');
  });

  it('matches Conception with colon', () => {
    const tasks = [makeTask('Conception: notice & anticipate what this needs')];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('conception');
  });

  it('matches Planning with colon', () => {
    const tasks = [makeTask('Planning: research options, decide, and schedule')];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('planning');
  });

  it('matches Execution with colon', () => {
    const tasks = [makeTask('Execution: carry it out to the agreed standard')];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('execution');
  });

  it('matches with dash separator', () => {
    const tasks = [makeTask('Planning - book the holiday venue')];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('planning');
  });

  it('matches "Planning: book flights" (by design — absorb confirm shows it)', () => {
    const tasks = [makeTask('Planning: book flights')];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('planning');
  });

  it('does NOT match "Planning the trip" (no colon or dash)', () => {
    const tasks = [makeTask('Planning the trip')];
    expect(detectConceptTasks(tasks)).toHaveLength(0);
  });

  it('does NOT match "plan the evening" (no colon/dash, not a phase label)', () => {
    const tasks = [makeTask('plan the evening')];
    expect(detectConceptTasks(tasks)).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const tasks = [makeTask('EXECUTION: do the thing')];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].field).toBe('execution');
  });

  it('returns empty for empty task list', () => {
    expect(detectConceptTasks([])).toHaveLength(0);
  });

  it('returns multiple matches from multiple tasks', () => {
    const tasks = [
      makeTask('Conception: notice things'),
      makeTask('Execution: do things'),
      makeTask('Regular todo without colon'),
    ];
    const matches = detectConceptTasks(tasks);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.field)).toEqual(['conception', 'execution']);
  });
});

// ─── absorbText ────────────────────────────────────────────────────────────────

describe('absorbText', () => {
  it('strips phase prefix and keeps remainder', () => {
    const task = makeTask('Minimum Standard of Care: define what "done" looks like');
    expect(absorbText(task)).toBe('define what "done" looks like');
  });

  it('strips "Planning: " prefix', () => {
    const task = makeTask('Planning: book flights');
    expect(absorbText(task)).toBe('book flights');
  });

  it('appends description when present', () => {
    const task = makeTask('Conception: notice when things are needed', 'Watch the calendar for upcoming events.');
    expect(absorbText(task)).toBe('notice when things are needed\nWatch the calendar for upcoming events.');
  });

  it('returns description alone when stripped content is empty', () => {
    const task = makeTask('Execution:', 'Do the thing properly.');
    expect(absorbText(task)).toBe('Do the thing properly.');
  });

  it('handles dash separator', () => {
    const task = makeTask('Planning - research and decide');
    expect(absorbText(task)).toBe('research and decide');
  });
});

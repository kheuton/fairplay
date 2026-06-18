/**
 * Tests for the feed builder (src/feed.ts).
 *
 * Covers:
 *   • isCarrierTask: excludes FP-item, FP-config, FP-charter labels
 *   • taskToVEvent: excludes no-due, carrier, and completed tasks
 *   • taskToVEvent: includes valid tasks with correct SUMMARY/UID
 *   • taskToVEvent: all-day vs timed events
 *   • taskToVEvent: recurring → RRULE; unparseable → single event with X-FP-RECUR
 *   • taskToVEvent: parseFp strips FP:: line from DESCRIPTION
 *   • buildFeed: all-day ICS round-trip (VCALENDAR wrapper, multiple events)
 *   • buildFeed: empty result when all tasks are filtered
 */

import { describe, it, expect } from 'vitest';
import { isCarrierTask, taskToVEvent, buildFeed } from './feed.js';
import type { RawTask } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<RawTask> = {}): RawTask {
  return {
    id: 'task1',
    content: 'Test task',
    description: '',
    labels: [],
    project_id: 'proj1',
    section_id: null,
    parent_id: null,
    due: { date: '2025-06-17', string: 'every day', is_recurring: true },
    priority: 1,
    checked: false,
    is_deleted: false,
    added_at: '2025-01-01T00:00:00Z',
    completed_at: null,
    updated_at: '2025-01-01T00:00:00Z',
    child_order: 0,
    ...overrides,
  };
}

const FIXED_NOW = new Date('2025-06-17T00:00:00Z');

// ---------------------------------------------------------------------------
// isCarrierTask
// ---------------------------------------------------------------------------

describe('isCarrierTask', () => {
  it('returns false for no labels', () => {
    expect(isCarrierTask([])).toBe(false);
  });

  it('returns false for unrelated labels', () => {
    expect(isCarrierTask(['priority', 'work'])).toBe(false);
  });

  it('returns true for FP-item', () => {
    expect(isCarrierTask(['FP-item'])).toBe(true);
  });

  it('returns true for FP-config', () => {
    expect(isCarrierTask(['FP-config'])).toBe(true);
  });

  it('returns true for FP-charter', () => {
    expect(isCarrierTask(['FP-charter'])).toBe(true);
  });

  it('returns true when carrier label is mixed with others', () => {
    expect(isCarrierTask(['priority', 'FP-item', 'work'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// taskToVEvent — exclusion rules
// ---------------------------------------------------------------------------

describe('taskToVEvent — exclusion', () => {
  it('returns null for completed task', () => {
    expect(taskToVEvent(makeTask({ checked: true }), FIXED_NOW)).toBeNull();
  });

  it('returns null for task with no due date', () => {
    expect(taskToVEvent(makeTask({ due: null }), FIXED_NOW)).toBeNull();
  });

  it('returns null for FP-item carrier task', () => {
    expect(taskToVEvent(makeTask({ labels: ['FP-item'] }), FIXED_NOW)).toBeNull();
  });

  it('returns null for FP-config carrier task', () => {
    expect(taskToVEvent(makeTask({ labels: ['FP-config'] }), FIXED_NOW)).toBeNull();
  });

  it('returns null for FP-charter carrier task', () => {
    expect(taskToVEvent(makeTask({ labels: ['FP-charter'] }), FIXED_NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// taskToVEvent — inclusion and content
// ---------------------------------------------------------------------------

describe('taskToVEvent — content', () => {
  it('returns a string for valid task', () => {
    const result = taskToVEvent(makeTask(), FIXED_NOW);
    expect(typeof result).toBe('string');
  });

  it('includes correct UID', () => {
    const result = taskToVEvent(makeTask({ id: 'abc123' }), FIXED_NOW);
    expect(result).toContain('UID:abc123@fairplay-skylight\r\n');
  });

  it('uses task content as SUMMARY', () => {
    const result = taskToVEvent(makeTask({ content: 'Vacuum living room' }), FIXED_NOW);
    expect(result).toContain('SUMMARY:Vacuum living room\r\n');
  });

  it('all-day event uses VALUE=DATE DTSTART', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'every day', is_recurring: true } }),
      FIXED_NOW
    );
    expect(result).toContain('DTSTART;VALUE=DATE:20250617\r\n');
  });

  it('timed event uses UTC DTSTART', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', datetime: '2025-06-17T08:00:00Z', string: 'every day', is_recurring: true } }),
      FIXED_NOW
    );
    expect(result).toContain('DTSTART:20250617T080000Z\r\n');
    expect(result).not.toContain('VALUE=DATE');
  });

  it('strips FP:: line from description', () => {
    const desc = 'Clean the floors\nFP::{"part":"daily"}';
    const result = taskToVEvent(makeTask({ description: desc }), FIXED_NOW);
    expect(result).toContain('DESCRIPTION:Clean the floors\r\n');
    expect(result).not.toContain('FP::');
  });

  it('omits DESCRIPTION when empty', () => {
    const result = taskToVEvent(makeTask({ description: '' }), FIXED_NOW);
    expect(result).not.toContain('DESCRIPTION:');
  });
});

// ---------------------------------------------------------------------------
// taskToVEvent — recurrence
// ---------------------------------------------------------------------------

describe('taskToVEvent — recurrence', () => {
  it('includes RRULE for parseable recurring task', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'every day', is_recurring: true } }),
      FIXED_NOW
    );
    expect(result).toContain('RRULE:FREQ=DAILY;INTERVAL=1\r\n');
  });

  it('includes RRULE for weekly task', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'every monday', is_recurring: true } }),
      FIXED_NOW
    );
    expect(result).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO\r\n');
  });

  it('has no RRULE for non-recurring task', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'Jun 17', is_recurring: false } }),
      FIXED_NOW
    );
    expect(result).not.toContain('RRULE:');
  });

  it('has no RRULE for unparseable recurring task (safe fallback)', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'every other week', is_recurring: true } }),
      FIXED_NOW
    );
    expect(result).not.toContain('RRULE:');
  });

  it('stores X-FP-RECUR for recurring task', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'every week', is_recurring: true } }),
      FIXED_NOW
    );
    expect(result).toContain('X-FP-RECUR:every week\r\n');
  });

  it('stores X-FP-RECUR with [unparseable→single] suffix for unparseable', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'every other week', is_recurring: true } }),
      FIXED_NOW
    );
    expect(result).toContain('X-FP-RECUR:every other week [unparseable→single]\r\n');
  });

  it('does not include X-FP-RECUR for non-recurring task', () => {
    const result = taskToVEvent(
      makeTask({ due: { date: '2025-06-17', string: 'Jun 17', is_recurring: false } }),
      FIXED_NOW
    );
    expect(result).not.toContain('X-FP-RECUR:');
  });
});

// ---------------------------------------------------------------------------
// buildFeed
// ---------------------------------------------------------------------------

describe('buildFeed', () => {
  it('returns a VCALENDAR with correct headers for empty list', () => {
    const ics = buildFeed([], 'Test Calendar', FIXED_NOW);
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('END:VCALENDAR\r\n');
    expect(ics).toContain('VERSION:2.0\r\n');
    expect(ics).toContain("X-WR-CALNAME:Test Calendar\r\n");
  });

  it('returns no VEVENTs when all tasks are filtered', () => {
    const tasks = [
      makeTask({ due: null }),
      makeTask({ checked: true }),
      makeTask({ labels: ['FP-item'] }),
    ];
    const ics = buildFeed(tasks, 'Test', FIXED_NOW);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('includes an event for each valid task', () => {
    const tasks = [
      makeTask({ id: 'a', content: 'Task A', due: { date: '2025-06-17', string: 'every day', is_recurring: true } }),
      makeTask({ id: 'b', content: 'Task B', due: { date: '2025-06-18', string: 'every week', is_recurring: true } }),
    ];
    const ics = buildFeed(tasks, 'Test', FIXED_NOW);
    expect(ics).toContain('a@fairplay-skylight');
    expect(ics).toContain('b@fairplay-skylight');
    expect(ics).toContain('SUMMARY:Task A');
    expect(ics).toContain('SUMMARY:Task B');
  });

  it('skips carrier tasks within a mixed list', () => {
    const tasks = [
      makeTask({ id: 'good', content: 'Real chore', due: { date: '2025-06-17', string: 'every day', is_recurring: true } }),
      makeTask({ id: 'bad', content: 'Carrier', labels: ['FP-item'], due: { date: '2025-06-17', string: 'every day', is_recurring: true } }),
    ];
    const ics = buildFeed(tasks, 'Test', FIXED_NOW);
    expect(ics).toContain('good@fairplay-skylight');
    expect(ics).not.toContain('bad@fairplay-skylight');
  });

  it('uses the provided calName as X-WR-CALNAME', () => {
    const ics = buildFeed([], "Kyle's Fair Play Chores", FIXED_NOW);
    expect(ics).toContain("X-WR-CALNAME:Kyle's Fair Play Chores\r\n");
  });
});

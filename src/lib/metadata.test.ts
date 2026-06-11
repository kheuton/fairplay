import { describe, it, expect } from 'vitest';
import { parseFp, withFp } from './metadata';
import type { FpMeta } from './types';

describe('parseFp', () => {
  it('returns empty meta and clean string for empty input', () => {
    expect(parseFp('')).toEqual({ meta: {}, clean: '' });
  });

  it('returns empty meta and original text when no FP:: line', () => {
    const result = parseFp('some description\nwith lines');
    expect(result.meta).toEqual({});
    expect(result.clean).toBe('some description\nwith lines');
  });

  it('parses a simple FP:: last line', () => {
    const desc = 'My task description\nFP::{"part":"wheel"}';
    const { meta, clean } = parseFp(desc);
    expect(meta).toEqual({ part: 'wheel' });
    expect(clean).toBe('My task description');
  });

  it('parses FP:: when it is the only line', () => {
    const { meta, clean } = parseFp('FP::{"inv":{"icon":"tp","w":2,"h":2,"x":0,"y":0,"stack":30,"count":14,"verified":"2026-06-01","rate":{"n":0.7,"per":"day"},"warn":{"mode":"days","value":7}}}');
    expect(meta.inv?.icon).toBe('tp');
    expect(meta.inv?.count).toBe(14);
    expect(clean).toBe('');
  });

  it('handles malformed JSON gracefully — returns empty meta', () => {
    const desc = 'good description\nFP::{bad json!!}';
    const { meta, clean } = parseFp(desc);
    expect(meta).toEqual({});
    expect(clean).toBe('good description\nFP::{bad json!!}');
  });

  it('handles FP:: not on last line — treats line as part of clean text', () => {
    const desc = 'FP::{"part":"a"}\nNOT last line';
    const { meta, clean } = parseFp(desc);
    expect(meta).toEqual({});
    expect(clean).toBe('FP::{"part":"a"}\nNOT last line');
  });

  it('preserves multi-line clean content', () => {
    const desc = 'line1\nline2\nline3\nFP::{"zone":"kitchen"}';
    const { meta, clean } = parseFp(desc);
    expect(meta).toEqual({ zone: 'kitchen' });
    expect(clean).toBe('line1\nline2\nline3');
  });

  it('tolerates truncated/empty json value', () => {
    const { meta } = parseFp('FP::');
    expect(meta).toEqual({});
  });

  it('tolerates null json', () => {
    const { meta } = parseFp('FP::null');
    // null parses fine but isn't an object — treat as empty
    expect(meta).toEqual({});
  });
});

describe('withFp', () => {
  it('returns clean text unchanged when meta is empty', () => {
    expect(withFp('hello world', {})).toBe('hello world');
  });

  it('returns empty string unchanged when meta is empty', () => {
    expect(withFp('', {})).toBe('');
  });

  it('appends FP:: line when meta is not empty', () => {
    const result = withFp('my task', { part: 'wheel' });
    expect(result).toBe('my task\nFP::{"part":"wheel"}');
  });

  it('returns only FP:: line when clean is empty and meta is not empty', () => {
    const result = withFp('', { zone: 'garage' });
    expect(result).toBe('FP::{"zone":"garage"}');
  });

  it('round-trips through parseFp', () => {
    const meta: FpMeta = {
      inv: {
        icon: 'tp',
        w: 2,
        h: 2,
        x: 0,
        y: 0,
        stack: 30,
        count: 14,
        verified: '2026-06-01',
        rate: { n: 0.7, per: 'day' },
        warn: { mode: 'days', value: 7 },
      },
    };
    const clean = 'Toilet paper';
    const serialized = withFp(clean, meta);
    const parsed = parseFp(serialized);
    expect(parsed.clean).toBe(clean);
    expect(parsed.meta).toEqual(meta);
  });

  it('round-trips empty clean string', () => {
    const meta: FpMeta = { part: 'door' };
    const serialized = withFp('', meta);
    const parsed = parseFp(serialized);
    expect(parsed.clean).toBe('');
    expect(parsed.meta).toEqual(meta);
  });
});

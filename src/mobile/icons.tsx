/**
 * FAIRPLAY · Mobile line glyphs.
 * Ported from the mobile prototype's `Ic` set. Each is a function returning an
 * inline SVG so call sites read `Ic.menu({ s: 18 })`. No image assets.
 */
import React from 'react';

export interface IconProps {
  /** Square size in px. */
  s?: number;
  /** Stroke color (defaults to currentColor). */
  c?: string;
}

export const Ic = {
  check: ({ s = 16, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M3 8.5l3.2 3.2L13 4.5" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  edit: ({ s = 16, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M10.5 2.5l3 3M2.5 13.5l1-3.3 7.2-7.2 2.3 2.3-7.2 7.2-3.3 1z" stroke={c} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  plus: ({ s = 20, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path d="M10 3v14M3 10h14" stroke={c} strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  chevR: ({ s = 14, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 14 14" fill="none">
      <path d="M5 2l5 5-5 5" stroke={c} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevL: ({ s = 12, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 12 12" fill="none">
      <path d="M8 1L3 6l5 5" stroke={c} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  menu: ({ s = 18, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 18 18" fill="none">
      <path d="M2 4.5h14M2 9h14M2 13.5h10" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  bell: ({ s = 16, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M8 2a4 4 0 00-4 4c0 4-1.5 5-1.5 5h11S12 10 12 6a4 4 0 00-4-4zM6.5 13.5a1.5 1.5 0 003 0" stroke={c} strokeWidth="1.3" fill="none" strokeLinejoin="round" />
    </svg>
  ),
  x: ({ s = 14, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 14 14" fill="none">
      <path d="M3 3l8 8M11 3l-8 8" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  inbox: ({ s = 20, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <path d="M3 3h14v14H3zM3 12h4l1.5 2.2h3L13 12h4" stroke={c} strokeWidth="1.5" strokeLinejoin="round" fill="none" />
    </svg>
  ),
  done: ({ s = 20, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7.5" stroke={c} strokeWidth="1.5" />
      <path d="M6.5 10.2l2.3 2.3L13.5 7.8" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  me: ({ s = 20, c = 'currentColor' }: IconProps = {}) => (
    <svg width={s} height={s} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="6.5" r="3.2" stroke={c} strokeWidth="1.5" />
      <path d="M3.8 17c.6-3.4 3-5.4 6.2-5.4S15.6 13.6 16.2 17" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};

/**
 * FAIRPLAY · InvDetail
 * Detail panel for a single inventory item: stats, log count, rate/warn config,
 * icon picker, and danger zone. Extracted from InventoryView for desktop + mobile reuse.
 */
import React, { useEffect, useState } from 'react';
import type { InvMeta } from '../../lib/types';
import {
  invEst,
  invStatus,
  invFmt,
  invDateLabel,
  invRunout,
  invRateLabel,
  invChip,
} from '../../lib/inventory-math';
import { ItemIcon, ICON_ORDER, ICON_LIB } from '../../shell/icons';
import { Stp, StpNum } from '../../shell/atoms';
import type { ItemWithMeta } from './types';

// ─── InvDetail ────────────────────────────────────────────────────────────────

interface InvDetailProps {
  item: ItemWithMeta;
  onClose: () => void;
  onUpdateMeta: (taskId: string, patch: Partial<InvMeta>) => void;
  onAttest: (taskId: string, count: number) => void;
  onDelete: (taskId: string) => void;
}

export function InvDetail({ item, onClose, onUpdateMeta, onAttest, onDelete }: InvDetailProps) {
  const { inv } = item;
  const est = invEst(inv);
  const st = invStatus(inv);
  const [logN, setLogN] = useState(inv.count);
  const [confirmDel, setConfirmDel] = useState(false);

  // Resync the log field whenever the verified count changes (incl. background refetch).
  useEffect(() => {
    setLogN(inv.count);
  }, [inv.count]);

  // Collapse the delete-confirm only when switching to a different item — a count
  // refetch for the SAME item must not yank the confirm out from under the user.
  useEffect(() => {
    setConfirmDel(false);
  }, [item.taskId]);

  const w = inv.warn ?? { mode: 'days' as const, value: 7 };
  const rstep = inv.rate.n <= 1 ? 0.1 : inv.rate.n <= 5 ? 0.5 : 1;

  const setRate = (n: number) =>
    onUpdateMeta(item.taskId, {
      rate: { ...inv.rate, n: Math.max(0.1, Math.round(n * 10) / 10) },
    });

  const chipText =
    st === 'ok'
      ? 'STOCKED'
      : st === 'low'
      ? `RESTOCK · ${invChip(inv)}`
      : 'OUT OF STOCK';

  return (
    <div className="inv-detail">
      <div className="id-head">
        <div className="id-glyph">
          <ItemIcon name={inv.icon} size={32} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="id-name">{item.name}</div>
          <div style={{ marginTop: 6 }}>
            <span className={`chip ${st}`}>{chipText}</span>
          </div>
        </div>
        <div className="id-x" onClick={onClose}>✕</div>
      </div>

      {/* Stats */}
      <div className="stats small">
        <div className="stat">
          <div className="v">{inv.count}</div>
          <div className="k">VERIFIED {invDateLabel(inv.verified)}</div>
        </div>
        <div className="stat">
          <div className={`v${st !== 'ok' ? ' coral' : ''}`}>{invFmt(est)}</div>
          <div className="k">EST TODAY</div>
        </div>
        <div className="stat">
          <div className={`v sm${st !== 'ok' ? ' coral' : ''}`}>{invRunout(inv)}</div>
          <div className="k">RUNS OUT</div>
        </div>
      </div>

      {/* Log verified count */}
      <div>
        <div className="peek-label mono up"><span>LOG VERIFIED COUNT</span></div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <Stp
            label={String(logN)}
            dec={() => setLogN(Math.max(0, logN - 1))}
            inc={() => setLogN(Math.min(999, logN + 1))}
          />
          <button
            className="btn coral"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => onAttest(item.taskId, logN)}
          >
            LOG AS OF TODAY
          </button>
        </div>
      </div>

      {/* Consumption + alerts */}
      <div>
        <div className="peek-label mono up"><span>CONSUMPTION + ALERTS</span></div>
        <div className="cfg-row">
          <span className="lbl">BURN RATE</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <StpNum
              value={inv.rate.n}
              dec={(base) => setRate(base - rstep)}
              inc={(base) => setRate(base + rstep)}
              onCommit={(n) => onUpdateMeta(item.taskId, { rate: { ...inv.rate, n: Math.max(0.1, Math.round(n * 10) / 10) } })}
              min={0.1}
              max={999}
            />
            <div className="seg mini">
              {(['day', 'week', 'month'] as const).map((p) => (
                <button
                  key={p}
                  className={inv.rate.per === p ? 'on' : ''}
                  onClick={() =>
                    onUpdateMeta(item.taskId, { rate: { ...inv.rate, per: p } })
                  }
                >
                  {{ day: '/DAY', week: '/WK', month: '/MO' }[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="cfg-row">
          <span className="lbl">STACK SIZE</span>
          <StpNum
            value={inv.stack}
            dec={(base) => onUpdateMeta(item.taskId, { stack: Math.max(1, base - (base > 20 ? 5 : 1)) })}
            inc={(base) => onUpdateMeta(item.taskId, { stack: base + (base >= 20 ? 5 : 1) })}
            onCommit={(n) => onUpdateMeta(item.taskId, { stack: Math.max(1, Math.round(n)) })}
            min={1}
            max={9999}
          />
        </div>
        <div className="cfg-row">
          <span className="lbl">WARN WHEN</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="seg mini">
              <button
                className={w.mode === 'days' ? 'on' : ''}
                onClick={() =>
                  onUpdateMeta(item.taskId, {
                    warn: { mode: 'days', value: 7 },
                  })
                }
              >
                ≤ DAYS
              </button>
              <button
                className={w.mode === 'count' ? 'on' : ''}
                onClick={() =>
                  onUpdateMeta(item.taskId, {
                    warn: { mode: 'count', value: 1 },
                  })
                }
              >
                ≤ COUNT
              </button>
            </div>
            <StpNum
              value={w.value}
              dec={(base) => onUpdateMeta(item.taskId, { warn: { ...w, value: Math.max(w.mode === 'count' ? 0.5 : 1, base - (w.mode === 'count' ? 0.5 : 1)) } })}
              inc={(base) => onUpdateMeta(item.taskId, { warn: { ...w, value: base + (w.mode === 'count' ? 0.5 : 1) } })}
              onCommit={(n) => onUpdateMeta(item.taskId, { warn: { ...w, value: w.mode === 'count' ? Math.max(0.5, Math.round(n * 2) / 2) : Math.max(1, Math.round(n)) } })}
              min={w.mode === 'count' ? 0.5 : 1}
              max={9999}
            />
          </div>
        </div>
      </div>

      {/* Icon picker */}
      <div>
        <div className="peek-label mono up">
          <span>ICON</span>
          <span>{ICON_ORDER.length}</span>
        </div>
        <div className="icon-pick" style={{ marginTop: 10 }}>
          {ICON_ORDER.map((k) => (
            <div
              key={k}
              className={`ip${inv.icon === k ? ' on' : ''}`}
              title={ICON_LIB[k]?.label ?? k}
              onClick={() => onUpdateMeta(item.taskId, { icon: k })}
            >
              <ItemIcon name={k} size={20} />
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div
        className="mono"
        style={{
          fontSize: 9,
          color: 'var(--ink-4)',
          letterSpacing: '.08em',
          lineHeight: 1.7,
        }}
      >
        BURNS {invRateLabel(inv)} · VERIFIED {inv.count} ON{' '}
        {invDateLabel(inv.verified)} · EST {invFmt(est)} TODAY · RUNS OUT{' '}
        {invRunout(inv)}
      </div>

      {/* Danger zone */}
      <div className="inv-danger">
        {confirmDel ? (
          <div className="inv-danger-confirm">
            <span className="mono up-s warn-txt">REMOVE "{item.name}" PERMANENTLY?</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn danger" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onDelete(item.taskId)}>DELETE</button>
              <button className="btn ghost" onClick={() => setConfirmDel(false)}>CANCEL</button>
            </div>
          </div>
        ) : (
          <button className="btn ghost inv-danger-btn" onClick={() => setConfirmDel(true)}>REMOVE ITEM</button>
        )}
      </div>
    </div>
  );
}

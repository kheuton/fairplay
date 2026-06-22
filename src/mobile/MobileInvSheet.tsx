/**
 * FAIRPLAY · MobileInvSheet
 * Bottom sheet wrapper for the inventory item detail panel on mobile.
 * Mirrors AddSheet / EditSheet chrome (.m-backdrop / .m-sheet / .m-sheet-grab).
 * InvDetail renders its own id-head with name + close button, so the sheet
 * header shows only a CLOSE button to avoid doubling the title.
 */
import React from 'react';
import type { InvMeta } from '../lib/types';
import { InvDetail } from '../cards/inventory/InvDetail';
import type { ItemWithMeta } from '../cards/inventory/types';

// ─── MobileInvSheet ───────────────────────────────────────────────────────────

interface MobileInvSheetProps {
  item: ItemWithMeta | null;
  onClose: () => void;
  onUpdateMeta: (taskId: string, patch: Partial<InvMeta>) => void;
  onAttest: (taskId: string, count: number) => void;
  onDelete: (taskId: string) => void;
}

export function MobileInvSheet({
  item,
  onClose,
  onUpdateMeta,
  onAttest,
  onDelete,
}: MobileInvSheetProps) {
  const open = item !== null;

  return (
    <>
      <div className={`m-backdrop${open ? ' show' : ''}`} onClick={onClose} />
      <div
        className={`m-sheet${open ? ' show' : ''}`}
        role="dialog"
        aria-modal
        aria-label="Inventory item"
        aria-hidden={!open}
      >
        <div className="m-sheet-grab" />
        {/* No sheet header — InvDetail's own id-head provides the item name, status
            chip, and a ✕ close control, so a sheet-level header would double the close. */}
        {item && (
          <InvDetail
            item={item}
            onClose={onClose}
            onUpdateMeta={onUpdateMeta}
            onAttest={onAttest}
            onDelete={onDelete}
          />
        )}
      </div>
    </>
  );
}

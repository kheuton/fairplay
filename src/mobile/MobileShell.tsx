/**
 * FAIRPLAY · Mobile shell.
 * The phone presentation frame: fixed top bar (hamburger + brand + bell),
 * a scroll area whose first child is the (scrolls-away) Amy/Kyle owner toggle,
 * then the routed screen, plus the off-canvas drawer, FAB, and add-task sheet.
 *
 * Routes mirror the desktop set (/, /card/:id, /settings) plus /done for the
 * dedicated Done screen. Only one shell (this or AppShell) mounts at a time —
 * see App.tsx / useIsMobile — so the two route sets never collide.
 */
import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { OwnerToggle } from './atoms';
import { Drawer } from './Drawer';
import { AddSheet } from './AddSheet';
import { EditSheet } from './EditSheet';
import { useTaskEditor } from '../shell/TaskEditorContext';
import { MobileInbox } from './MobileInbox';
import { MobileCardDetail } from './MobileCardDetail';
import { MobileDone } from './MobileDone';
import { MobileSettings } from './MobileSettings';
import { Ic } from './icons';

const CARD_PREFIX = '/card/';

export function MobileShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheet, setSheet] = useState<{ open: boolean; cardId: string | null }>({ open: false, cardId: null });
  const { task: editTask, closeEditor } = useTaskEditor();

  // Close the drawer on any navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const onCardDetail = location.pathname.startsWith(CARD_PREFIX);
  const showFab = location.pathname === '/' || onCardDetail;
  const currentCardId = onCardDetail
    ? decodeURIComponent(location.pathname.slice(CARD_PREFIX.length))
    : null;

  return (
    <div className="m-root">
      <div className="m-top">
        <div className="m-topbar">
          <button className="m-iconbtn" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
            {Ic.menu({ s: 18 })}
          </button>
          <button
            className="m-brand"
            onClick={() => navigate('/')}
            style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
            aria-label="Go to inbox"
          >
            <span className="m-mark" />
            <span className="m-brandname">FAIRPLAY</span>
          </button>
          <span className="m-top-spacer" />
          <button className="m-iconbtn" onClick={() => navigate('/done')} aria-label="Completed tasks">
            {Ic.bell({ s: 16 })}
          </button>
        </div>
      </div>

      <div className="m-scroll">
        <OwnerToggle />
        <Routes>
          <Route path="/" element={<MobileInbox />} />
          <Route path="/card/:id" element={<MobileCardDetail />} />
          <Route path="/done" element={<MobileDone />} />
          <Route path="/settings" element={<MobileSettings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {showFab && (
        <button className="m-fab" onClick={() => setSheet({ open: true, cardId: currentCardId })} aria-label="Add task">
          {Ic.plus({ s: 22, c: 'currentColor' })}
        </button>
      )}

      <AddSheet
        open={sheet.open}
        presetCardId={sheet.cardId}
        onClose={() => setSheet({ open: false, cardId: null })}
      />

      <EditSheet task={editTask} onClose={closeEditor} />
    </div>
  );
}

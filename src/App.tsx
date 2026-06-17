/**
 * FAIRPLAY · App root.
 * Wires up routes, QueryClient, and the app shell frame.
 * Routes:
 *   '/'           → InboxPage
 *   '/card/:id'   → card view via useDeck + viewForKind (Suspense)
 *   '/settings'   → SettingsPage
 */
import React, { Suspense, useEffect, Component, type ErrorInfo, type ReactNode } from 'react';
import {
  HashRouter,
  Routes,
  Route,
  useParams,
  Navigate,
  useNavigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSettings, useProfile } from './state/settings';
import { PROFILES } from './cards/deck-config';
import { TopBar } from './shell/TopBar';
import { Rail } from './shell/Rail';
import { useDeck, useConnection } from './lib/todoist/hooks';
import { LoadState } from './shell/atoms';
import { viewForKind } from './cards/registry';
import type { CardDef } from './lib/types';
import InboxPage from './pages/InboxPage';
import SettingsPage from './pages/SettingsPage';

// ─── Card error boundary ──────────────────────────────────────────────────────
// Catches crashes inside any card view (e.g. malformed FP:: inventory metadata
// that slips past normalizeInvMeta, or a bespoke view rendering error) and shows
// a degraded LoadState panel instead of a white screen.

interface EBState { hasError: boolean; message: string }

class CardErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): EBState {
    const message =
      error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[CardErrorBoundary]', error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="view">
          <div className="ph">
            <div className="lbl mono up">CARD DATA MALFORMED</div>
            <div className="sub mono" style={{ marginTop: 8, fontSize: 10, maxWidth: 340 }}>
              {this.state.message || 'An unexpected error occurred rendering this card.'}
            </div>
            <button
              className="btn ghost"
              style={{ marginTop: 12 }}
              onClick={() => this.setState({ hasError: false, message: '' })}
            >
              RETRY
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// ─── Card page: resolves card from deck then renders its view ─────────────────

function CardPage() {
  const { id } = useParams<{ id: string }>();
  const { data: deck, isLoading, isError, refetch } = useDeck();
  const profile = useProfile();

  if (isLoading) {
    return <div className="view"><LoadState status="loading" /></div>;
  }

  if (isError) {
    return (
      <div className="view">
        <LoadState
          status="error"
          message={`Check that "${PROFILES[profile].deckParent}" project exists in Todoist`}
          retry={() => void refetch()}
        />
      </div>
    );
  }

  const card: CardDef | undefined = deck?.find((c) => c.id === id);
  if (!card) return <Navigate to="/" replace />;

  const View = viewForKind(card.kind);
  return (
    <CardErrorBoundary>
      <Suspense fallback={<div className="view"><LoadState status="loading" /></div>}>
        <View card={card} />
      </Suspense>
    </CardErrorBoundary>
  );
}

// ─── No-token banner ──────────────────────────────────────────────────────────
// Uses useConnection() (reactive store subscription) so the banner dismisses
// immediately when the user saves a token in Settings — no page reload needed.

function NoTokenBanner() {
  const navigate = useNavigate();
  const { status } = useConnection();
  if (status !== 'no-token') return null;
  return (
    <div className="no-token-banner">
      <span className="msg mono">
        <b>No Todoist token configured.</b> Add one in Settings to load your deck.
      </span>
      <button className="btn coral" onClick={() => navigate('/settings')}>
        Go to Settings
      </button>
    </div>
  );
}

// ─── App shell ────────────────────────────────────────────────────────────────

function AppShell() {
  return (
    <div className="app-inner" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <TopBar />
      <div className="body">
        <Rail />
        {/* Every page renders its own .view root — wrapping Routes in another
            .view double-nests the flex column and breaks .view-body scrolling
            (flex children default to min-height:auto and grow past the viewport). */}
        <Routes>
          <Route path="/" element={<InboxPage />} />
          <Route path="/card/:id" element={<CardPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <NoTokenBanner />
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const theme = useSettings((s) => s.themeByProfile[s.profile] ?? PROFILES[s.profile].theme);
  const { density, accent, showGrid } = useSettings();

  // Apply accent override as CSS vars on .app — both --accent AND --accent-d per the
  // prototype pattern (design/prototype/FairPlay.html), since theme.css uses --accent-d
  // independently (e.g. '.due.over .d2', dark-accent roles in each skin).
  const accentStyle = accent
    ? ({ '--accent': accent, '--accent-d': accent } as React.CSSProperties)
    : {};

  // Conditionally hide background grid
  const gridStyle: React.CSSProperties = showGrid
    ? {}
    : { backgroundImage: 'none' };

  // Sync document body bg to avoid flash of wrong color
  useEffect(() => {
    document.body.style.background = '#0a0a0a';
  }, []);

  return (
    <HashRouter>
      <QueryClientProvider client={queryClient}>
        <div
          className="app"
          data-theme={theme}
          data-density={density}
          style={{ ...accentStyle, ...gridStyle }}
        >
          <AppShell />
        </div>
      </QueryClientProvider>
    </HashRouter>
  );
}

/* main-screens.jsx — 5 distinct layouts for the MAIN page
   (a triage inbox: "what needs attention now") */

const GROUPS = ["OVERDUE", "TODAY", "THIS WEEK"];
const byGroup = g => INBOX.filter(t => t.g === g);

function MainHead({ right }) {
  return (
    <div className="main-head">
      <div>
        <div className="kicker mono up"><span className="tick"></span>TRIAGE INBOX · JUN 8</div>
        <div className="h-title">What needs attention</div>
        <div className="h-sub">9 open across 6 cards · 2 overdue</div>
      </div>
      {right}
    </div>
  );
}

/* ── V1 · Classic three-column (list + right peek) ───────────── */
function MainV1() {
  return (
    <div className="wire">
      <TopBar screen="TRIAGE" note="9 OPEN · 2 OVERDUE" />
      <div className="body">
        <Rail />
        <div className="main">
          <MainHead right={
            <div className="toolrow">
              <div className="seg mono up-s"><div className="on">Triage</div><div>All</div><div>Done</div></div>
              <div className="btn coral mono up-s">+ Task</div>
            </div>
          }/>
          <div className="main-body" style={{display:"flex", gap:20, padding:"16px 22px"}}>
            <div style={{flex:1, minWidth:0}}>
              {GROUPS.map(g => (
                <div key={g} style={{marginBottom:14}}>
                  <div className={"grp mono up" + (g==="OVERDUE"?" urgent":"")}>
                    <span>{g}</span><span className="ln"></span><span className="cnt">{byGroup(g).length}</span>
                  </div>
                  <div className="tlist">{byGroup(g).map((t,i)=><TaskRow key={i} t={t}/>)}</div>
                </div>
              ))}
            </div>
            <aside style={{width:264, flex:"0 0 264px", borderLeft:"1px solid var(--line)", paddingLeft:18, display:"flex", flexDirection:"column", gap:14}}>
              <div className="mono up" style={{fontSize:10, color:"var(--ink-3)"}}>UPCOMING · JUNE</div>
              <PH label="MINI MONTH" sub="calendar peek →" style={{height:172}}/>
              <div className="mono up" style={{fontSize:10, color:"var(--ink-3)"}}>NEXT UP</div>
              <div className="panel" style={{padding:13}}>
                <div style={{fontSize:13, fontWeight:600}}>Take bins to curb</div>
                <div className="mono" style={{fontSize:10, color:"var(--ink-3)", marginTop:6}}>GARBAGE · TONIGHT 8:00 PM · ⟳ WK</div>
                <div className="btn ghost mono up-s" style={{marginTop:11, width:"100%", justifyContent:"center"}}>Mark done</div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── V2 · Grouped urgency stack (full-width, scannable) ──────── */
function MainV2() {
  return (
    <div className="wire">
      <TopBar screen="TRIAGE" note="9 OPEN · 2 OVERDUE" />
      <div className="body">
        <Rail />
        <div className="main">
          <MainHead right={
            <div className="head-meta">
              <div className="big" style={{color:"var(--coral)"}}>02</div>
              <div className="mono up">overdue</div>
            </div>
          }/>
          <div className="main-body">
            {GROUPS.map(g => (
              <div key={g} style={{marginBottom:18}}>
                <div className={"grp mono up" + (g==="OVERDUE"?" urgent":"")}>
                  <span>{g==="OVERDUE"?"◆ "+g:g}</span><span className="ln"></span>
                  <span className="cnt">{String(byGroup(g).length).padStart(2,"0")} ITEMS</span>
                </div>
                <div className="tlist">{byGroup(g).map((t,i)=><TaskRow key={i} t={t}/>)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── V3 · Triage board (status columns) ─────────────────────── */
function MiniCard({ t }) {
  return (
    <div className="panel" style={{padding:"11px 12px", marginBottom:10, borderLeft:`2px solid ${t.urgent?"var(--coral)":"var(--line)"}`}}>
      <div style={{fontSize:12.5, fontWeight:600, lineHeight:1.2}}>{t.name}</div>
      <div className="mono" style={{fontSize:9.5, color:"var(--ink-3)", marginTop:8, display:"flex", justifyContent:"space-between"}}>
        <span style={{color:"var(--ink-2)"}}>{t.card.toUpperCase()}</span>
        <span className={t.due.includes("ago")?"":""} style={{color:t.due.includes("ago")?"var(--coral)":"var(--ink-3)"}}>{t.due}{t.recur?" · ⟳":""}</span>
      </div>
    </div>
  );
}
function MainV3() {
  const cols = [
    { h:"NEEDS ATTENTION", urgent:true, items:[...byGroup("OVERDUE"), byGroup("TODAY")[0]] },
    { h:"SCHEDULED", urgent:false, items:byGroup("TODAY").slice(1) },
    { h:"THIS WEEK", urgent:false, items:byGroup("THIS WEEK") },
  ];
  return (
    <div className="wire">
      <TopBar screen="TRIAGE·BOARD" note="9 OPEN · 2 OVERDUE" />
      <div className="body">
        <Rail />
        <div className="main">
          <MainHead right={
            <div className="seg mono up-s"><div>List</div><div className="on">Board</div><div>Calendar</div></div>
          }/>
          <div className="main-body" style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:18}}>
            {cols.map(c => (
              <div key={c.h} style={{display:"flex", flexDirection:"column"}}>
                <div className={"grp mono up" + (c.urgent?" urgent":"")} style={{marginBottom:12}}>
                  <span>{c.h}</span><span className="ln"></span><span className="cnt">{c.items.length}</span>
                </div>
                {c.items.map((t,i)=><MiniCard key={i} t={t}/>)}
                <div className="ph" style={{height:38, marginTop:2}}>
                  <div className="mono sub up-s">+ drop task</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── V4 · Focus queue (one "do next" hero + compact queue) ──── */
function MainV4() {
  const hero = byGroup("OVERDUE")[0];
  const rest = INBOX.slice(1);
  return (
    <div className="wire">
      <TopBar screen="FOCUS" note="DO NEXT" />
      <div className="body">
        <RailMini active={null} />
        <div className="main">
          <div className="main-body" style={{padding:"26px 30px", display:"flex", flexDirection:"column", gap:20}}>
            <div className="kicker mono up"><span className="tick"></span>DO THIS NEXT · 1 OF 9</div>
            <div className="panel" style={{padding:0, display:"flex", borderColor:"var(--coral)"}}>
              <div style={{flex:1, padding:"22px 24px"}}>
                <div className="mono up-s" style={{fontSize:10, color:"var(--coral)"}}>◆ OVERDUE · 2 DAYS</div>
                <div style={{fontSize:26, fontWeight:700, marginTop:10, lineHeight:1.05}}>{hero.name}</div>
                <div className="mono" style={{fontSize:11, color:"var(--ink-2)", marginTop:12}}>{hero.card.toUpperCase()} · WAS JUN 6 · ⟳ {hero.recur||"ONE-OFF"}</div>
                <div className="toolrow" style={{marginTop:20}}>
                  <div className="btn coral mono up-s">Mark done</div>
                  <div className="btn ghost mono up-s">Snooze</div>
                  <div className="btn ghost mono up-s">Reassign</div>
                </div>
              </div>
              <PH label="CARD CONTEXT" sub="home schematic" style={{width:210, borderTop:0, borderRight:0, borderBottom:0}}/>
            </div>
            <div className="grp mono up"><span>QUEUE · UP NEXT</span><span className="ln"></span><span className="cnt">8</span></div>
            <div className="tlist">{rest.map((t,i)=><TaskRow key={i} t={t} dense/>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── V5 · Command HUD (stat strip + dense readout) ──────────── */
function MainV5() {
  return (
    <div className="wire">
      <TopBar screen="HUD" note="SYSTEM NOMINAL" />
      <div className="body">
        <Rail />
        <div className="main">
          <div className="main-head" style={{paddingBottom:0, border:0}}>
            <div>
              <div className="kicker mono up"><span className="tick"></span>STATUS READOUT</div>
              <div className="h-title">Inbox</div>
            </div>
            <div className="toolrow"><div className="btn coral mono up-s">+ Task</div></div>
          </div>
          <div style={{padding:"6px 22px 0"}}>
            <div className="stats">
              <div className="stat"><div className="v coral">02</div><div className="k mono up">overdue</div></div>
              <div className="stat"><div className="v">04</div><div className="k mono up">due today</div></div>
              <div className="stat"><div className="v">03</div><div className="k mono up">this week</div></div>
              <div className="stat"><div className="v">12</div><div className="k mono up">done · 7d</div></div>
              <div className="stat" style={{flex:1}}><PH label="LOAD TREND" sub="7-day sparkline" style={{height:46}}/></div>
            </div>
          </div>
          <div className="main-body" style={{paddingTop:16}}>
            <div className="grp mono up"><span>ALL OPEN · BY DUE</span><span className="ln"></span><span className="cnt">SORT ↓</span></div>
            <div className="tlist">{INBOX.map((t,i)=><TaskRow key={i} t={t} dense/>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { MainV1, MainV2, MainV3, MainV4, MainV5 });

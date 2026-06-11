/* card-screens.jsx — 5 distinct layouts for a CARD's default page
   Example card: AUTO. Each seeds the bespoke "custom view" zone. */

function CardHead({ compact }) {
  return (
    <div className="main-head" style={compact?{paddingBottom:14}:null}>
      <div style={{display:"flex", gap:16, alignItems:"center"}}>
        <div className="card-glyph mono">01</div>
        <div>
          <div className="kicker mono up" style={{marginBottom:6}}><span className="tick"></span>CARD · HOME</div>
          <div className="h-title">Auto</div>
        </div>
      </div>
      <div className="head-meta">
        <div className="big">45,180<span style={{fontSize:12, fontWeight:500}}> mi</span></div>
        <div className="mono up">8 open · next svc 45.2k</div>
      </div>
    </div>
  );
}

function CardRow({ t, dense }) {
  return (
    <div className={"trow"+(t.over?" is-urgent":"")+(dense?" dense":"")} style={{gridTemplateColumns:"22px 1fr 120px 118px"}}>
      <div className={"chk"+(t.recur?" recur":"")}></div>
      <div className="t-main"><div className="t-name">{t.name}</div></div>
      {t.recur
        ? <span className="tag mono up-s" style={{color:"var(--teal)", borderColor:"var(--teal)"}}>⟳ {t.recur}</span>
        : <span className="mono up-s" style={{fontSize:10, color:"var(--ink-4)"}}>ONE-OFF</span>}
      <div className={"due mono"+(t.over?" over":"")}>{t.due}<span className="d2">{t.d2}</span></div>
    </div>
  );
}

/* ── CARD V1 · Header band + flat list ──────────────────────── */
function CardV1() {
  return (
    <div className="wire">
      <TopBar screen="CARD·AUTO" note="8 OPEN · 1 OVERDUE" />
      <div className="body">
        <Rail active="Auto" />
        <div className="main">
          <CardHead />
          <div style={{padding:"14px 22px 0", display:"flex", gap:16}}>
            <PH label="CAR SCHEMATIC" sub="bespoke view · drop here" style={{flex:1, height:96}}/>
            <div className="stats" style={{flex:"0 0 auto"}}>
              <div className="stat"><div className="v">9k</div><div className="k mono up">to next svc</div></div>
              <div className="stat"><div className="v coral">1</div><div className="k mono up">overdue</div></div>
              <div className="stat"><div className="v">5</div><div className="k mono up">recurring</div></div>
            </div>
          </div>
          <div className="main-body" style={{paddingTop:16}}>
            <div className="grp mono up urgent"><span>OVERDUE</span><span className="ln"></span><span className="cnt">1</span></div>
            <div className="tlist"><CardRow t={AUTO[0]}/></div>
            <div className="grp mono up" style={{marginTop:14}}><span>UPCOMING</span><span className="ln"></span><span className="cnt">7</span></div>
            <div className="tlist">{AUTO.slice(1).map((t,i)=><CardRow key={i} t={t}/>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── CARD V2 · Split: bespoke schematic + task list ─────────── */
function CardV2() {
  return (
    <div className="wire">
      <TopBar screen="CARD·AUTO" note="8 OPEN · 1 OVERDUE" />
      <div className="body">
        <Rail active="Auto" />
        <div className="main">
          <CardHead compact />
          <div className="main-body" style={{display:"flex", gap:22, padding:"18px 22px"}}>
            <div style={{flex:"0 0 46%", display:"flex", flexDirection:"column", gap:12}}>
              <div className="mono up" style={{fontSize:10, color:"var(--ink-3)"}}>CUSTOM VIEW</div>
              <PH label="CAR SCHEMATIC" sub="click a part → its tasks" style={{flex:1, minHeight:300}}/>
              <div className="mono" style={{fontSize:9.5, color:"var(--ink-4)", display:"flex", justifyContent:"space-between"}}>
                <span>ENGINE · TIRES · FLUIDS · BODY</span><span>EDIT LAYOUT ⌘E</span>
              </div>
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div className="grp mono up urgent"><span>NEEDS ATTENTION</span><span className="ln"></span><span className="cnt">3</span></div>
              <div className="tlist">{AUTO.slice(0,3).map((t,i)=><CardRow key={i} t={t} dense/>)}</div>
              <div className="grp mono up" style={{marginTop:12}}><span>SCHEDULED</span><span className="ln"></span><span className="cnt">5</span></div>
              <div className="tlist">{AUTO.slice(3).map((t,i)=><CardRow key={i} t={t} dense/>)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── CARD V3 · Tabbed (Tasks active; Custom View available) ── */
function CardV3() {
  return (
    <div className="wire">
      <TopBar screen="CARD·AUTO" note="8 OPEN · 1 OVERDUE" />
      <div className="body">
        <Rail active="Auto" />
        <div className="main">
          <CardHead compact />
          <div className="tabs mono up-s" style={{padding:"0 22px"}}>
            <div className="on">Tasks · 8</div>
            <div>Schedule</div>
            <div>History</div>
            <div>Custom View ◆</div>
            <div>Notes</div>
          </div>
          <div className="main-body" style={{paddingTop:16}}>
            <div className="toolrow" style={{marginBottom:14, justifyContent:"space-between"}}>
              <div className="seg mono up-s"><div className="on">All</div><div>Due</div><div>Recurring</div><div>Done</div></div>
              <div className="btn coral mono up-s">+ Auto task</div>
            </div>
            <div className="tlist">{AUTO.map((t,i)=><CardRow key={i} t={t}/>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── CARD V4 · Timeline by due date ─────────────────────────── */
function CardV4() {
  const T = AUTO;
  return (
    <div className="wire">
      <TopBar screen="CARD·AUTO" note="8 OPEN · 1 OVERDUE" />
      <div className="body">
        <Rail active="Auto" />
        <div className="main">
          <CardHead compact />
          <div className="main-body">
            <div className="grp mono up"><span>SCHEDULE · NEXT 60 DAYS</span><span className="ln"></span><span className="cnt">TIMELINE</span></div>
            <div className="tl-rail" style={{marginTop:8}}>
              {T.map((t,i)=>(
                <div key={i} className={"tl-node"+(t.over?" urgent":"")} style={{padding:"9px 0 13px"}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:14}}>
                    <div>
                      <div className="t-name" style={{fontSize:14}}>{t.name}</div>
                      <div className="mono" style={{fontSize:9.5, color:"var(--ink-3)", marginTop:4}}>
                        {t.recur?`⟳ REPEATS ${t.recur}`:"ONE-OFF"} · {t.d2.toUpperCase()}
                      </div>
                    </div>
                    <div className={"due mono"+(t.over?" over":"")} style={{textAlign:"right"}}>{t.due}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── CARD V5 · Sectioned by status (collapsibles) ───────────── */
function Section({ label, n, urgent, open=true, children, hint }) {
  return (
    <div style={{marginBottom:14}}>
      <div className={"grp mono up"+(urgent?" urgent":"")} style={{cursor:"default"}}>
        <span>{open?"▾":"▸"} {label}</span><span className="ln"></span>
        <span className="cnt">{hint||n}</span>
      </div>
      {open && <div className="tlist">{children}</div>}
    </div>
  );
}
function CardV5() {
  return (
    <div className="wire">
      <TopBar screen="CARD·AUTO" note="8 OPEN · 1 OVERDUE" />
      <div className="body">
        <Rail active="Auto" />
        <div className="main">
          <CardHead compact />
          <div className="main-body">
            <Section label="OVERDUE" n={1} urgent><CardRow t={AUTO[0]} dense/></Section>
            <Section label="UPCOMING" n={4}>{AUTO.slice(1,5).map((t,i)=><CardRow key={i} t={t} dense/>)}</Section>
            <Section label="RECURRING" n={3} hint="3 · AUTO-RENEWS">{AUTO.slice(5).map((t,i)=><CardRow key={i} t={t} dense/>)}</Section>
            <Section label="DONE" n={11} open={false} hint="11 THIS QUARTER" />
            <div className="ph" style={{height:46, marginTop:4}}>
              <div className="mono sub up-s">CUSTOM VIEW · ADD CAR SCHEMATIC ABOVE LIST</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CardV1, CardV2, CardV3, CardV4, CardV5 });

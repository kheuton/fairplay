/* views-bespoke.jsx — Auto custom view (clickable car schematic + tasks),
   plus stub stages for not-yet-built bespoke cards (Home blueprint, Date Night). */

const POS = {
  body:   { x:286, y:150, lx:286, ly:116, anchor:"middle" },
  fluids: { x:404, y:182, lx:404, ly:116, anchor:"middle" },
  engine: { x:462, y:210, lx:506, ly:150, anchor:"middle" },
  brakes: { x:168, y:248, lx:168, ly:308, anchor:"middle" },
  tires:  { x:424, y:248, lx:424, ly:308, anchor:"middle" },
};

function Hotspot({ p, sel, onSel }) {
  const pos = POS[p.id]; const active = sel===p.id;
  return (
    <g>
      <g className={"hot" + (active?" active":"")} onClick={(e)=>{e.stopPropagation(); onSel(active?null:p.id);}}>
        <circle className="ring" cx={pos.x} cy={pos.y} r="13"/>
        <circle className="core" cx={pos.x} cy={pos.y} r="3"/>
      </g>
      <text className="hot-label" x={pos.lx} y={pos.ly} textAnchor={pos.anchor}
            style={{fill: active?"var(--accent)":"var(--ink-2)"}}>{p.label}</text>
      <line x1={pos.x} y1={pos.y + (pos.ly>pos.y?14:-14)} x2={pos.lx} y2={pos.ly + (pos.ly>pos.y?-12:8)}
            stroke={active?"var(--accent)":"var(--line)"} strokeWidth="1"/>
    </g>
  );
}

function CarSchematic({ sel, onSel }) {
  return (
    <svg className="schematic" viewBox="0 0 560 330">
      {/* blueprint grid */}
      {Array.from({length:11}).map((_,i)=>(<line key={"v"+i} className="gridln" x1={i*56} y1="0" x2={i*56} y2="330"/>))}
      {Array.from({length:7}).map((_,i)=>(<line key={"h"+i} className="gridln" x1="0" y1={i*55} x2="560" y2={i*55}/>))}

      {/* ground baseline */}
      <line className="ln2" x1="40" y1="290" x2="520" y2="290"/>

      {/* body silhouette */}
      <polygon className="fillp" points="74,244 86,200 150,196 196,196 232,150 338,150 380,200 486,206 506,232 500,244" />
      {/* greenhouse / glass */}
      <polygon className="ln2" points="240,156 330,156 366,192 206,192" fill="color-mix(in srgb, var(--accent-2) 8%, transparent)"/>
      <line className="ln2" x1="286" y1="156" x2="286" y2="192"/>

      {/* wheels */}
      {[{cx:168},{cx:424}].map((w,i)=>(
        <g key={i}>
          <circle className="ln" cx={w.cx} cy="248" r="42"/>
          <circle className="ln2" cx={w.cx} cy="248" r="17"/>
          <circle className="core" cx={w.cx} cy="248" r="2.5" style={{fill:"var(--ink-3)"}}/>
        </g>
      ))}

      {/* dimension line (wheelbase) */}
      <line className="ln2" x1="168" y1="312" x2="424" y2="312"/>
      <line className="ln2" x1="168" y1="306" x2="168" y2="318"/>
      <line className="ln2" x1="424" y1="306" x2="424" y2="318"/>
      <text className="hot-label" x="296" y="326" textAnchor="middle" style={{fill:"var(--ink-4)"}}>WHEELBASE 2,650</text>

      {AUTO_PARTS.map(p => <Hotspot key={p.id} p={p} sel={sel} onSel={onSel}/>)}
    </svg>
  );
}

function AutoSideRow({ t, done, toggle }) {
  const isDone = done.has(t.id);
  return (
    <div className={"trow" + (t.over?" urgent":"") + (isDone?" done":"")}
         style={{gridTemplateColumns:"22px 1fr auto", gap:13, padding:"12px 0"}}
         onClick={()=>toggle(t.id)}>
      <div className={"chk" + (t.recur?" recur":"") + (isDone?" done":"")}></div>
      <div className="t-main">
        <div className="t-name" style={{fontSize:13.5}}>{t.name}</div>
        <div className="t-sub mono">
          <span className={t.over?"":""} style={{color:t.over?"var(--accent)":"var(--ink-3)"}}>{t.date}</span>
          <span>{t.recur?`⟳ ${t.recur}`:"ONE-OFF"}</span>
        </div>
      </div>
      <span className="mono up-s" style={{fontSize:9, color:"var(--ink-4)", alignSelf:"center"}}>{t.part}</span>
    </div>
  );
}

function AutoView({ done, toggle }) {
  const [sel, setSel] = React.useState(null);
  const rows = sel ? AUTO.filter(t=>t.part===sel) : AUTO;
  return (
    <div className="view">
      <div className="view-head">
        <div style={{display:"flex", gap:16, alignItems:"center"}}>
          <div className="card-glyph" style={{width:42,height:42,border:"1px solid var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--accent)",fontFamily:"JetBrains Mono"}}>01</div>
          <div>
            <div className="kicker mono up" style={{marginBottom:7}}><span className="tick"></span>CARD · HOME · CUSTOM VIEW ◆</div>
            <div className="view-title">Auto</div>
          </div>
        </div>
        <div className="head-meta">
          <div className="big">45,180<span style={{fontSize:13,fontWeight:500}}> mi</span></div>
          <div className="mono up">2019 · NEXT SVC 45.2K · 8 OPEN</div>
        </div>
      </div>
      <div className="bespoke">
        <div className="stage">
          <span className="tick-c tl"></span><span className="tick-c tr"></span>
          <span className="tick-c bl"></span><span className="tick-c br"></span>
          <div className="stage-head">
            <div className="lbl">SCHEMATIC · 2019 SEDAN · SIDE</div>
            <div className="lbl">CLICK A SYSTEM TO FILTER ▸</div>
          </div>
          <div className="schematic-wrap"><CarSchematic sel={sel} onSel={setSel}/></div>
          <div className="stage-foot">
            <span>VIN ····7H219</span><span>EDIT LAYOUT ⌘E</span><span>REV 03</span>
          </div>
        </div>
        <div className="bespoke-side">
          <div className="bs-head">
            <div className="peek-label mono up"><span>{sel ? sel.toUpperCase()+" TASKS" : "ALL TASKS"}</span><span>{rows.length}</span></div>
            {sel && <div className="filter-chip" onClick={()=>setSel(null)}>FILTER · {sel} <span className="x">✕</span></div>}
          </div>
          <div className="bs-list">
            <div className="tlist">
              {rows.map(t => <AutoSideRow key={t.id} t={t} done={done} toggle={toggle}/>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- stub stages for bespoke cards not yet built ------------
function BespokeStub({ card, kind, data, done, toggle }) {
  const labels = {
    home: ["HOUSE BLUEPRINT · FLOORPLAN", "drop rooms → tasks pin to each room"],
    datenight: ["DATE-NIGHT PLANNER · CALENDAR", "drag ideas onto open evenings"],
  };
  const [lbl, sub] = labels[kind] || ["CUSTOM VIEW", "bespoke layout"];
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <div className="kicker mono up"><span className="tick"></span>CUSTOM VIEW ◆ · IN PROGRESS</div>
          <div className="view-title">{card}</div>
          <div className="view-sub">{data.length} scheduled · bespoke layout coming</div>
        </div>
        <button className="btn ghost">Design layout</button>
      </div>
      <div className="bespoke">
        <div className="stage" style={{padding:0}}>
          <div className="ph">
            <div className="lbl">{lbl}</div>
            <div className="sub">{sub}</div>
          </div>
        </div>
        <div className="bespoke-side">
          <div className="bs-head"><div className="peek-label mono up"><span>TASKS</span><span>{data.length}</span></div></div>
          <div className="bs-list">
            <div className="tlist">
              {data.map(t => <AutoSideRow key={t.id} t={{...t, part:"", over:t.urgent}} done={done} toggle={toggle}/>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AutoView, BespokeStub, CarSchematic });

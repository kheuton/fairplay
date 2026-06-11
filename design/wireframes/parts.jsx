/* parts.jsx — shared data + reusable wireframe primitives
   Exports to window for the screen files to consume. */

// ---- the 30 cards, FairPlay-style, grouped ------------------
const CARD_GROUPS = [
  { cat: "HOME", items: [
    ["01","Auto", 4, true],
    ["02","Home Maintenance", 3, true],
    ["03","Garbage", 1, true],
    ["04","Dinners", 2, false],
    ["05","Dishes", 0, false],
    ["06","Laundry", 1, false],
    ["07","Cleaning", 2, false],
    ["08","Lawn & Plants", 1, false],
    ["09","Groceries", 0, false],
    ["10","Tidying Up", 0, false],
    ["11","Home Repairs", 1, false],
  ]},
  { cat: "OUT", items: [
    ["12","Cash & Bills", 2, true],
    ["13","Mail & Packages", 0, false],
    ["14","Pharmacy", 1, false],
    ["15","Tech & Devices", 0, false],
    ["16","Travel Plans", 0, false],
    ["17","Errands", 1, false],
    ["18","Pet Care", 1, false],
  ]},
  { cat: "CAREGIVING", items: [
    ["19","Health & Doctors", 1, false],
    ["20","Calendar Keeper", 0, false],
    ["21","Friends & Family", 0, false],
    ["22","Gifts", 0, false],
    ["23","School & Forms", 0, false],
    ["24","Birthdays", 1, false],
  ]},
  { cat: "MAGIC", items: [
    ["25","Date Night", 0, false],
    ["26","Hosting", 0, false],
    ["27","Traditions", 0, false],
    ["28","Adventures", 0, false],
    ["29","Self-Care", 0, false],
    ["30","Charity", 0, false],
  ]},
];

// ---- triage inbox tasks (mixed across cards) ----------------
const C = { auto:"var(--coral)", home:"var(--teal)", gar:"#8A6D2F", din:"#5B6BB0" };
const INBOX = [
  { g:"OVERDUE", urgent:true, name:"Order furnace filters (16×25×1)", card:"Home Maintenance", sw:C.home, due:"2 days ago", d2:"was Jun 6", recur:false },
  { g:"OVERDUE", urgent:true, name:"Replace driver-side wiper blade", card:"Auto", sw:C.auto, due:"1 day ago", d2:"was Jun 7", recur:false },
  { g:"TODAY", urgent:true, name:"Take bins + recycling to curb", card:"Garbage", sw:C.gar, due:"Tonight", d2:"8:00 PM", recur:"WK" },
  { g:"TODAY", urgent:false, name:"Defrost chicken for dinner", card:"Dinners", sw:C.din, due:"5:00 PM", d2:"today", recur:false },
  { g:"TODAY", urgent:false, name:"Replace HVAC return filter", card:"Home Maintenance", sw:C.home, due:"6:00 PM", d2:"today", recur:"MO" },
  { g:"TODAY", urgent:false, name:"Plan the week's dinners", card:"Dinners", sw:C.din, due:"EOD", d2:"today", recur:"WK" },
  { g:"THIS WEEK", urgent:false, name:"Oil change @ 45,200 mi", card:"Auto", sw:C.auto, due:"Mon Jun 9", d2:"appt 10:30", recur:"5K MI" },
  { g:"THIS WEEK", urgent:false, name:"Renew vehicle registration", card:"Auto", sw:C.auto, due:"Fri Jun 12", d2:"DMV online", recur:"YR" },
  { g:"THIS WEEK", urgent:false, name:"Pay water + power bill", card:"Cash & Bills", sw:"#5B6BB0", due:"Fri Jun 12", d2:"autopay off", recur:"MO" },
];

// ---- Auto card tasks ----------------------------------------
const AUTO = [
  { name:"Replace driver-side wiper blade", due:"1 day ago", d2:"overdue", over:true,  recur:false },
  { name:"Oil change @ 45,200 mi", due:"Mon Jun 9", d2:"10:30 AM", over:false, recur:"5K MI" },
  { name:"Renew vehicle registration", due:"Fri Jun 12", d2:"DMV online", over:false, recur:"1 YR" },
  { name:"Rotate tires", due:"Sat Jun 20", d2:"w/ oil change", over:false, recur:"6 MO" },
  { name:"Smog / emissions check", due:"Jul 1", d2:"req. for reg.", over:false, recur:"2 YR" },
  { name:"Wash + vacuum interior", due:"Jun 14", d2:"weekend", over:false, recur:"2 WK" },
  { name:"Check tire pressure (all 4)", due:"Jun 15", d2:"32 psi", over:false, recur:"1 MO" },
  { name:"Top off washer fluid", due:"Jun 22", d2:"—", over:false, recur:"1 MO" },
];

// ---------------------------------------------------------------
function Cross({ s=10, c="var(--ink-3)" }) {
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" style={{display:"block"}}>
      <line x1="5" y1="0" x2="5" y2="10" stroke={c} strokeWidth="1"/>
      <line x1="0" y1="5" x2="10" y2="5" stroke={c} strokeWidth="1"/>
      <circle cx="5" cy="5" r="2.2" fill="none" stroke={c} strokeWidth="1"/>
    </svg>
  );
}

function TopBar({ screen="TRIAGE", note="9 items need attention" }) {
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark"></div>
        <div className="brand-name">FAIRPLAY</div>
      </div>
      <div className="sep"></div>
      <div className="mono up-s">J. NODE · MY DECK</div>
      <div className="spacer"></div>
      <div className="mono">SCREEN // {screen}</div>
      <div className="chip-mini mono up-s">{note}</div>
      <Cross s={11}/>
    </div>
  );
}

// Full searchable rail of 30 cards. activeName highlights one.
function Rail({ active=null }) {
  return (
    <div className="rail">
      <div className="rail-head">
        <div className="rail-title">
          <b className="up-s">My Cards</b>
          <span className="mono">30</span>
        </div>
        <div className="search">
          <Cross s={10}/>
          <span className="mono">search cards</span>
          <div style={{flex:1}}></div>
          <div className="car"></div>
        </div>
      </div>
      <div className="rail-scroll">
        {CARD_GROUPS.map(g => (
          <div key={g.cat}>
            <div className="rail-cat mono up">
              <span>{g.cat}</span><span className="ln"></span>
              <span>{g.items.length}</span>
            </div>
            {g.items.map(([num,nm,cnt,due]) => (
              <div key={num} className={"rail-item" + (nm===active?" is-active":"") + (due?" has-due":"")}>
                <span className="num mono">{num}</span>
                <span className="nm">{nm}</span>
                <span className="cnt mono">{cnt>0?cnt:"·"}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// icon-collapsed rail
function RailMini({ active="Auto" }) {
  const flat = CARD_GROUPS.flatMap(g=>g.items);
  return (
    <div className="rail rail--mini">
      <div className="rail-head"><Cross s={12}/></div>
      <div className="rail-scroll" style={{padding:"4px 0"}}>
        {flat.slice(0,13).map(([num,nm,cnt,due]) => (
          <div key={num} className={"ico mono" + (nm===active?" is-active":"")}>{nm.slice(0,2).toUpperCase()}</div>
        ))}
      </div>
    </div>
  );
}

function Tag({ label, sw }) {
  return <span className="tag mono up-s"><span className="sw" style={{background:sw}}></span>{label}</span>;
}

function Recur({ label }) {
  if (!label) return <span className="recur-i">·</span>;
  return <span className="recur-i on mono" title={"repeats "+label} style={{fontSize:9, letterSpacing:".02em"}}>⟳</span>;
}

// a standard triage task row
function TaskRow({ t, dense=false }) {
  return (
    <div className={"trow" + (t.urgent?" is-urgent":"") + (dense?" dense":"")}>
      <div className={"chk" + (t.recur?" recur":"")}></div>
      <div className="t-main">
        <div className="t-name">{t.name}</div>
        {!dense && <div className="t-meta mono"><span>ID·{String(Math.floor(Math.random()*900+100))}</span></div>}
      </div>
      <Tag label={t.card} sw={t.sw}/>
      <div className={"due mono" + (t.urgent && (t.due.includes("ago"))?" over":"")}>
        {t.due}<span className="d2">{t.d2}</span>
      </div>
      <Recur label={t.recur}/>
    </div>
  );
}

function PH({ label, sub, style }) {
  return (
    <div className="ph" style={style}>
      <span className="ph-corner tl"></span><span className="ph-corner tr"></span>
      <span className="ph-corner bl"></span><span className="ph-corner br"></span>
      <div className="mono up-s lbl">{label}</div>
      {sub && <div className="mono sub">{sub}</div>}
    </div>
  );
}

Object.assign(window, {
  CARD_GROUPS, INBOX, AUTO, C,
  Cross, TopBar, Rail, RailMini, Tag, Recur, TaskRow, PH,
});

/* mobile-parts.jsx — shared mobile UI atoms
   icons, owner toggle, swipeable TaskRow, dividers, tab bar,
   drawer, FAB, add-task bottom sheet, inline add row */

const { useState, useRef, useEffect, useCallback } = React;

/* ---------- icons (simple line glyphs) ---------------------- */
const Ic = {
  check: (p={}) => (<svg width={p.s||16} height={p.s||16} viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 4.5" stroke={p.c||"currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  plus: (p={}) => (<svg width={p.s||20} height={p.s||20} viewBox="0 0 20 20" fill="none"><path d="M10 3v14M3 10h14" stroke={p.c||"currentColor"} strokeWidth="2" strokeLinecap="round"/></svg>),
  chevR: (p={}) => (<svg width={p.s||14} height={p.s||14} viewBox="0 0 14 14" fill="none"><path d="M5 2l5 5-5 5" stroke={p.c||"currentColor"} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  chevL: (p={}) => (<svg width={p.s||12} height={p.s||12} viewBox="0 0 12 12" fill="none"><path d="M8 1L3 6l5 5" stroke={p.c||"currentColor"} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  menu: (p={}) => (<svg width={p.s||18} height={p.s||18} viewBox="0 0 18 18" fill="none"><path d="M2 4.5h14M2 9h14M2 13.5h10" stroke={p.c||"currentColor"} strokeWidth="1.5" strokeLinecap="round"/></svg>),
  search: (p={}) => (<svg width={p.s||15} height={p.s||15} viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke={p.c||"currentColor"} strokeWidth="1.4"/><path d="M11 11l3.5 3.5" stroke={p.c||"currentColor"} strokeWidth="1.4" strokeLinecap="round"/></svg>),
  inbox: (p={}) => (<svg width={p.s||20} height={p.s||20} viewBox="0 0 20 20" fill="none"><path d="M3 3h14v14H3zM3 12h4l1.5 2.2h3L13 12h4" stroke={p.c||"currentColor"} strokeWidth="1.5" strokeLinejoin="round" fill="none"/></svg>),
  cards: (p={}) => (<svg width={p.s||20} height={p.s||20} viewBox="0 0 20 20" fill="none"><rect x="2.5" y="2.5" width="6.5" height="6.5" stroke={p.c||"currentColor"} strokeWidth="1.5"/><rect x="11" y="2.5" width="6.5" height="6.5" stroke={p.c||"currentColor"} strokeWidth="1.5"/><rect x="2.5" y="11" width="6.5" height="6.5" stroke={p.c||"currentColor"} strokeWidth="1.5"/><rect x="11" y="11" width="6.5" height="6.5" stroke={p.c||"currentColor"} strokeWidth="1.5"/></svg>),
  done: (p={}) => (<svg width={p.s||20} height={p.s||20} viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.5" stroke={p.c||"currentColor"} strokeWidth="1.5"/><path d="M6.5 10.2l2.3 2.3L13.5 7.8" stroke={p.c||"currentColor"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  me: (p={}) => (<svg width={p.s||20} height={p.s||20} viewBox="0 0 20 20" fill="none"><circle cx="10" cy="6.5" r="3.2" stroke={p.c||"currentColor"} strokeWidth="1.5"/><path d="M3.8 17c.6-3.4 3-5.4 6.2-5.4S15.6 13.6 16.2 17" stroke={p.c||"currentColor"} strokeWidth="1.5" strokeLinecap="round"/></svg>),
  bell: (p={}) => (<svg width={p.s||16} height={p.s||16} viewBox="0 0 16 16" fill="none"><path d="M8 2a4 4 0 00-4 4c0 4-1.5 5-1.5 5h11S12 10 12 6a4 4 0 00-4-4zM6.5 13.5a1.5 1.5 0 003 0" stroke={p.c||"currentColor"} strokeWidth="1.3" fill="none" strokeLinejoin="round"/></svg>),
  x: (p={}) => (<svg width={p.s||14} height={p.s||14} viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke={p.c||"currentColor"} strokeWidth="1.5" strokeLinecap="round"/></svg>),
};

/* ---------- owner toggle (Amy / Kyle) ----------------------- */
function OwnerToggle({ owner, setOwner, counts }) {
  return (
    <div className="m-owner">
      {["amy","kyle"].map(id => (
        <button key={id} className={owner===id?"on":""} onClick={()=>setOwner(id)}>
          <span className="av">{PEOPLE[id].initial}</span>
          <span>{PEOPLE[id].name}</span>
          <span className="ct">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- group divider ----------------------------------- */
function GroupDivider({ label, count, urgent }) {
  return (
    <div className={"m-grp mono up" + (urgent?" urgent":"")}>
      <span>{urgent ? "◆ "+label : label}</span>
      <span className="ln"></span>
      <span className="ct">{String(count).padStart(2,"0")}</span>
    </div>
  );
}

/* ---------- swipeable task row ------------------------------ */
function TaskRow({ t, done, onToggle, showTag }) {
  const [tx, setTx] = useState(0);
  const [settle, setSettle] = useState(false);
  const ref = useRef(null);
  const st = useRef({ x:0, y:0, w:0, drag:false, decided:false, swipe:false });
  const THRESH = 96;

  const onDown = (e) => {
    const r = ref.current.getBoundingClientRect();
    st.current = { x:e.clientX, y:e.clientY, w:r.width, drag:true, decided:false, swipe:false };
    setSettle(false);
  };
  const onMove = (e) => {
    const s = st.current; if (!s.drag) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      s.decided = true; s.swipe = Math.abs(dx) > Math.abs(dy);
      if (s.swipe && ref.current.setPointerCapture) { try { ref.current.setPointerCapture(e.pointerId); } catch(_){} }
    }
    if (!s.swipe) return;
    let nx = dx;
    if (nx > 0) nx = nx * 0.25;           // rubber-band the wrong way
    setTx(Math.max(-s.w, nx));
  };
  const onUp = () => {
    const s = st.current; if (!s.drag) return; s.drag = false;
    setSettle(true);
    if (s.swipe && tx < -THRESH) {
      setTx(-s.w);
      setTimeout(() => { onToggle(); setTx(0); }, 180);
    } else {
      setTx(0);
    }
  };

  return (
    <div className="m-task-wrap">
      <div className="m-task-behind">
        {done ? "REOPEN" : "DONE"}
        <span className="ck">{Ic.check({ s:17, c:"var(--bg)" })}</span>
      </div>
      <div ref={ref}
           className={"m-task" + (t.urgent||t.bucket==="overdue"?" urgent":"") + (done?" done":"") + (settle?" settle":"") + (st.current.drag?" dragging":"")}
           style={{ transform:`translateX(${tx}px)` }}
           onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="m-tbody">
          <div className="m-tname">{t.name}</div>
          <div className="m-tmeta">
            {showTag && (
              <span className="m-tag"><span className="sw" style={{background:cardColor(t.card)}}></span>{t.card}</span>
            )}
            {t.recur && <span className="m-recur">⟳ {t.recur}</span>}
          </div>
        </div>
        {t.due && (
          <div className="m-trail">
            <span className={"m-due" + (t.bucket==="overdue"?" over":"")}>{t.due}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- bottom tab bar ---------------------------------- */
function TabBar({ tab, setTab, inboxCount }) {
  const tabs = [
    { id:"inbox", label:"Inbox", ic:Ic.inbox, badge:inboxCount },
    { id:"cards", label:"Cards", ic:Ic.cards },
    { id:"done",  label:"Done",  ic:Ic.done },
    { id:"me",    label:"Me",    ic:Ic.me },
  ];
  return (
    <div className="m-tabs">
      {tabs.map(x => (
        <button key={x.id} className={"m-tab" + (tab===x.id?" on":"")} onClick={()=>setTab(x.id)}>
          <span className="ic">
            {x.ic({ s:21, c:"currentColor" })}
            {x.badge>0 && <span className="badge">{x.badge}</span>}
          </span>
          <span>{x.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- drawer (drawer nav model) ----------------------- */
function Drawer({ open, onClose, owner, route, onRoute, onCard, counts }) {
  return (
    <>
      <div className={"m-backdrop" + (open?" show":"")} onClick={onClose}></div>
      <div className={"m-drawer" + (open?" show":"")}>
        <div className="m-drawer-h">
          <div className="m-mark"></div>
          <div className="m-brandname">FAIRPLAY</div>
          <div className="m-top-spacer"></div>
          <button className="m-iconbtn" style={{width:34,height:34,flex:"0 0 34px"}} onClick={onClose}>{Ic.x({s:14})}</button>
        </div>
        <div className="m-drawer-scroll">
          {[["inbox","Inbox",Ic.inbox],["done","Done",Ic.done],["me","Me",Ic.me]].map(([id,label,ic])=>(
            <div key={id} className={"m-drawer-link" + (route.kind===id?" on":"")} onClick={()=>onRoute(id)}>
              {ic({s:18,c:"currentColor"})}<span>{label}</span>
              {id==="inbox" && <span className="cnt">{counts[owner]}</span>}
            </div>
          ))}
          {CAT_ORDER.map(cat => (
            <div key={cat}>
              <div className="m-drawer-cat">{cat}</div>
              {CARDS.filter(c=>c.cat===cat).map(c => {
                const due = cardDue(c.name, owner);
                return (
                  <div key={c.n}
                       className={"m-drawer-link" + (due>0?" has-due":"") + (route.kind==="card"&&route.card===c.name?" on":"")}
                       onClick={()=>onCard(c.name)}>
                    <span style={{fontFamily:'"JetBrains Mono",monospace',fontSize:10,color:"var(--ink-4)",width:18}}>{c.n}</span>
                    <span>{c.name}</span>
                    <span className="cnt">{due>0?due:"·"}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ---------- inline add row ---------------------------------- */
function InlineAdd({ onAdd, placeholder="Add a task" }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef(null);
  useEffect(()=>{ if(editing && inputRef.current) inputRef.current.focus(); },[editing]);
  const submit = () => {
    if (val.trim()) { onAdd(val.trim()); setVal(""); }
    setEditing(false);
  };
  if (!editing) {
    return (
      <div className="m-addrow" onClick={()=>setEditing(true)}>
        <span className="pl">{Ic.plus({s:15,c:"var(--accent)"})}</span>
        <span>{placeholder}</span>
      </div>
    );
  }
  return (
    <div className="m-addrow editing">
      <span className="pl">{Ic.plus({s:15,c:"var(--accent)"})}</span>
      <input ref={inputRef} value={val} placeholder="Task name…"
             onChange={e=>setVal(e.target.value)}
             onKeyDown={e=>{ if(e.key==="Enter") submit(); if(e.key==="Escape"){setVal("");setEditing(false);} }}
             onBlur={submit}/>
      <button className="go" onMouseDown={e=>e.preventDefault()} onClick={submit}>Add</button>
    </div>
  );
}

/* ---------- add-task bottom sheet --------------------------- */
function AddSheet({ open, onClose, onAdd, owner, fixedCard }) {
  const [name, setName] = useState("");
  const [card, setCard] = useState(fixedCard || "Dinners");
  const [who, setWho] = useState(owner);
  const [when, setWhen] = useState("today");
  const [recur, setRecur] = useState("");
  const nameRef = useRef(null);

  useEffect(()=>{
    if (open) {
      setName(""); setCard(fixedCard || "Dinners"); setWho(owner);
      setWhen("today"); setRecur("");
      setTimeout(()=>nameRef.current && nameRef.current.focus(), 320);
    }
  },[open, fixedCard, owner]);

  const whenLabel = { overdue:"", today:"Today", week:"This week", later:"Later" };
  const submit = () => {
    if (!name.trim()) return;
    onAdd({ card, name:name.trim(), owner:who, bucket:when, due:whenLabel[when]||"Today", recur:recur||null });
    onClose();
  };

  return (
    <>
      <div className={"m-backdrop" + (open?" show":"")} onClick={onClose}></div>
      <div className={"m-sheet" + (open?" show":"")}>
        <div className="m-sheet-grab"></div>
        <div className="m-sheet-h">
          <span className="t">New task</span>
          <button className="x mono" onClick={onClose}>CLOSE</button>
        </div>

        <input ref={nameRef} className="m-input" value={name} placeholder="What needs doing?"
               onChange={e=>setName(e.target.value)}
               onKeyDown={e=>{ if(e.key==="Enter") submit(); }}/>

        {!fixedCard && (
          <>
            <div className="m-field-l">Card</div>
            <div className="m-chips">
              {["Dinners","Garbage","Auto","Cleaning","Laundry","Errands","Cash & Bills","Pet Care"].map(c=>(
                <button key={c} className={"m-chip"+(card===c?" on":"")} onClick={()=>setCard(c)}>
                  <span className="sw" style={{background:cardColor(c)}}></span>{c}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="m-field-l">Owner</div>
        <div className="m-chips">
          {["amy","kyle"].map(id=>(
            <button key={id} className={"m-chip"+(who===id?" on":"")} onClick={()=>setWho(id)}>{PEOPLE[id].name}</button>
          ))}
        </div>

        <div className="m-field-l">When</div>
        <div className="m-chips">
          {[["today","Today"],["week","This week"],["later","Later"]].map(([v,l])=>(
            <button key={v} className={"m-chip"+(when===v?" on":"")} onClick={()=>setWhen(v)}>{l}</button>
          ))}
        </div>

        <div className="m-field-l">Repeat</div>
        <div className="m-chips">
          {[["","Once"],["DAILY","Daily"],["WEEKLY","Weekly"],["MONTHLY","Monthly"]].map(([v,l])=>(
            <button key={l} className={"m-chip ok"+(recur===v?" on":"")} onClick={()=>setRecur(v)}>{l}</button>
          ))}
        </div>

        <button className="m-sheet-add" disabled={!name.trim()} onClick={submit}>
          {Ic.plus({s:16,c:"currentColor"})} Add task
        </button>
      </div>
    </>
  );
}

Object.assign(window, {
  Ic, OwnerToggle, GroupDivider, TaskRow, TabBar, Drawer, InlineAdd, AddSheet,
});

/* shell.jsx — chrome: top bar, navigable rail, shared atoms */

function Cross({ s=11, c="var(--ink-3)" }) {
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" style={{display:"block", flex:`0 0 ${s}px`}}>
      <line x1="5" y1="0" x2="5" y2="10" stroke={c} strokeWidth="1"/>
      <line x1="0" y1="5" x2="10" y2="5" stroke={c} strokeWidth="1"/>
      <circle cx="5" cy="5" r="2.2" fill="none" stroke={c} strokeWidth="1"/>
    </svg>
  );
}

function TopBar() {
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark"></div>
        <div className="brand-name">FAIRPLAY</div>
      </div>
      <div className="tb-sep"></div>
      <div className="tb-meta mono up-s">J. NODE · MY DECK</div>
      <div className="tb-spacer"></div>
      <div className="tb-stat mono"><span className="dot"></span><b>2</b>&nbsp;OVERDUE</div>
      <div className="tb-sep"></div>
      <div className="tb-clock mono">MON 09 JUN · 09:14</div>
      <Cross s={12}/>
    </div>
  );
}

function Rail({ active, onNav, query, setQuery }) {
  const q = (query||"").trim().toLowerCase();
  return (
    <div className="rail">
      <div className="rail-head">
        <div className="rail-title">
          <b className="up-s">My Cards</b><span className="mono">33</span>
        </div>
        <div className="search">
          <Cross s={11}/>
          <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="search cards" />
        </div>
      </div>
      <div className="rail-scroll">
        {CARD_GROUPS.map(g => {
          const items = g.items.filter(it => !q || it.name.toLowerCase().includes(q));
          if (!items.length) return null;
          return (
            <div key={g.cat}>
              <div className="rail-cat mono up"><span>{g.cat}</span><span className="ln"></span><span>{items.length}</span></div>
              {items.map(it => (
                <div key={it.n}
                     className={"rail-item" + (it.custom?" custom":"") + (it.due>0?" has-due":"") + (active===it.name?" active":"")}
                     onClick={()=>onNav(it)}>
                  <span className="num mono">{it.n}</span>
                  <span className="nm">{it.name}</span>
                  <span className="cnt mono">{it.due>0?it.due:"·"}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// shared task row used by inbox
function TaskRow({ t, done, onToggle, onOpen }) {
  return (
    <div className={"trow" + (t.urgent?" urgent":"") + (done?" done":"")} onClick={onOpen}>
      <div className={"chk" + (t.recur?" recur":"") + (done?" done":"")}
           onClick={(e)=>{e.stopPropagation(); onToggle();}}></div>
      <div className="t-main">
        <div className="t-name">{t.name}</div>
        <div className="t-sub mono"><span>#{t.id.toUpperCase()}</span></div>
      </div>
      <span className="tag"><span className="sw" style={{background:cardColor(t.card)}}></span>{t.card}</span>
      <div className={"due" + (t.due && t.due.includes("ago")?" over":"")}>{t.due}<span className="d2">{t.d2}</span></div>
      <div className={"recur-i" + (t.recur?" on":"")}>{t.recur ? "⟳" : "·"}</div>
    </div>
  );
}

Object.assign(window, { Cross, TopBar, Rail, TaskRow });

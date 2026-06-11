/* views-list.jsx — Inbox (3-col + peek) and default Timeline card page */

const GROUPS = ["OVERDUE", "TODAY", "THIS WEEK"];

// June 2026: Jun 1 = Monday; today = Jun 9
function MiniCalendar() {
  const pips = { 9:"a2", 12:"a2", 14:"a2", 15:"a2", 20:"a2", 22:"a2" };
  const cells = [];
  for (let i=0;i<1;i++) cells.push(<div key={"b"+i} className="cal-day muted"></div>); // Jun 1 = Mon, 1 lead blank (Sun)
  for (let d=1; d<=30; d++) {
    cells.push(
      <div key={d} className={"cal-day" + (d===9?" today":"")}>
        {String(d).padStart(2,"0")}
        {pips[d] && <span className="pip"></span>}
      </div>
    );
  }
  return (
    <div className="cal">
      <div className="cal-grid">
        {["S","M","T","W","T","F","S"].map((x,i)=><div key={i} className="cal-dow">{x}</div>)}
        {cells}
      </div>
    </div>
  );
}

function InboxView({ done, toggle, onNav }) {
  const open = INBOX.filter(t => !done.has(t.id)).length;
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <div className="kicker mono up"><span className="tick"></span>TRIAGE INBOX · TUE JUN 9</div>
          <div className="view-title">What needs attention</div>
          <div className="view-sub">{open} open across 6 cards · 2 overdue</div>
        </div>
        <div className="toolrow">
          <div className="seg"><button className="on">Triage</button><button>All</button><button>Done</button></div>
          <button className="btn coral">+ Task</button>
        </div>
      </div>
      <div className="body" style={{flex:1, minHeight:0}}>
        <div className="view-body" style={{padding:"18px 26px"}}>
          {GROUPS.map(g => {
            const rows = INBOX.filter(t => t.g===g);
            return (
              <div key={g} style={{marginBottom:18}}>
                <div className={"grp mono up" + (g==="OVERDUE"?" urgent":"")}>
                  <span>{g==="OVERDUE"?"◆ "+g:g}</span><span className="ln"></span>
                  <span>{String(rows.length).padStart(2,"0")}</span>
                </div>
                <div className="tlist">
                  {rows.map(t => (
                    <TaskRow key={t.id} t={t} done={done.has(t.id)}
                             onToggle={()=>toggle(t.id)}
                             onOpen={()=>onNav({name:t.card, custom: t.card==="Auto"?"auto":(t.card==="Home Maintenance"?"home":null)})}/>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <aside className="peek">
          <div className="peek-label mono up"><span>UPCOMING</span><span>JUNE 2026 ▸</span></div>
          <MiniCalendar/>
          <div className="peek-label mono up" style={{marginTop:4}}><span>NEXT UP</span><span style={{color:"var(--accent)"}}>2H</span></div>
          <div className="nextcard">
            <div className="nm">Take bins to curb</div>
            <div className="mt mono up-s">GARBAGE · TONIGHT 8:00 PM · ⟳ WK</div>
            <button className="btn ghost" style={{marginTop:13, width:"100%", justifyContent:"center"}}>Mark done</button>
          </div>
          <div className="peek-label mono up" style={{marginTop:4}}><span>LOAD · THIS WEEK</span></div>
          <div className="stats" style={{borderLeft:0, borderRight:0}}>
            <div className="stat" style={{flex:1, paddingLeft:0}}><div className="v">9</div><div className="k">open</div></div>
            <div className="stat" style={{flex:1}}><div className="v coral">2</div><div className="k">overdue</div></div>
            <div className="stat" style={{flex:1, borderRight:0}}><div className="v">12</div><div className="k">done 7d</div></div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---- default card page: TIMELINE ---------------------------
function TimelineView({ card, data, done, toggle }) {
  let lastMonth = null;
  const openCount = data.filter(t=>!done.has(t.id)).length;
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <div className="kicker mono up"><span className="tick"></span>CARD · HOME</div>
          <div className="view-title">{card}</div>
          <div className="view-sub">{openCount} scheduled · default layout</div>
        </div>
        <div className="toolrow">
          <div className="seg"><button className="on">Timeline</button><button>List</button><button>Done</button></div>
          <button className="btn coral">+ Task</button>
        </div>
      </div>
      <div className="view-body" style={{padding:"18px 26px 30px"}}>
        <div className="tl">
          {data.map(t => {
            const showMonth = t.month !== lastMonth; lastMonth = t.month;
            const isDone = done.has(t.id);
            return (
              <React.Fragment key={t.id}>
                {showMonth && <div className="tl-month">{t.month}</div>}
                <div className={"tl-item" + (t.urgent?" urgent":"") + (t.recur?" recur":"")} onClick={()=>toggle(t.id)}>
                  <div className={"tl-date" + (t.over?" over":"")}>{t.date}</div>
                  <div className="tl-body">
                    <div className="nm" style={isDone?{textDecoration:"line-through", color:"var(--ink-3)"}:null}>{t.name}</div>
                    <div className="mt">{t.mt}</div>
                  </div>
                  <div className={"chk" + (t.recur?" recur":"") + (isDone?" done":"")}></div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { InboxView, TimelineView, MiniCalendar });

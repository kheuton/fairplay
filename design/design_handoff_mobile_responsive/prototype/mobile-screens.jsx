/* mobile-screens.jsx — FairPlay mobile screens
   Inbox · Card list · Card detail · Done · Settings
   Every card is just a time-grouped task list. No bespoke views. */

const { useState: useS } = React;

/* group an array of tasks into ordered buckets */
function groupBuckets(list, buckets) {
  return buckets
    .map(b => ({ bucket:b, items:list.filter(t => t.bucket===b) }))
    .filter(g => g.items.length);
}

/* shared list of time-grouped tasks + a done group */
function TaskGroups({ tasks, buckets, done, toggle, showTag }) {
  const open = tasks.filter(t => !done.has(t.id));
  const closed = tasks.filter(t => done.has(t.id));
  const groups = groupBuckets(open, buckets);
  return (
    <>
      {groups.map(g => (
        <div key={g.bucket}>
          <GroupDivider label={BUCKET_LABEL[g.bucket]} count={g.items.length} urgent={g.bucket==="overdue"}/>
          {g.items.map(t => (
            <TaskRow key={t.id} t={t} done={false} onToggle={()=>toggle(t.id)} showTag={showTag}/>
          ))}
        </div>
      ))}
      {closed.length>0 && (
        <div>
          <GroupDivider label="DONE" count={closed.length}/>
          {closed.map(t => (
            <TaskRow key={t.id} t={t} done={true} onToggle={()=>toggle(t.id)} showTag={showTag}/>
          ))}
        </div>
      )}
      {open.length===0 && closed.length===0 && (
        <div className="m-empty"><div className="big">ALL CLEAR</div>Nothing on this list.</div>
      )}
    </>
  );
}

/* ---------- INBOX ------------------------------------------- */
function InboxScreen({ topBar, tasks, owner, done, toggle, addModel, onAdd, openSheet }) {
  const list = tasks.filter(t => INBOX_BUCKETS.includes(t.bucket) && t.owner===owner);
  const openCount = list.filter(t=>!done.has(t.id)).length;
  const overdue = list.filter(t=>t.bucket==="overdue" && !done.has(t.id)).length;
  return (
    <div className="m-scroll">
      {topBar}
      <div className="m-head">
        <div className="m-kicker mono up"><span className="tick"></span>TRIAGE · TUE JUN 9</div>
        <div className="m-h1">Needs attention</div>
        <div className="m-h1-sub">{openCount} open for {PEOPLE[owner].name} · <b>{overdue} overdue</b></div>
      </div>
      <div className="m-pad m-pad-b" style={{paddingTop:0}}>
        {addModel==="inline" && <InlineAdd onAdd={()=>openSheet(null)} placeholder="Add a task"/>}
        <TaskGroups tasks={list} buckets={INBOX_BUCKETS} done={done} toggle={toggle} showTag={true}/>
      </div>
    </div>
  );
}

/* ---------- CARD LIST --------------------------------------- */
function CardListScreen({ topBar, owner, onCard, grid }) {
  const [q, setQ] = useS("");
  const query = q.trim().toLowerCase();
  return (
    <div className="m-scroll">
      {topBar}
      <div className="m-head">
        <div className="m-kicker mono up"><span className="tick"></span>{CARDS.length} CARDS</div>
        <div className="m-h1">My Cards</div>
      </div>
      <div className="m-pad m-pad-b" style={{paddingTop:4}}>
        <div className="m-search">
          {Ic.search({s:15,c:"var(--ink-3)"})}
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="search cards"/>
        </div>
        {CAT_ORDER.map(cat => {
          const items = CARDS.filter(c=>c.cat===cat && (!query || c.name.toLowerCase().includes(query)));
          if (!items.length) return null;
          return (
            <div key={cat}>
              <div className="m-cat mono up"><span>{cat}</span><span className="ln"></span><span>{items.length}</span></div>
              {grid ? (
                <div className="m-grid">
                  {items.map(c => {
                    const due = cardDue(c.name, owner);
                    return (
                      <div key={c.n} className={"m-tile"+(due>0?" has-due":"")} onClick={()=>onCard(c.name)}>
                        <div className="num">{c.n}</div>
                        <div className="nm">{c.name}</div>
                        <div className="foot">
                          <span className="due-n">{due>0?due:"·"}</span>
                          <span className="due-l">{due>0?"due":"clear"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : items.map(c => {
                const due = cardDue(c.name, owner);
                return (
                  <div key={c.n} className={"m-cardrow"+(due>0?" has-due":"")} onClick={()=>onCard(c.name)}>
                    <span className="num">{c.n}</span>
                    <span className="nm">{c.name}</span>
                    <span className="cnt">{due>0?due:"·"}</span>
                    <span className="chev">{Ic.chevR({s:13,c:"currentColor"})}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- CARD DETAIL ------------------------------------- */
function CardDetailScreen({ topBar, card, tasks, owner, done, toggle, onBack, addModel, onAdd, openSheet }) {
  const list = tasks.filter(t => t.card===card && t.owner===owner);
  const meta = CARDS.find(c=>c.name===card) || { cat:"" };
  const openCount = list.filter(t=>!done.has(t.id)).length;
  return (
    <div className="m-scroll">
      {topBar}
      <div className="m-head">
        <button className="m-back" onClick={onBack}>{Ic.chevL({s:11,c:"currentColor"})} CARDS</button>
        <div className="m-kicker mono up"><span className="tick"></span>CARD · {meta.cat}</div>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
          <div className="m-h1">{card}</div>
          {addModel==="header" && (
            <button className="m-iconbtn alert" style={{borderColor:"var(--accent)",color:"var(--accent)"}} onClick={()=>openSheet(card)}>{Ic.plus({s:18,c:"currentColor"})}</button>
          )}
        </div>
        <div className="m-h1-sub">{openCount} open for {PEOPLE[owner].name}</div>
      </div>
      <div className="m-pad m-pad-b" style={{paddingTop:0}}>
        {addModel==="inline" && (
          <InlineAdd placeholder={`Add to ${card}`}
            onAdd={(name)=>onAdd({ card, name, owner, bucket:"today", due:"Today", recur:null })}/>
        )}
        <TaskGroups tasks={list} buckets={BUCKET_ORDER} done={done} toggle={toggle} showTag={false}/>
      </div>
    </div>
  );
}

/* ---------- DONE ------------------------------------------- */
function DoneScreen({ topBar, tasks, owner, done }) {
  // session-completed tasks for this owner
  const session = tasks.filter(t => done.has(t.id) && t.owner===owner)
    .map(t => ({ id:t.id, card:t.card, name:t.name, owner:t.owner, when:"JUST NOW", at:"now" }));
  const hist = DONE_HISTORY.filter(h => h.owner===owner);
  const all = session.concat(hist);
  const whens = ["JUST NOW","TODAY","THIS WEEK"];
  const groups = whens.map(w => ({ when:w, items:all.filter(x=>x.when===w) })).filter(g=>g.items.length);
  return (
    <div className="m-scroll">
      {topBar}
      <div className="m-head">
        <div className="m-kicker mono up"><span className="tick"></span>COMPLETED</div>
        <div className="m-h1">Done</div>
        <div className="m-h1-sub">{all.length} closed by {PEOPLE[owner].name} recently</div>
      </div>
      <div className="m-pad m-pad-b" style={{paddingTop:0}}>
        {groups.map(g => (
          <div key={g.when}>
            <GroupDivider label={g.when} count={g.items.length}/>
            {g.items.map(x => (
              <div key={x.id} className="m-task-wrap">
                <div className="m-task done" style={{transform:"none"}}>
                  <div className="m-tbody">
                    <div className="m-tname">{x.name}</div>
                    <div className="m-tmeta">
                      <span className="m-tag"><span className="sw" style={{background:cardColor(x.card)}}></span>{x.card}</span>
                    </div>
                  </div>
                  <div className="m-trail"><span className="m-due">{x.at}</span></div>
                </div>
              </div>
            ))}
          </div>
        ))}
        {all.length===0 && <div className="m-empty"><div className="big">NOTHING YET</div>Completed tasks land here.</div>}
      </div>
    </div>
  );
}

/* ---------- SETTINGS (Me) ----------------------------------- */
function SettingsScreen({ topBar, owner, setOwner, t, setTweak }) {
  return (
    <div className="m-scroll">
      {topBar}
      <div className="m-head">
        <div className="m-kicker mono up"><span className="tick"></span>ACCOUNT</div>
        <div className="m-h1">Me</div>
      </div>
      <div className="m-pad m-pad-b" style={{paddingTop:6}}>
        <div className="m-profile">
          <div className="big-av">{PEOPLE[owner].initial}</div>
          <div>
            <div className="nm">{PEOPLE[owner].name}</div>
            <div className="sub">SHARED DECK · 2 MEMBERS</div>
          </div>
        </div>

        <div className="m-cat mono up"><span>VIEWING AS</span><span className="ln"></span></div>
        <div className="m-set-row">
          <div className="l">Active member</div>
          <div className="m-seg">
            {["amy","kyle"].map(id=>(
              <button key={id} className={owner===id?"on":""} onClick={()=>setOwner(id)}>{PEOPLE[id].name}</button>
            ))}
          </div>
        </div>

        <div className="m-cat mono up"><span>APPEARANCE</span><span className="ln"></span></div>
        <div className="m-set-row">
          <div className="l">Theme</div>
          <div className="m-seg">
            {["Bone","Eclipse","Vapor"].map(s=>(
              <button key={s} className={(t.theme||"Vapor")===s?"on":""} onClick={()=>setTweak("theme",s)}>{s.slice(0,4)}</button>
            ))}
          </div>
        </div>
        <div className="m-set-row">
          <div className="l">Density</div>
          <div className="m-seg">
            {["compact","comfy"].map(s=>(
              <button key={s} className={t.density===s?"on":""} onClick={()=>setTweak("density",s)}>{s}</button>
            ))}
          </div>
        </div>
        <div className="m-set-row">
          <div className="l">Background grid</div>
          <div className={"m-toggle-sw"+(t.showGrid?" on":"")} onClick={()=>setTweak("showGrid",!t.showGrid)}><i></i></div>
        </div>

        <div className="m-cat mono up"><span>NOTIFICATIONS</span><span className="ln"></span></div>
        <div className="m-set-row">
          <div className="l">Overdue reminders<div className="sub">Push when a task slips past due</div></div>
          <div className="m-toggle-sw on"><i></i></div>
        </div>
        <div className="m-set-row">
          <div className="l">Daily digest<div className="sub">Morning summary at 7:00 AM</div></div>
          <div className="m-toggle-sw on"><i></i></div>
        </div>
        <div className="m-set-row">
          <div className="l">Partner hand-offs<div className="sub">When {PEOPLE[owner==="amy"?"kyle":"amy"].name} reassigns to you</div></div>
          <div className="m-toggle-sw"><i></i></div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  InboxScreen, CardListScreen, CardDetailScreen, DoneScreen, SettingsScreen,
});

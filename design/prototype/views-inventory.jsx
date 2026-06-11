/* views-inventory.jsx — RE4-style supply grid: the shared custom card
   format for inventory-heavy cards (Diapering, Bathtime, Garbage,
   Pharmacy, Home Goods). Items occupy w×h cells, drag to rearrange,
   hover for name, click to inspect/configure. */

const INV_CELL = 64;

/* ---- persisted state (config edits + positions) ------------ */

function useInvItems(cardKey, cfg){
  const key = "fairplay-inv-items-" + cardKey;
  const [ov, setOv] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch(e){ return {}; }
  });
  const items = cfg.items.map(it => ({ ...it, ...(ov[it.id] || {}) }));
  const update = (id, patch) => {
    const next = { ...ov, [id]: { ...(ov[id] || {}), ...patch } };
    setOv(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch(e){}
  };
  return [items, update];
}

function useInvPos(cardKey, cfg){
  const key = "fairplay-inv-pos-" + cardKey;
  const [pos, setPosState] = React.useState(() => {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch(e){}
    const out = {};
    cfg.items.forEach(it => { out[it.id] = saved[it.id] || { x: it.x, y: it.y }; });
    return out;
  });
  const setPos = (p) => {
    setPosState(p);
    try { localStorage.setItem(key, JSON.stringify(p)); } catch(e){}
  };
  return [pos, setPos];
}

/* ---- grid cells --------------------------------------------- */

function InvCount({ it, est, display, showVer }) {
  const e = invFmt(est);
  if (display === "toggle") {
    return (
      <div className="ii-count mono">{showVer ? "✓" + it.count : e}<span className="ii-stack">/{it.stack}</span></div>
    );
  }
  if (display === "inline") {
    return (
      <div className="ii-count mono">{e}<span className="ii-verin"> ⁄ ✓{it.count}</span></div>
    );
  }
  return (
    <>
      <div className="ii-ver mono">✓{it.count}</div>
      <div className="ii-count mono">{e}<span className="ii-stack">/{it.stack}</span></div>
    </>
  );
}

function InvItemBox({ it, p, display, showVer, sel, drag, onDown, onMove, onUp }) {
  const est = invEst(it), st = invStatus(it);
  const isDrag = drag && drag.id === it.id && drag.moved;
  const left = isDrag ? drag.curX : p.x * INV_CELL;
  const top  = isDrag ? drag.curY : p.y * INV_CELL;
  const iconSize = (it.w >= 2 && it.h >= 2) ? 46 : (it.w + it.h >= 3 ? 32 : 27);
  return (
    <div className={"inv-item " + st + (sel ? " sel" : "") + (isDrag ? " dragging" : "")}
         style={{ left: left + 4, top: top + 4, width: it.w * INV_CELL - 7, height: it.h * INV_CELL - 7 }}
         onPointerDown={(e)=>onDown(e, it)} onPointerMove={(e)=>onMove(e, it)} onPointerUp={(e)=>onUp(e, it)}
         onClick={(e)=>e.stopPropagation()}>
      <div className="ii-icon"><ItemIcon name={it.icon} size={iconSize}/></div>
      <InvCount it={it} est={est} display={display} showVer={showVer}/>
      <div className="ii-tip mono up-s">{it.name} · EST {invFmt(est)} · {st === "out" ? "OUT NOW" : "OUT " + invRunout(it)}</div>
    </div>
  );
}

function InvGrid({ cfg, items, pos, setPos, sel, setSel, display, showVer }) {
  const ref = React.useRef(null);
  const [drag, setDrag] = React.useState(null);
  const W = cfg.cols * INV_CELL, H = cfg.rows * INV_CELL;

  const fits = (it, x, y) => {
    if (x < 0 || y < 0 || x + it.w > cfg.cols || y + it.h > cfg.rows) return false;
    return !items.some(o => {
      if (o.id === it.id) return false;
      const q = pos[o.id];
      return x < q.x + o.w && q.x < x + it.w && y < q.y + o.h && q.y < y + it.h;
    });
  };

  const onDown = (e, it) => {
    if (e.button !== 0) return;
    const r = ref.current.getBoundingClientRect();
    const p = pos[it.id];
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: it.id, gx: r.left, gy: r.top,
      offX: e.clientX - (r.left + p.x * INV_CELL), offY: e.clientY - (r.top + p.y * INV_CELL),
      curX: p.x * INV_CELL, curY: p.y * INV_CELL, tx: p.x, ty: p.y, ok: true,
      moved: false, sx: e.clientX, sy: e.clientY });
  };
  const onMove = (e, it) => {
    setDrag(d => {
      if (!d || d.id !== it.id) return d;
      const moved = d.moved || Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 5;
      if (!moved) return d;
      const curX = e.clientX - d.offX - d.gx, curY = e.clientY - d.offY - d.gy;
      const tx = Math.max(0, Math.min(cfg.cols - it.w, Math.round(curX / INV_CELL)));
      const ty = Math.max(0, Math.min(cfg.rows - it.h, Math.round(curY / INV_CELL)));
      return { ...d, moved, curX, curY, tx, ty, ok: fits(it, tx, ty) };
    });
  };
  const onUp = (e, it) => {
    if (!drag || drag.id !== it.id) return;
    if (!drag.moved) setSel(sel === it.id ? null : it.id);
    else if (drag.ok) setPos({ ...pos, [it.id]: { x: drag.tx, y: drag.ty } });
    setDrag(null);
  };

  const dragItem = drag && drag.moved ? items.find(i => i.id === drag.id) : null;

  return (
    <div className={"inv-grid" + (dragItem ? " dragging" : "")} ref={ref}
         style={{ width: W + 1, height: H + 1 }} onClick={()=>setSel(null)}>
      {dragItem && (
        <div className={"inv-target" + (drag.ok ? "" : " bad")}
             style={{ left: drag.tx * INV_CELL, top: drag.ty * INV_CELL,
                      width: dragItem.w * INV_CELL + 1, height: dragItem.h * INV_CELL + 1 }}></div>
      )}
      {items.map(it => (
        <InvItemBox key={it.id} it={it} p={pos[it.id]} display={display} showVer={showVer}
                    sel={sel === it.id} drag={drag} onDown={onDown} onMove={onMove} onUp={onUp}/>
      ))}
    </div>
  );
}

/* ---- detail / config panel ---------------------------------- */

function Stp({ label, dec, inc }) {
  return (
    <div className="stp">
      <button onClick={dec}>−</button>
      <span className="mono">{label}</span>
      <button onClick={inc}>+</button>
    </div>
  );
}

function InvDetail({ it, update, onClose }) {
  const est = invEst(it), st = invStatus(it);
  const [logN, setLogN] = React.useState(it.count);
  React.useEffect(() => { setLogN(it.count); }, [it.id]);
  const w = it.warn || { mode: "days", value: 7 };
  const rstep = it.rate.n <= 1 ? 0.1 : it.rate.n <= 5 ? 0.5 : 1;
  const setRate = (n) => update(it.id, { rate: { ...it.rate, n: Math.max(0.1, Math.round(n * 10) / 10) } });

  return (
    <div className="inv-detail">
      <div className="id-head">
        <div className="id-glyph"><ItemIcon name={it.icon} size={32}/></div>
        <div style={{minWidth:0}}>
          <div className="id-name">{it.name}</div>
          <div style={{marginTop:6}}>
            <span className={"chip " + st}>
              {st === "ok" ? "STOCKED" : st === "low" ? "RESTOCK · " + invChip(it) : "OUT OF STOCK"}
            </span>
          </div>
        </div>
        <div className="id-x" onClick={onClose}>✕</div>
      </div>

      <div className="stats small">
        <div className="stat"><div className="v">{it.count}</div><div className="k">VERIFIED {invDateLabel(it.verified)}</div></div>
        <div className="stat"><div className={"v" + (st !== "ok" ? " coral" : "")}>{invFmt(est)}</div><div className="k">EST TODAY</div></div>
        <div className="stat"><div className={"v sm" + (st !== "ok" ? " coral" : "")}>{invRunout(it)}</div><div className="k">RUNS OUT</div></div>
      </div>

      <div>
        <div className="peek-label mono up"><span>LOG VERIFIED COUNT</span></div>
        <div style={{display:"flex", gap:10, marginTop:10}}>
          <Stp label={logN} dec={()=>setLogN(Math.max(0, logN - 1))} inc={()=>setLogN(Math.min(999, logN + 1))}/>
          <button className="btn coral" style={{flex:1, justifyContent:"center"}}
                  onClick={()=>update(it.id, { count: logN, verified: "2026-06-09" })}>Log as of today</button>
        </div>
      </div>

      <div>
        <div className="peek-label mono up"><span>CONSUMPTION + ALERTS</span></div>
        <div className="cfg-row"><span className="lbl">BURN RATE</span>
          <div style={{display:"flex", gap:8}}>
            <Stp label={it.rate.n} dec={()=>setRate(it.rate.n - rstep)} inc={()=>setRate(it.rate.n + rstep)}/>
            <div className="seg mini">
              {["day","week","month"].map(p => (
                <button key={p} className={it.rate.per === p ? "on" : ""}
                        onClick={()=>update(it.id, { rate: { ...it.rate, per: p } })}>
                  {({day:"/DAY", week:"/WK", month:"/MO"})[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="cfg-row"><span className="lbl">STACK SIZE</span>
          <Stp label={it.stack}
               dec={()=>update(it.id, { stack: Math.max(1, it.stack - (it.stack > 20 ? 5 : 1)) })}
               inc={()=>update(it.id, { stack: it.stack + (it.stack >= 20 ? 5 : 1) })}/>
        </div>
        <div className="cfg-row"><span className="lbl">WARN WHEN</span>
          <div style={{display:"flex", gap:8}}>
            <div className="seg mini">
              <button className={w.mode === "days" ? "on" : ""} onClick={()=>update(it.id, { warn: { mode:"days", value:7 } })}>≤ DAYS</button>
              <button className={w.mode === "count" ? "on" : ""} onClick={()=>update(it.id, { warn: { mode:"count", value:1 } })}>≤ COUNT</button>
            </div>
            <Stp label={w.value}
                 dec={()=>update(it.id, { warn: { ...w, value: Math.max(w.mode === "count" ? 0.5 : 1, w.value - (w.mode === "count" ? 0.5 : 1)) } })}
                 inc={()=>update(it.id, { warn: { ...w, value: w.value + (w.mode === "count" ? 0.5 : 1) } })}/>
          </div>
        </div>
      </div>

      <div>
        <div className="peek-label mono up"><span>ICON</span><span>{ICON_ORDER.length}</span></div>
        <div className="icon-pick" style={{marginTop:10}}>
          {ICON_ORDER.map(k => (
            <div key={k} className={"ip" + (it.icon === k ? " on" : "")} title={ICON_LIB[k].label}
                 onClick={()=>update(it.id, { icon: k })}>
              <ItemIcon name={k} size={20}/>
            </div>
          ))}
        </div>
      </div>

      <div className="mono" style={{fontSize:9, color:"var(--ink-4)", letterSpacing:".08em", lineHeight:1.7}}>
        BURNS {invRateLabel(it)} · VERIFIED {it.count} ON {invDateLabel(it.verified)} · EST {invFmt(est)} TODAY · RUNS OUT {invRunout(it)}
      </div>
    </div>
  );
}

/* ---- side panel: restock alerts + tasks ---------------------- */

function InvTaskRow({ t, done, toggle }) {
  const isDone = done.has(t.id);
  return (
    <div className={"trow" + (t.over ? " urgent" : "") + (isDone ? " done" : "")}
         style={{ gridTemplateColumns: "22px 1fr", gap: 13, padding: "11px 0" }}
         onClick={()=>toggle(t.id)}>
      <div className={"chk" + (t.recur ? " recur" : "") + (isDone ? " done" : "")}></div>
      <div className="t-main">
        <div className="t-name" style={{fontSize:13.5}}>{t.name}</div>
        <div className="t-sub mono">
          <span style={{color: t.over ? "var(--accent)" : "var(--ink-3)"}}>{t.date}</span>
          <span>{t.recur ? "⟳ " + t.recur : "ONE-OFF"}</span>
        </div>
      </div>
    </div>
  );
}

function InvSidePanel({ items, tasks, done, toggle, onPick }) {
  const order = { out: 0, low: 1 };
  const alerts = items
    .filter(i => invStatus(i) !== "ok")
    .sort((a,b) => (order[invStatus(a)] - order[invStatus(b)]) || (invDaysLeft(a) - invDaysLeft(b)));
  return (
    <div className="bs-list" style={{paddingTop:16}}>
      <div className="peek-label mono up"><span>RESTOCK ALERTS</span><span>{alerts.length}</span></div>
      {alerts.length === 0 && <div className="rs-empty">ALL SUPPLIES STOCKED ✓</div>}
      {alerts.map(it => {
        const st = invStatus(it);
        return (
          <div key={it.id} className={"rs-row " + st} onClick={()=>onPick(it.id)}>
            <div className="rg"><ItemIcon name={it.icon} size={19}/></div>
            <div style={{minWidth:0}}>
              <div className="nm">{it.name}</div>
              <div className="sub">EST {invFmt(invEst(it))} · ✓{it.count} ON {invDateLabel(it.verified)} · {invRateLabel(it)}</div>
            </div>
            <span className={"chip " + st}>{invChip(it)}</span>
          </div>
        );
      })}
      <div className="peek-label mono up" style={{marginTop:24}}><span>TASKS</span><span>{tasks.length}</span></div>
      <div className="tlist">
        {tasks.map(t => <InvTaskRow key={t.id} t={t} done={done} toggle={toggle}/>)}
      </div>
    </div>
  );
}

/* ---- the view ------------------------------------------------ */

function InventoryView({ cardKey, display, done, toggle }) {
  const cfg = INVENTORIES[cardKey];
  const [items, update] = useInvItems(cardKey, cfg);
  const [pos, setPos] = useInvPos(cardKey, cfg);
  const [sel, setSel] = React.useState(null);
  const [showVer, setShowVer] = React.useState(false);
  const alerts = items.filter(i => invStatus(i) !== "ok").length;
  const selItem = items.find(i => i.id === sel);

  const legend =
    display === "inline" ? "EST ⁄ ✓ VERIFIED" :
    display === "toggle" ? (showVer ? "SHOWING ✓ VERIFIED COUNTS" : "SHOWING EST TODAY") :
    "✓ = LAST VERIFIED · BIG = EST TODAY";

  return (
    <div className="view" data-screen-label={cardKey + " (inventory)"}>
      <div className="view-head">
        <div>
          <div className="kicker mono up"><span className="tick"></span>CARD · {cfg.cat} · SUPPLY GRID ◆</div>
          <div className="view-title">{cardKey}</div>
          <div className="view-sub">{items.length} supplies tracked · estimates as of Jun 9</div>
        </div>
        <div className="head-meta">
          <div className={"big" + (alerts ? " coral" : "")}>{alerts}</div>
          <div className="mono up">RESTOCK ALERTS · {cfg.cols}×{cfg.rows} GRID</div>
        </div>
      </div>
      <div className="bespoke">
        <div className="stage">
          <span className="tick-c tl"></span><span className="tick-c tr"></span>
          <span className="tick-c bl"></span><span className="tick-c br"></span>
          <div className="stage-head">
            <div className="lbl">SUPPLY GRID · {cfg.cols}×{cfg.rows} · {cardKey.toUpperCase()}</div>
            {display === "toggle" ? (
              <div className="seg">
                <button className={!showVer ? "on" : ""} onClick={()=>setShowVer(false)}>EST TODAY</button>
                <button className={showVer ? "on" : ""} onClick={()=>setShowVer(true)}>✓ VERIFIED</button>
              </div>
            ) : (
              <div className="lbl">DRAG TO REARRANGE · CLICK TO INSPECT ▸</div>
            )}
          </div>
          <div className="inv-wrap">
            <InvGrid cfg={cfg} items={items} pos={pos} setPos={setPos}
                     sel={sel} setSel={setSel} display={display} showVer={showVer}/>
            <div className="inv-legend">
              <span><span className="sw"></span>STOCKED</span>
              <span><span className="sw low"></span>RESTOCK SOON</span>
              <span><span className="sw out"></span>OUT</span>
              <span style={{opacity:.75}}>{legend}</span>
            </div>
          </div>
          <div className="stage-foot">
            <span>FORMAT · INVENTORY v1</span><span>HOVER FOR NAME</span><span>EST CLOCK JUN 9</span>
          </div>
        </div>
        <div className="bespoke-side">
          {selItem ? (
            <InvDetail it={selItem} update={update} onClose={()=>setSel(null)}/>
          ) : (
            <>
              <div className="bs-head">
                <div className="peek-label mono up"><span>SUPPLY STATUS</span><span>{items.length} ITEMS</span></div>
              </div>
              <InvSidePanel items={items} tasks={cfg.tasks} done={done} toggle={toggle} onPick={setSel}/>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { InventoryView });

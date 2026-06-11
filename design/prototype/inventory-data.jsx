/* inventory-data.jsx — shared "supply grid" card format:
   app clock, projection math, and per-card inventory configs.

   item: { id, name, icon, w, h, x, y   — grid footprint + default slot
           stack                        — max per slot (denominator)
           count, verified              — last attested count + date
           rate: { n, per }             — burn rate (per day|week|month)
           warn: { mode, value } }      — "days" left or absolute "count"
*/

const INV_NOW = new Date(2026, 5, 9, 12);          // app clock — Mon Jun 9 2026
const INV_PER = { day: 1, week: 7, month: 30 };
const INV_MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

const invD = (s) => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d, 12); };

function invPerDay(it){ return it.rate.n / INV_PER[it.rate.per]; }
function invDaysSince(it){ return Math.max(0, Math.round((INV_NOW - invD(it.verified)) / 864e5)); }
function invEst(it){ return Math.max(0, it.count - invPerDay(it) * invDaysSince(it)); }
function invDaysLeft(it){ const pd = invPerDay(it); return pd <= 0 ? Infinity : invEst(it) / pd; }

function invStatus(it){
  const est = invEst(it);
  if (est <= 0.01) return "out";
  const w = it.warn || { mode: "days", value: 7 };
  if (w.mode === "count" ? est <= w.value : invDaysLeft(it) <= w.value) return "low";
  return "ok";
}

function invFmt(n){
  if (n >= 10) return String(Math.round(n));
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
function invDateLabel(s){ const d = invD(s); return INV_MONTHS[d.getMonth()] + " " + d.getDate(); }
function invRunout(it){
  const dl = invDaysLeft(it);
  if (!isFinite(dl)) return "—";
  if (invEst(it) <= 0.01) return "NOW";
  if (dl > 90) return ">90 DAYS";
  const d = new Date(INV_NOW.getTime() + dl * 864e5);
  return INV_MONTHS[d.getMonth()] + " " + d.getDate();
}
function invRateLabel(it){ return it.rate.n + "/" + ({ day: "DAY", week: "WK", month: "MO" })[it.rate.per]; }
function invChip(it){
  const st = invStatus(it);
  if (st === "out") return "OUT";
  if (st === "low"){ const dl = invDaysLeft(it); return dl <= 14 ? Math.max(1, Math.ceil(dl)) + "D LEFT" : "LOW"; }
  return "OK";
}

/* ---- per-card configs -------------------------------------- */

const INVENTORIES = {

  "Diapering": { cat: "CAREGIVING", cols: 7, rows: 4, items: [
    { id:"dia", name:"Diapers · Size 4",  icon:"diaper",  w:2,h:2, x:0,y:0, stack:64, count:38, verified:"2026-06-04", rate:{n:6,  per:"day"},   warn:{mode:"days",  value:7} },
    { id:"wip", name:"Water Wipes",       icon:"wipes",   w:2,h:1, x:2,y:0, stack:12, count:7,  verified:"2026-06-01", rate:{n:2,  per:"week"},  warn:{mode:"days",  value:7} },
    { id:"crm", name:"Diaper Cream",      icon:"cream",   w:1,h:1, x:4,y:0, stack:2,  count:1,  verified:"2026-05-20", rate:{n:1,  per:"month"}, warn:{mode:"count", value:1} },
    { id:"fml", name:"Formula · Stage 1", icon:"formula", w:2,h:2, x:5,y:0, stack:4,  count:3,  verified:"2026-06-06", rate:{n:1.5,per:"week"},  warn:{mode:"days",  value:7} },
    { id:"swm", name:"Swim Diapers",      icon:"diaper",  w:1,h:1, x:2,y:1, stack:20, count:17, verified:"2026-06-01", rate:{n:2,  per:"week"},  warn:{mode:"days",  value:7} },
  ], tasks: [
    { id:"dp1", name:"Order size-4 diapers (Costco)", date:"Jun 10", over:true,  recur:null },
    { id:"dp2", name:"Restock wipes — car + diaper bag", date:"Jun 12", recur:"WK" },
    { id:"dp3", name:"Move outgrown size-3s to donate bin", date:"Jun 14", recur:null },
  ]},

  "Bathtime": { cat: "CAREGIVING", cols: 6, rows: 3, items: [
    { id:"shp", name:"Kids Shampoo",          icon:"shampoo",     w:1,h:2, x:0,y:0, stack:2, count:2, verified:"2026-05-15", rate:{n:0.6,per:"month"}, warn:{mode:"count", value:1} },
    { id:"cnd", name:"Kids Conditioner",      icon:"conditioner", w:1,h:2, x:1,y:0, stack:2, count:1, verified:"2026-05-15", rate:{n:0.5,per:"month"}, warn:{mode:"count", value:1} },
    { id:"ccp", name:"Cradle Cap Conditioner",icon:"cradlecap",   w:1,h:1, x:3,y:0, stack:1, count:1, verified:"2026-06-01", rate:{n:0.3,per:"month"}, warn:{mode:"count", value:0.5} },
    { id:"sun", name:"Kids Sunscreen SPF 50", icon:"sunscreen",   w:1,h:1, x:4,y:0, stack:3, count:2, verified:"2026-06-05", rate:{n:1,  per:"month"}, warn:{mode:"count", value:1} },
  ], tasks: [
    { id:"bt1", name:"Bath night", date:"Tonight", over:false, recur:"M/W/F" },
    { id:"bt2", name:"Trim nails after bath", date:"Jun 11", recur:"WK" },
    { id:"bt3", name:"Deep-clean bath toys", date:"Jun 21", recur:"MO" },
  ]},

  "Garbage": { cat: "HOME", cols: 6, rows: 3, items: [
    { id:"kit", name:"Kitchen Bags · 13 gal", icon:"trashbag",   w:2,h:1, x:0,y:0, stack:90, count:34, verified:"2026-06-01", rate:{n:1,  per:"day"},   warn:{mode:"days",  value:7} },
    { id:"cmp", name:"Compost Liners",        icon:"compostbag", w:1,h:1, x:2,y:0, stack:50, count:9,  verified:"2026-06-01", rate:{n:1,  per:"day"},   warn:{mode:"days",  value:7} },
    { id:"con", name:"Contractor Bags",       icon:"trashbag",   w:1,h:1, x:3,y:1, stack:10, count:6,  verified:"2026-05-01", rate:{n:0.5,per:"month"}, warn:{mode:"count", value:1} },
  ], tasks: [
    { id:"g1", name:"Bins + recycling to curb", date:"Tonight", over:true, recur:"WK" },
    { id:"g2", name:"Yard-waste bin out", date:"Jun 12", recur:"2 WK" },
    { id:"g3", name:"Hazardous-waste drop-off (old paint)", date:"Jun 26", recur:null },
  ]},

  "Pharmacy": { cat: "OUT", cols: 6, rows: 3, items: [
    { id:"mot", name:"Infant Motrin",     icon:"tablets",  w:1,h:1, x:0,y:0, stack:2, count:1, verified:"2026-05-28", rate:{n:0.4,per:"month"}, warn:{mode:"count", value:1} },
    { id:"tyl", name:"Infant Tylenol",    icon:"capsules", w:1,h:1, x:1,y:0, stack:2, count:2, verified:"2026-05-28", rate:{n:0.3,per:"month"}, warn:{mode:"count", value:1} },
    { id:"zyr", name:"Children's Zyrtec", icon:"blister",  w:1,h:1, x:3,y:0, stack:2, count:1, verified:"2026-05-25", rate:{n:1,  per:"month"}, warn:{mode:"count", value:1} },
    { id:"pro", name:"Probiotic Drops",   icon:"drops",    w:1,h:1, x:4,y:1, stack:1, count:1, verified:"2026-06-01", rate:{n:1,  per:"month"}, warn:{mode:"count", value:0.5} },
  ], tasks: [
    { id:"ph1", name:"Pick up allergy refill", date:"Jun 13", recur:null },
    { id:"ph2", name:"Check med expiry dates", date:"Jul 1", recur:"6 MO" },
  ]},

  "Home Goods": { cat: "HOME", cols: 8, rows: 4, items: [
    { id:"tp",  name:"Toilet Paper",        icon:"tp",          w:2,h:2, x:0,y:0, stack:30, count:14, verified:"2026-06-01", rate:{n:0.7, per:"day"},   warn:{mode:"days",  value:7} },
    { id:"pt",  name:"Paper Towels",        icon:"papertowel",  w:2,h:1, x:2,y:0, stack:12, count:3,  verified:"2026-06-01", rate:{n:0.4, per:"day"},   warn:{mode:"days",  value:7} },
    { id:"zlg", name:"Gallon Zip Bags",     icon:"ziplock",     w:1,h:1, x:4,y:0, stack:75, count:40, verified:"2026-06-01", rate:{n:2,   per:"week"},  warn:{mode:"days",  value:7} },
    { id:"zls", name:"Sandwich Zip Bags",   icon:"ziplock",     w:1,h:1, x:5,y:0, stack:90, count:25, verified:"2026-06-01", rate:{n:3,   per:"week"},  warn:{mode:"days",  value:7} },
    { id:"plw", name:"Plastic Wrap",        icon:"plasticwrap", w:1,h:1, x:4,y:1, stack:2,  count:2,  verified:"2026-04-15", rate:{n:0.2, per:"month"}, warn:{mode:"count", value:1} },
    { id:"fol", name:"Aluminum Foil",       icon:"foil",        w:1,h:1, x:5,y:1, stack:2,  count:1,  verified:"2026-04-15", rate:{n:0.25,per:"month"}, warn:{mode:"count", value:1} },
    { id:"par", name:"Parchment Paper",     icon:"parchment",   w:1,h:1, x:6,y:1, stack:2,  count:2,  verified:"2026-04-15", rate:{n:0.15,per:"month"}, warn:{mode:"count", value:1} },
    { id:"wf",  name:"Fridge Water Filter", icon:"waterfilter", w:1,h:1, x:2,y:1, stack:6,  count:2,  verified:"2026-05-10", rate:{n:0.5, per:"month"}, warn:{mode:"count", value:1} },
  ], tasks: [
    { id:"hg1", name:"Costco run — paper goods", date:"Jun 11", over:true, recur:null },
    { id:"hg2", name:"Replace fridge water filter", date:"Jun 15", recur:"2 MO" },
  ]},
};

Object.assign(window, {
  INVENTORIES, INV_NOW,
  invPerDay, invDaysSince, invEst, invDaysLeft, invStatus,
  invFmt, invDateLabel, invRunout, invRateLabel, invChip,
});

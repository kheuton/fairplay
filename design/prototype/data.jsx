/* data.jsx — FairPlay sample data (cards, tasks, schematic map) */

const CAT_COLORS = {
  "Auto": "#EE5B2B", "Home Maintenance": "#0C857C", "Garbage": "#9A7B33",
  "Dinners": "#5B6BB0", "Cash & Bills": "#5B6BB0", "Date Night": "#C0497E",
  "_default": "var(--ink-3)",
};
function cardColor(c){ return CAT_COLORS[c] || "var(--accent-2)"; }

const CARD_GROUPS = [
  { cat: "HOME", items: [
    { n:"01", name:"Auto", due:4, custom:"auto" },
    { n:"02", name:"Home Maintenance", due:3, custom:"home" },
    { n:"03", name:"Garbage", due:2, custom:"inventory" },
    { n:"04", name:"Dinners", due:2 },
    { n:"05", name:"Dishes", due:0 },
    { n:"06", name:"Laundry", due:1 },
    { n:"07", name:"Cleaning", due:2 },
    { n:"08", name:"Lawn & Plants", due:1 },
    { n:"09", name:"Groceries", due:0 },
    { n:"10", name:"Tidying Up", due:0 },
    { n:"11", name:"Home Repairs", due:1 },
    { n:"31", name:"Home Goods", due:2, custom:"inventory" },
  ]},
  { cat: "OUT", items: [
    { n:"12", name:"Cash & Bills", due:2 },
    { n:"13", name:"Mail & Packages", due:0 },
    { n:"14", name:"Pharmacy", due:2, custom:"inventory" },
    { n:"15", name:"Tech & Devices", due:0 },
    { n:"16", name:"Travel Plans", due:0 },
    { n:"17", name:"Errands", due:1 },
    { n:"18", name:"Pet Care", due:1 },
  ]},
  { cat: "CAREGIVING", items: [
    { n:"19", name:"Health & Doctors", due:1 },
    { n:"20", name:"Calendar Keeper", due:0 },
    { n:"21", name:"Friends & Family", due:0 },
    { n:"22", name:"Gifts", due:0 },
    { n:"23", name:"School & Forms", due:0 },
    { n:"24", name:"Birthdays", due:1 },
    { n:"32", name:"Diapering", due:2, custom:"inventory" },
    { n:"33", name:"Bathtime", due:1, custom:"inventory" },
  ]},
  { cat: "MAGIC", items: [
    { n:"25", name:"Date Night", due:0, custom:"datenight" },
    { n:"26", name:"Hosting", due:0 },
    { n:"27", name:"Traditions", due:0 },
    { n:"28", name:"Adventures", due:0 },
    { n:"29", name:"Self-Care", due:0 },
    { n:"30", name:"Charity", due:0 },
  ]},
];

// ---- inbox (triage) tasks -----------------------------------
const INBOX = [
  { id:"i1", g:"OVERDUE", urgent:true,  name:"Order furnace filters (16×25×1)", card:"Home Maintenance", due:"2 days ago", d2:"was Jun 6", recur:null },
  { id:"i2", g:"OVERDUE", urgent:true,  name:"Replace driver-side wiper blade", card:"Auto", due:"1 day ago", d2:"was Jun 7", recur:null },
  { id:"i3", g:"TODAY",   urgent:true,  name:"Take bins + recycling to curb", card:"Garbage", due:"Tonight", d2:"8:00 PM", recur:"WK" },
  { id:"i4", g:"TODAY",   urgent:false, name:"Defrost chicken for dinner", card:"Dinners", due:"5:00 PM", d2:"today", recur:null },
  { id:"i5", g:"TODAY",   urgent:false, name:"Replace HVAC return filter", card:"Home Maintenance", due:"6:00 PM", d2:"today", recur:"MO" },
  { id:"i6", g:"TODAY",   urgent:false, name:"Plan the week's dinners", card:"Dinners", due:"EOD", d2:"today", recur:"WK" },
  { id:"i7", g:"THIS WEEK", urgent:false, name:"Oil change @ 45,200 mi", card:"Auto", due:"Mon Jun 9", d2:"appt 10:30", recur:"5K MI" },
  { id:"i8", g:"THIS WEEK", urgent:false, name:"Renew vehicle registration", card:"Auto", due:"Fri Jun 12", d2:"DMV online", recur:"1 YR" },
  { id:"i9", g:"THIS WEEK", urgent:false, name:"Pay water + power bill", card:"Cash & Bills", due:"Fri Jun 12", d2:"autopay off", recur:"MO" },
];

// ---- a generic card's task list (Garbage default timeline) --
const GARBAGE = [
  { id:"g1", month:"JUN 2026", date:"TONIGHT", over:false, urgent:true, name:"Bins + recycling to curb", mt:"⟳ WEEKLY · 8:00 PM", recur:true },
  { id:"g2", month:"JUN 2026", date:"Jun 12", name:"Yard-waste bin out", mt:"⟳ BIWEEKLY", recur:true },
  { id:"g3", month:"JUN 2026", date:"Jun 15", name:"Break down cardboard pile", mt:"ONE-OFF · garage", recur:false },
  { id:"g4", month:"JUN 2026", date:"Jun 19", name:"Bins + recycling to curb", mt:"⟳ WEEKLY", recur:true },
  { id:"g5", month:"JUN 2026", date:"Jun 26", name:"Hazardous-waste drop-off", mt:"ONE-OFF · old paint", recur:false },
  { id:"g6", month:"JUL 2026", date:"Jul 03", name:"Bins + recycling to curb", mt:"⟳ WEEKLY", recur:true },
  { id:"g7", month:"JUL 2026", date:"Jul 10", name:"Replace kitchen bin liners", mt:"⟳ MONTHLY", recur:true },
];

// ---- Auto card: tasks tagged to a schematic part ------------
const AUTO = [
  { id:"a1", part:"fluids", name:"Replace driver-side wiper blade", date:"1 day ago", over:true,  d2:"overdue", recur:null },
  { id:"a2", part:"engine", name:"Oil change @ 45,200 mi", date:"Mon Jun 9", d2:"appt 10:30", recur:"5K MI" },
  { id:"a3", part:"body",   name:"Renew vehicle registration", date:"Fri Jun 12", d2:"DMV online", recur:"1 YR" },
  { id:"a4", part:"tires",  name:"Rotate tires", date:"Sat Jun 20", d2:"w/ oil change", recur:"6 MO" },
  { id:"a5", part:"engine", name:"Smog / emissions check", date:"Jul 1", d2:"req. for reg.", recur:"2 YR" },
  { id:"a6", part:"body",   name:"Wash + vacuum interior", date:"Jun 14", d2:"weekend", recur:"2 WK" },
  { id:"a7", part:"tires",  name:"Check tire pressure (all 4)", date:"Jun 15", d2:"32 psi", recur:"1 MO" },
  { id:"a8", part:"fluids", name:"Top off washer fluid", date:"Jun 22", d2:"—", recur:"1 MO" },
  { id:"a9", part:"brakes", name:"Brake pad inspection", date:"Aug 5", d2:"front pads", recur:"1 YR" },
];

const AUTO_PARTS = [
  { id:"engine", label:"ENGINE",  x:188, y:150 },
  { id:"fluids", label:"FLUIDS",  x:250, y:120 },
  { id:"tires",  label:"TIRES",   x:150, y:250 },
  { id:"brakes", label:"BRAKES",  x:430, y:252 },
  { id:"body",   label:"BODY",    x:360, y:120 },
];

Object.assign(window, { CARD_GROUPS, INBOX, GARBAGE, AUTO, AUTO_PARTS, cardColor });

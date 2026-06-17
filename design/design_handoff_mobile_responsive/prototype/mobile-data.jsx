/* mobile-data.jsx — FairPlay mobile sample data
   Flat cards (no bespoke views) + per-task owner + time bucket.
   today = Tue · Jun 9, 2026 */

const CAT_COLORS = {
  "Auto":"#EE5B2B", "Home Maintenance":"#0C857C", "Garbage":"#9A7B33",
  "Dinners":"#5B6BB0", "Cash & Bills":"#5B6BB0", "Date Night":"#C0497E",
  "Laundry":"#0C857C", "Cleaning":"#0C857C", "Lawn & Plants":"#0C857C",
  "Pet Care":"#9A7B33", "Errands":"#9A7B33", "Birthdays":"#C0497E",
  "Health & Doctors":"#5B6BB0", "Groceries":"#9A7B33",
};
function cardColor(c){ return CAT_COLORS[c] || "var(--accent-2)"; }

const PEOPLE = {
  amy:  { id:"amy",  name:"Amy",  initial:"A" },
  kyle: { id:"kyle", name:"Kyle", initial:"K" },
};

// ---- cards (category-grouped, flair removed) ----------------
const CARDS = [
  { n:"01", name:"Auto",            cat:"HOME" },
  { n:"02", name:"Home Maintenance",cat:"HOME" },
  { n:"03", name:"Garbage",         cat:"HOME" },
  { n:"04", name:"Dinners",         cat:"HOME" },
  { n:"05", name:"Dishes",          cat:"HOME" },
  { n:"06", name:"Laundry",         cat:"HOME" },
  { n:"07", name:"Cleaning",        cat:"HOME" },
  { n:"08", name:"Lawn & Plants",   cat:"HOME" },
  { n:"09", name:"Groceries",       cat:"HOME" },
  { n:"10", name:"Tidying Up",      cat:"HOME" },
  { n:"11", name:"Home Repairs",    cat:"HOME" },
  { n:"12", name:"Cash & Bills",    cat:"OUT" },
  { n:"13", name:"Mail & Packages", cat:"OUT" },
  { n:"14", name:"Pharmacy",        cat:"OUT" },
  { n:"15", name:"Tech & Devices",  cat:"OUT" },
  { n:"16", name:"Travel Plans",    cat:"OUT" },
  { n:"17", name:"Errands",         cat:"OUT" },
  { n:"18", name:"Pet Care",        cat:"OUT" },
  { n:"19", name:"Health & Doctors",cat:"CAREGIVING" },
  { n:"20", name:"Calendar Keeper", cat:"CAREGIVING" },
  { n:"21", name:"Friends & Family",cat:"CAREGIVING" },
  { n:"22", name:"Gifts",           cat:"CAREGIVING" },
  { n:"23", name:"School & Forms",  cat:"CAREGIVING" },
  { n:"24", name:"Birthdays",       cat:"CAREGIVING" },
  { n:"25", name:"Date Night",      cat:"MAGIC" },
  { n:"26", name:"Hosting",         cat:"MAGIC" },
  { n:"27", name:"Traditions",      cat:"MAGIC" },
  { n:"28", name:"Adventures",      cat:"MAGIC" },
  { n:"29", name:"Self-Care",       cat:"MAGIC" },
  { n:"30", name:"Charity",         cat:"MAGIC" },
];
const CAT_ORDER = ["HOME","OUT","CAREGIVING","MAGIC"];

// bucket: overdue | today | week | later
// t (task): { id, card, name, owner, bucket, due, recur }
let __id = 0; const uid = (p) => `${p}${++__id}`;
const T = (card, name, owner, bucket, due, recur=null) =>
  ({ id: uid("t"), card, name, owner, bucket, due, recur });

const TASKS = [
  // Auto
  T("Auto","Replace driver-side wiper blade","kyle","overdue","1 day ago"),
  T("Auto","Oil change @ 45,200 mi","kyle","today","10:30 AM","5K MI"),
  T("Auto","Renew vehicle registration","kyle","week","Fri Jun 12","1 YR"),
  T("Auto","Rotate tires","kyle","later","Sat Jun 20","6 MO"),
  T("Auto","Check tire pressure (all 4)","amy","later","Jun 15","1 MO"),
  // Home Maintenance
  T("Home Maintenance","Order furnace filters (16×25×1)","amy","overdue","2 days ago"),
  T("Home Maintenance","Replace HVAC return filter","amy","today","6:00 PM","1 MO"),
  T("Home Maintenance","Test smoke + CO detectors","kyle","later","Jun 24","6 MO"),
  // Garbage
  T("Garbage","Bins + recycling to curb","kyle","today","Tonight 8 PM","WEEKLY"),
  T("Garbage","Yard-waste bin out","kyle","week","Thu Jun 11","2 WK"),
  T("Garbage","Break down cardboard pile","amy","later","Jun 15"),
  // Dinners
  T("Dinners","Defrost chicken for tonight","amy","today","5:00 PM"),
  T("Dinners","Plan the week's dinners","amy","today","EOD","WEEKLY"),
  T("Dinners","Shop for Sunday roast","kyle","week","Sat Jun 13"),
  // Dishes
  T("Dishes","Unload + reload dishwasher","kyle","today","After dinner","DAILY"),
  T("Dishes","Descale the dishwasher","amy","later","Jun 28","3 MO"),
  // Laundry
  T("Laundry","Wash + fold darks","amy","today","Eve","2X WK"),
  T("Laundry","Strip + wash bed sheets","kyle","week","Sun Jun 14","WEEKLY"),
  // Cleaning
  T("Cleaning","Vacuum main floor","kyle","today",null,"WEEKLY"),
  T("Cleaning","Clean both bathrooms","amy","week","Sat Jun 13","WEEKLY"),
  T("Cleaning","Wipe kitchen counters","amy","today",null,"DAILY"),
  // Lawn & Plants
  T("Lawn & Plants","Water indoor plants","amy","today",null,"2X WK"),
  T("Lawn & Plants","Mow the lawn","kyle","week","Sat Jun 13","WEEKLY"),
  // Groceries
  T("Groceries","Midweek produce run","amy","week","Wed Jun 10"),
  T("Groceries","Restock pantry staples","kyle","later","Jun 21"),
  // Home Repairs
  T("Home Repairs","Fix leaky bathroom faucet","kyle","week","Jun 12"),
  // Cash & Bills
  T("Cash & Bills","Pay water + power bill","kyle","week","Fri Jun 12","MONTHLY"),
  T("Cash & Bills","Review credit-card statement","amy","later","Jun 18","MONTHLY"),
  // Mail & Packages
  T("Mail & Packages","Pick up held mail","amy","today",null),
  // Pharmacy
  T("Pharmacy","Refill allergy prescription","amy","week","Jun 13"),
  // Errands
  T("Errands","Return Amazon package","amy","week","Jun 12"),
  T("Errands","Pick up dry cleaning","kyle","today","Lunch"),
  // Pet Care
  T("Pet Care","Refill dog food","kyle","week","Jun 13"),
  T("Pet Care","Annual vet checkup","amy","later","Jul 2","1 YR"),
  // Health & Doctors
  T("Health & Doctors","Schedule dentist cleaning","amy","later","Jun 30"),
  // Birthdays
  T("Birthdays","Order Mom's birthday gift","kyle","week","Jun 14"),
  // Date Night
  T("Date Night","Book the sitter for Saturday","amy","week","by Thu Jun 11"),
  T("Date Night","Pick + reserve a restaurant","kyle","week","Fri Jun 12"),
  // Gifts
  T("Gifts","Wrap anniversary present","amy","later","Jun 19"),
  // Travel Plans
  T("Travel Plans","Confirm August flight seats","kyle","later","Jun 23"),
];

// ensure every card has at least one task so none open empty
const __have = new Set(TASKS.map(t => t.card));
CARDS.forEach((c, i) => {
  if (!__have.has(c.name)) {
    const owner = i % 2 ? "kyle" : "amy";
    TASKS.push(T(c.name, `${c.name} · weekly pass`, owner, "later", "this month", "WEEKLY"));
  }
});

// ---- queries ------------------------------------------------
const BUCKET_LABEL = { overdue:"OVERDUE", today:"TODAY", week:"THIS WEEK", later:"LATER" };
const BUCKET_ORDER = ["overdue","today","week","later"];
const INBOX_BUCKETS = ["overdue","today","week"];

function tasksForCard(card, owner) {
  return TASKS.filter(t => t.card === card && (!owner || t.owner === owner));
}
function inboxTasks(owner) {
  return TASKS.filter(t => INBOX_BUCKETS.includes(t.bucket) && (!owner || t.owner === owner));
}
function cardDue(card, owner) {
  return TASKS.filter(t => t.card === card && INBOX_BUCKETS.includes(t.bucket) && (!owner || t.owner === owner)).length;
}
function ownerCounts() {
  const c = { amy:0, kyle:0 };
  TASKS.forEach(t => { if (INBOX_BUCKETS.includes(t.bucket)) c[t.owner]++; });
  return c;
}

// seeded "already done" history for the Done screen
const DONE_HISTORY = [
  { id:"h1", card:"Dishes", name:"Empty the dishwasher", owner:"kyle", when:"TODAY", at:"8:12 AM" },
  { id:"h2", card:"Dinners", name:"Make the kids' lunches", owner:"amy", when:"TODAY", at:"7:40 AM" },
  { id:"h3", card:"Pet Care", name:"Morning dog walk", owner:"kyle", when:"TODAY", at:"7:05 AM" },
  { id:"h4", card:"Garbage", name:"Bins + recycling to curb", owner:"kyle", when:"THIS WEEK", at:"Mon" },
  { id:"h5", card:"Cleaning", name:"Vacuum main floor", owner:"amy", when:"THIS WEEK", at:"Mon" },
  { id:"h6", card:"Cash & Bills", name:"Pay mortgage", owner:"amy", when:"THIS WEEK", at:"Sun" },
  { id:"h7", card:"Laundry", name:"Wash + fold lights", owner:"kyle", when:"THIS WEEK", at:"Sun" },
];

Object.assign(window, {
  PEOPLE, CARDS, CAT_ORDER, TASKS, BUCKET_LABEL, BUCKET_ORDER, INBOX_BUCKETS,
  DONE_HISTORY, cardColor, tasksForCard, inboxTasks, cardDue, ownerCounts,
});

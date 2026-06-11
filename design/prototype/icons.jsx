/* icons.jsx — FairPlay supply icon family.
   24×24 grid, 1.4px stroke, square caps/miter joins to match the
   technical/mono aesthetic. All stroke currentColor so they inherit. */

const ICON_LIB = {
  diaper: { label: "Diaper", g: (<>
    <path d="M4 7 H20 V10.5 C20 16.5 16.5 20 12 20 C7.5 20 4 16.5 4 10.5 Z"/>
    <path d="M4 10.5 H20" opacity=".5"/>
    <path d="M7 7 V4.8 H10 V7 M14 7 V4.8 H17 V7" opacity=".5"/>
  </>)},
  wipes: { label: "Wipes", g: (<>
    <rect x="4" y="10" width="16" height="9"/>
    <path d="M4 13 H20" opacity=".5"/>
    <path d="M11 10 C11 7.2 14 7.6 14 4.6"/>
  </>)},
  cream: { label: "Cream / Ointment", g: (<>
    <rect x="10" y="4" width="4" height="2.6"/>
    <path d="M9.5 8.2 H14.5 L16.2 19.5 H7.8 Z"/>
    <path d="M12 12.2 V15.8 M10.2 14 H13.8" opacity=".6"/>
  </>)},
  trashbag: { label: "Trash Bag", g: (<>
    <path d="M7.5 8.8 C7.5 7.2 9.5 6.6 12 6.6 C14.5 6.6 16.5 7.2 16.5 8.8 L18 20 H6 Z"/>
    <path d="M9.6 6.8 L8.2 3.8 M14.4 6.8 L15.8 3.8"/>
  </>)},
  compostbag: { label: "Compost Bag", g: (<>
    <path d="M8 9.4 C8 8 9.8 7.5 12 7.5 C14.2 7.5 16 8 16 9.4 L17.2 20 H6.8 Z"/>
    <path d="M10.2 7.6 L9.2 5.2 M13.8 7.6 L14.8 5.2"/>
    <path d="M12 11.6 C14.8 11.6 15.4 13.8 15.4 15.8 C12.6 15.8 12 13.6 12 11.6 Z" opacity=".7"/>
    <path d="M13 13.2 C11.8 14.6 11 15.8 10.2 17.4" opacity=".7"/>
  </>)},
  waterfilter: { label: "Water Filter", g: (<>
    <path d="M7 5 H17.5 L16.2 20 H8.3 Z"/>
    <path d="M17.3 7.2 C20.4 7.6 20 12 16.7 12.2"/>
    <path d="M8.4 13 H16" opacity=".5"/>
    <path d="M12 7.4 C13.1 8.8 13.1 10 12 10 C10.9 10 10.9 8.8 12 7.4 Z" opacity=".7"/>
  </>)},
  tablets: { label: "Tablets (Motrin)", g: (<>
    <rect x="8" y="4.6" width="8" height="2.8"/>
    <rect x="8.8" y="7.4" width="6.4" height="12.2"/>
    <path d="M8.8 10.4 H15.2" opacity=".5"/>
    <circle cx="12" cy="14.6" r="2.1"/>
    <path d="M9.9 14.6 H14.1"/>
  </>)},
  capsules: { label: "Capsules (Tylenol)", g: (<>
    <rect x="8" y="4.6" width="8" height="2.8"/>
    <rect x="8.8" y="7.4" width="6.4" height="12.2"/>
    <path d="M8.8 10.4 H15.2" opacity=".5"/>
    <rect x="9.6" y="13.4" width="4.8" height="2.6" rx="1.3"/>
    <path d="M12 13.4 V16"/>
  </>)},
  blister: { label: "Blister Pack (Zyrtec)", g: (<>
    <rect x="5" y="7.4" width="14" height="11.2"/>
    <circle cx="8.8" cy="11" r="1.5"/><circle cx="15.2" cy="11" r="1.5"/>
    <circle cx="8.8" cy="15" r="1.5"/><circle cx="15.2" cy="15" r="1.5"/>
    <path d="M12 7.4 V18.6" opacity=".5" strokeDasharray="1.6 1.6"/>
  </>)},
  drops: { label: "Drops (Probiotic)", g: (<>
    <circle cx="12" cy="4.6" r="1.7"/>
    <rect x="10.9" y="6.3" width="2.2" height="2.2"/>
    <path d="M8.5 10.4 L10.4 8.5 H13.6 L15.5 10.4 V19.6 H8.5 Z"/>
    <path d="M12 8.5 V15.4" opacity=".5"/>
  </>)},
  formula: { label: "Formula Canister", g: (<>
    <rect x="4.6" y="5" width="12.4" height="2.6"/>
    <rect x="5.4" y="7.6" width="10.8" height="12.4"/>
    <path d="M5.4 11 H16.2 M5.4 16 H16.2" opacity=".4"/>
    <circle cx="19.4" cy="17.4" r="2"/>
    <path d="M19.4 15.4 V11.6"/>
  </>)},
  shampoo: { label: "Pump Bottle (Shampoo)", g: (<>
    <rect x="8" y="10" width="8" height="10"/>
    <rect x="11.2" y="8" width="1.6" height="2"/>
    <path d="M12 8 V5.4"/>
    <rect x="11.2" y="3.6" width="4.6" height="1.8"/>
    <path d="M8 13.4 H16" opacity=".4"/>
  </>)},
  conditioner: { label: "Squeeze Bottle (Conditioner)", g: (<>
    <path d="M8 4 H16 V13.8 L14.4 16.4 H9.6 L8 13.8 Z"/>
    <rect x="10" y="16.4" width="4" height="3.4"/>
    <path d="M8 8 H16" opacity=".4"/>
  </>)},
  cradlecap: { label: "Cradle Cap (Jar + Comb)", g: (<>
    <path d="M8 4.4 H16"/>
    <path d="M9.6 4.4 V7.2 M12 4.4 V7.2 M14.4 4.4 V7.2"/>
    <rect x="6.4" y="9.4" width="11.2" height="2.2"/>
    <rect x="7.2" y="11.6" width="9.6" height="8"/>
  </>)},
  sunscreen: { label: "Sunscreen", g: (<>
    <circle cx="12" cy="5.2" r="1.9"/>
    <path d="M7.4 5.2 H8.8 M15.2 5.2 H16.6 M12 1.8 V2.6"/>
    <rect x="10.6" y="9.4" width="2.8" height="1.8"/>
    <path d="M8 11.2 H16 V20 H8 Z"/>
    <path d="M8 15 H16" opacity=".4"/>
  </>)},
  tp: { label: "Toilet Paper", g: (<>
    <circle cx="11.5" cy="9.8" r="5.6"/>
    <circle cx="11.5" cy="9.8" r="1.8" opacity=".6"/>
    <path d="M17.1 9.8 V18.6 H13"/>
  </>)},
  papertowel: { label: "Paper Towel", g: (<>
    <ellipse cx="12" cy="6.4" rx="5" ry="1.9"/>
    <ellipse cx="12" cy="6.4" rx="1.6" ry=".7" opacity=".6"/>
    <path d="M7 6.4 V18 C7 19.4 17 19.4 17 18 V6.4"/>
  </>)},
  ziplock: { label: "Zip Bags", g: (<>
    <rect x="6" y="6.4" width="12" height="13.2"/>
    <path d="M6 9.6 H18"/>
    <path d="M6 10.8 H18" opacity=".4"/>
    <rect x="10.8" y="8.2" width="2.4" height="2.8"/>
  </>)},
  plasticwrap: { label: "Plastic Wrap", g: (<>
    <rect x="4.5" y="12.6" width="15" height="5.8"/>
    <circle cx="7" cy="15.5" r="1.1" opacity=".5"/>
    <path d="M10 12.6 C10 9 14 10.4 14 6.4"/>
  </>)},
  foil: { label: "Aluminum Foil", g: (<>
    <rect x="4.5" y="12.6" width="15" height="5.8"/>
    <circle cx="7" cy="15.5" r="1.1" opacity=".5"/>
    <path d="M9.5 12.6 V9 L11.3 10.6 L13.1 9 L14.9 10.6 L16.7 9 V12.6"/>
  </>)},
  parchment: { label: "Parchment Paper", g: (<>
    <rect x="4.5" y="12.6" width="15" height="5.8"/>
    <circle cx="8.4" cy="9.4" r="2"/>
    <path d="M10.4 9.4 H16.6 V12.6"/>
  </>)},
  generic: { label: "Generic Supply", g: (<>
    <rect x="5" y="5" width="14" height="14"/>
    <path d="M5 12 H19 M12 5 V19" opacity=".4"/>
  </>)},
};

const ICON_ORDER = Object.keys(ICON_LIB);

function ItemIcon({ name, size = 28 }) {
  const def = ICON_LIB[name] || ICON_LIB.generic;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter" style={{display:"block"}}>
      {def.g}
    </svg>
  );
}

Object.assign(window, { ICON_LIB, ICON_ORDER, ItemIcon });

/* ============================================================
   FairPlay · "Vectorheart" rich icon set
   ------------------------------------------------------------
   Detailed, multi-color vector illustrations of each supply.
   Built on a tiny parts system so lighting stays consistent:
   light source top-left → sheen on the left, shade plane on
   the right, content detail + label on the body.

   Designed to sit on a DARK badge stage (objects are light /
   saturated and pop). 24×24 viewBox. RICH_ICONS[key] = {label,cat,svg}.
   ============================================================ */
(function () {

  /* palette — bodies come with a light (L) and dark (D) sibling */
  const C = {
    white:'#F4EFE3', sheen:'#FFFFFF', cream:'#F4EFE3',
    cap:'#EAEDF0', capD:'#C4C9CF', capL:'#FBFCFD',
    ink:'#23202B', inkSoft:'#3A3645',
    sky:'#BAD9E6', skyL:'#DCEFF4', skyD:'#92BED0',
    blue:'#3A78C2', blueL:'#6BA0DC', blueD:'#2A5896',
    teal:'#1F9E91', tealL:'#4FC2B5', tealD:'#157167',
    violet:'#7E66DE', violetL:'#A18FE9', violetD:'#5C45B6',
    pink:'#E0589A', pinkL:'#EE8AB9', pinkD:'#B83C78',
    amber:'#E8A33D', amberL:'#F4C374', amberD:'#BE7E1E',
    orange:'#E07B3C', orangeL:'#EFA471', orangeD:'#B65A20',
    green:'#46A85F', greenL:'#74C489', greenD:'#2E7C42',
    red:'#D44A3C', redL:'#E67E73', redD:'#A82F24',
    silver:'#C4CAD0', silverL:'#E2E6EA', silverD:'#9AA1A9',
    kraft:'#CDA06A', kraftL:'#E0BE8E', kraftD:'#A87A45',
    slate:'#5B6472', slateL:'#828B99', slateD:'#3E4552',
  };

  const rr  = (x,y,w,h,r,f,o='') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${f}"${o?` opacity="${o}"`:''}/>`;
  const pa  = (d,f,o='')         => `<path d="${d}" fill="${f}"${o?` opacity="${o}"`:''}/>`;
  const ci  = (cx,cy,r,f,o='')   => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f}"${o?` opacity="${o}"`:''}/>`;
  const sheen = (x,y,h,f=C.sheen,w=1.4) => rr((x+0.85).toFixed(2),(y+0.7).toFixed(2),w,(h-1.5).toFixed(2),0.7,f,0.5);
  // teardrop centered at (cx,cy) top, scale s
  const drop = (cx,cy,s,f) => pa(`M${cx} ${cy} C${(cx+0.95*s).toFixed(2)} ${(cy+1.15*s).toFixed(2)} ${(cx+1.02*s).toFixed(2)} ${(cy+1.95*s).toFixed(2)} ${(cx+1.02*s).toFixed(2)} ${(cy+2.4*s).toFixed(2)} a${(1.02*s).toFixed(2)} ${(1.02*s).toFixed(2)} 0 0 1 ${(-2.04*s).toFixed(2)} 0 C${(cx-1.02*s).toFixed(2)} ${(cy+1.95*s).toFixed(2)} ${(cx-0.95*s).toFixed(2)} ${(cy+1.15*s).toFixed(2)} ${cx} ${cy} Z`, f);
  const lines = (x,y,w,f) => rr(x,y,w,0.85,0.4,f,0.85)+rr(x,(y+1.7).toFixed(2),(w*0.7).toFixed(2),0.85,0.4,f,0.6);
  // labelled body content block
  const star4 = (cx,cy,s,f) => pa(`M${cx} ${cy-s} L${(cx+0.34*s).toFixed(2)} ${(cy-0.34*s).toFixed(2)} L${cx+s} ${cy} L${(cx+0.34*s).toFixed(2)} ${(cy+0.34*s).toFixed(2)} L${cx} ${cy+s} L${(cx-0.34*s).toFixed(2)} ${(cy+0.34*s).toFixed(2)} L${cx-s} ${cy} L${(cx-0.34*s).toFixed(2)} ${(cy-0.34*s).toFixed(2)} Z`, f);
  const leaf = (cx,cy,s,f) => pa(`M${cx} ${cy} C${cx+2.6*s} ${cy+0.2*s} ${cx+2.6*s} ${cy+3.4*s} ${cx-0.2*s} ${cy+4*s} C${cx-1*s} ${cy+2*s} ${cx-0.9*s} ${cy+1*s} ${cx} ${cy} Z`, f);

  const I = {};

  /* ════════════ KITCHEN ════════════ */
  I.formula = { label:"Baby Formula", cat:"Kitchen", svg:
    rr(5.4,3.3,13.2,3,1,C.cap) + rr(12.4,3.3,6.2,3,1,C.capD) +
    pa("M6 6 H18 V20 a1 1 0 0 1-1 1 H7 a1 1 0 0 1-1-1 Z", C.sky) +
    pa("M12.7 6 H18 V20 a1 1 0 0 1-1 1 H12.7 Z", C.skyD) +
    sheen(6,6,15,C.skyL) +
    rr(7.7,9,8.6,8,1,C.white) +
    ci(10.7,13,2.05,C.blue) + pa("M12.2 12.1 L15 10.9 L15.5 12 L12.7 13.2 Z", C.blue) +
    rr(8.7,15.9,6.6,0.9,0.4,C.skyD,'0.8') };

  I.plasticwrap = { label:"Cling Wrap", cat:"Kitchen", svg:
    pa("M9.4 12.6 C9.4 9 12.2 10.4 12.2 6.6 a1 1 0 0 1 2 0 C14.2 11.4 9.4 9.8 9.4 12.6 Z", C.skyL,'0.9') +
    rr(3.6,12.4,16.8,8,1.2,C.amber) + rr(13,12.4,7.4,8,1.2,C.amberD) +
    sheen(3.6,12.4,8,C.amberL) +
    rr(5.6,14.2,8.4,2.3,0.5,C.white) + lines(6.6,15,5,C.amberD) +
    rr(3.6,18.4,16.8,2,0.4,C.ink) +
    pa("M4.2 18.4 L5 19.7 L5.8 18.4 L6.6 19.7 L7.4 18.4 L8.2 19.7 L9 18.4 L9.8 19.7 L10.6 18.4 L11.4 19.7 L12.2 18.4 L13 19.7 L13.8 18.4 L14.6 19.7 L15.4 18.4 L16.2 19.7 L17 18.4 L17.8 19.7 L18.6 18.4 L19.4 19.7 L19.8 18.4 Z", C.silver,'0.85') };

  I.foil = { label:"Aluminum Foil", cat:"Kitchen", svg:
    pa("M8.4 12.4 V8.2 L10.2 9.9 L12 8.2 L13.8 9.9 L15.6 8.2 V12.4 Z", C.silverL) +
    pa("M12 12.4 V8.2 L13.8 9.9 L15.6 8.2 V12.4 Z", C.silver) +
    rr(3.6,12.4,16.8,8,1.2,C.slate) + rr(13,12.4,7.4,8,1.2,C.slateD) +
    sheen(3.6,12.4,8,C.slateL) +
    rr(5.6,14.4,8.4,2.2,0.5,C.silverL) + rr(6.4,15.1,4.4,0.85,0.4,C.slate,'0.8') +
    rr(3.6,18.4,16.8,2,0.4,C.ink) };

  I.parchment = { label:"Parchment Paper", cat:"Kitchen", svg:
    pa("M7 9.6 a2.6 2.6 0 0 1 5.2 0 V12.6 H7 Z", C.kraftL) + ci(9.6,9.6,2.6,C.kraftL) + ci(9.6,9.6,1,C.kraftD) +
    pa("M12 8.2 H16.4 a1.4 1.4 0 0 1 0 2.8 H12 Z", C.cream) +
    rr(3.6,12.4,16.8,8,1.2,C.kraft) + rr(13,12.4,7.4,8,1.2,C.kraftD) +
    sheen(3.6,12.4,8,C.kraftL) +
    rr(5.6,14.4,8.4,2.2,0.5,C.cream) + lines(6.5,15.1,5,C.kraftD) +
    rr(3.6,18.4,16.8,2,0.4,C.ink) };

  const zipBag = (topY, zipColor, fillN, sandwich) => {
    const slider = rr(10.4,(topY-2).toFixed(2),3.2,2,0.6,zipColor);
    const body = pa(`M${5.6} ${topY+1.4} a1.3 1.3 0 0 1 1.3-1.3 H17.1 a1.3 1.3 0 0 1 1.3 1.3 L18.8 19.6 a1.3 1.3 0 0 1-1.3 1.4 H6.5 a1.3 1.3 0 0 1-1.3-1.4 Z`, C.skyL,'0.92');
    const bodyShade = pa(`M12 ${topY+0.1} H17.1 a1.3 1.3 0 0 1 1.3 1.3 L18.8 19.6 a1.3 1.3 0 0 1-1.3 1.4 H12 Z`, C.sky,'0.8');
    const zip = rr(5.6,(topY+0.1).toFixed(2),12.8,1.5,0.4,zipColor);
    const zip2 = rr(5.6,(topY+1.7).toFixed(2),12.8,0.7,0.2,zipColor,'0.55');
    let fills='';
    const fy = topY+5.4;
    for(let i=0;i<fillN;i++) fills += rr(7.6,(fy+i*2).toFixed(2),8.8,0.9,0.4,C.skyD,'0.7');
    const tri = sandwich ? pa(`M12 ${fy+0.4} L15 ${fy+5} H9 Z`, C.amberL) : '';
    return slider+body+bodyShade+zip+zip2+fills+tri+sheen(6,topY+1.4,17.5-topY,C.sheen);
  };
  I.ziploc_gal  = { label:"Gallon Zip Bags",   cat:"Kitchen", svg: zipBag(4.2, C.blue, 3, false) };
  I.ziploc_qt   = { label:"Quart Zip Bags",    cat:"Kitchen", svg: zipBag(6.0, C.green, 2, false) };
  I.ziploc_sand = { label:"Sandwich Zip Bags", cat:"Kitchen", svg: zipBag(7.6, C.amber, 0, true) };

  /* ════════════ PAPER ════════════ */
  I.tp = { label:"Toilet Paper", cat:"Paper", svg:
    pa("M16.8 9.4 H20.4 V19 a1.4 1.4 0 0 1-1.4 1.4 H15.4 V18.2 H18 V11.4 H16.8 Z", C.silver) +
    ci(11,11.2,6.6,C.white) + ci(11,11.2,6.6,C.silverL,'0') +
    pa("M11 4.6 a6.6 6.6 0 0 1 6.6 6.6 H11 Z", C.cream) +
    ci(11,11.2,2.2,C.kraftL) + ci(11,11.2,2.2,C.kraftD,'0') +
    ci(11,11.2,0.9,C.kraftD) +
    pa("M17.6 11.2 H20.2 V13 H17.6 Z", C.cream) +
    sheen(5,5,12,C.sheen) };

  I.papertowel = { label:"Paper Towel", cat:"Paper", svg:
    rr(6.4,5.6,11.2,15,1.2,C.white) + rr(13,5.6,4.6,15,1.2,C.cream) +
    sheen(6.4,5.6,15,C.sheen) +
    rr(6.4,5.6,11.2,2.6,1.2,C.blue) + rr(13,5.6,4.6,2.6,1.2,C.blueD) +
    rr(7.6,11,8.8,0.8,0.4,C.silverD,'0.5') + rr(7.6,14,8.8,0.8,0.4,C.silverD,'0.5') + rr(7.6,17,8.8,0.8,0.4,C.silverD,'0.5') +
    ci(12,7,1.6,C.white) + ci(12,7,0.6,C.blueD) +
    pa("M11.2 20.6 V22 H12.8 V20.6 Z", C.cream) };

  I.tissues = { label:"Tissues", cat:"Paper", svg:
    pa("M11 12.6 C11 9 13.4 9.8 13.4 6.2 L15.2 6.2 C15.2 10.4 11 9.4 11 12.6 Z", C.white) +
    pa("M4.5 9.6 H19.5 V20 a1 1 0 0 1-1 1 H5.5 a1 1 0 0 1-1-1 Z", C.teal) +
    pa("M12.6 9.6 H19.5 V20 a1 1 0 0 1-1 1 H12.6 Z", C.tealD) +
    sheen(4.5,9.6,11,C.tealL) +
    pa("M8.6 12.4 a3.4 3.4 0 0 1 6.8 0 V13.6 H8.6 Z", C.tealD) +
    pa("M11.2 12.4 C11.2 9.2 13.4 10 13.4 6.6 L14.8 6.6 C14.8 10 11.2 9.2 11.2 12.4 Z", C.cream) +
    rr(5.6,16.6,7,2,0.5,C.white) + lines(6.5,17.2,4.4,C.tealD) };

  I.printerpaper = { label:"Printer Paper", cat:"Office", svg:
    rr(6.6,5.2,11,14.4,0.6,C.silverL,'0.6') + rr(6,6.2,11,14.4,0.6,C.cream) +
    pa("M5.4 7.2 H14 L18 11.2 V20 a0.8 0.8 0 0 1-0.8 0.8 H6.2 A0.8 0.8 0 0 1 5.4 20 Z", C.white) +
    pa("M14 7.2 L18 11.2 H14.8 a0.8 0.8 0 0 1-0.8-0.8 Z", C.silverL) +
    rr(7.6,13,8,0.85,0.4,C.blue,'0.7') + rr(7.6,15,8,0.85,0.4,C.silverD,'0.6') + rr(7.6,17,5,0.85,0.4,C.silverD,'0.6') +
    sheen(5.4,7.2,13,C.sheen) };

  /* ════════════ BATH ════════════ */
  const bottle = (bodyC, bodyD, capC, capD, content, topY=8.4, capH=2.4) => {
    const neckY = topY - 0.2;
    return (
      rr(10,(topY-capH-1.4).toFixed(2),4,capH,0.5,capC) + rr(12,(topY-capH-1.4).toFixed(2),2,capH,0.5,capD) +
      rr(10.8,(topY-1.6).toFixed(2),2.4,1.6,0.2,capD) +
      pa(`M7.6 ${topY+1.8} a2 2 0 0 1 1.4-1.9 L9.4 ${neckY} H14.6 L14.6 ${(topY-0.1).toFixed(2)} a2 2 0 0 1 1.8 2 V20 a1 1 0 0 1-1 1 H8.6 a1 1 0 0 1-1-1 Z`, bodyC) +
      pa(`M12 ${neckY} H14.6 L14.6 ${(topY-0.1).toFixed(2)} a2 2 0 0 1 1.8 2 V20 a1 1 0 0 1-1 1 H12 Z`, bodyD) +
      sheen(8,topY,21-topY,C.sheen) +
      rr(9.2,12.4,5.6,6,0.8,C.white) + content
    );
  };
  I.shampoo     = { label:"Shampoo",     cat:"Bath", svg: bottle(C.teal,   C.tealD,   C.cap, C.capD, drop(12,13.4,1.05,C.teal)) };
  I.conditioner = { label:"Conditioner", cat:"Bath", svg: bottle(C.violet, C.violetD, C.cap, C.capD, drop(12,13.4,1.05,C.violet)) };
  I.bodywash    = { label:"Body Wash",   cat:"Bath", svg: bottle(C.blue,   C.blueD,   C.cap, C.capD, drop(12,13.4,1.05,C.blue)) };

  I.handsoap = { label:"Hand Soap", cat:"Bath", svg:
    pa("M8.4 4.2 H12.6 V5.8 H10.6 V7.2 H8.4 Z", C.slate) + rr(10.4,6.2,5,1.6,0.4,C.slateD) +
    pa("M7 9.8 a2 2 0 0 1 2-2 H15 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H8 a1 1 0 0 1-1-1 Z", C.pink) +
    pa("M12 7.8 H15 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H12 Z", C.pinkD) +
    sheen(7,9.8,11,C.sheen) +
    rr(8.8,12.2,6.4,6,0.8,C.white) +
    ci(11,15,1.1,C.pink)+ci(13.3,13.9,0.8,C.pink)+ci(13,16.4,0.7,C.pink) };

  I.toothpaste = { label:"Toothpaste", cat:"Bath", svg:
    rr(7.6,3.6,8.8,1.9,0.3,C.silver) + rr(12,3.6,4.4,1.9,0.3,C.silverD) +
    rr(8.6,3.9,0.5,1.3,0.2,C.slateD,'0.6')+rr(10.4,3.9,0.5,1.3,0.2,C.slateD,'0.6')+rr(12.2,3.9,0.5,1.3,0.2,C.slateD,'0.6')+rr(14,3.9,0.5,1.3,0.2,C.slateD,'0.6') +
    pa("M8 5.5 H16 L13.9 16.5 H10.1 Z", C.white) +
    pa("M12 5.5 H16 L13.9 16.5 H12 Z", C.cream) +
    rr(10.5,16.4,3,1.5,0.2,C.capD) +
    rr(10.2,17.7,3.6,2.4,0.5,C.blue) + rr(12,17.7,1.8,2.4,0.5,C.blueD) +
    pa("M8.5 7.6 H15.5 L15.1 9.8 H8.9 Z", C.teal) + pa("M8.9 9.8 H15.1 L14.8 11.4 H9.2 Z", C.red) +
    sheen(8.4,5.5,11,C.sheen) };

  /* ════════════ CLEANING ════════════ */
  I.laundry = { label:"Laundry Detergent", cat:"Cleaning", svg:
    rr(11.6,3.8,4.6,2.2,0.5,C.blue) +
    pa("M6 7 H16 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H7 a1 1 0 0 1-1-1 Z", C.amber) +
    pa("M12 7 H16 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H12 Z", C.amberD) +
    pa("M3.6 9.6 H6 V13.8 H3.6 a1 1 0 0 1-1-1 V10.6 a1 1 0 0 1 1-1 Z", C.amberD) +
    sheen(6,7,14,C.sheen) +
    rr(7.6,11.4,7,6.4,0.8,C.white) + drop(11,13.2,1.15,C.blue) + rr(8.6,16.6,5,0.85,0.4,C.amberD,'0.6') };

  I.detergent = { label:"Detergent", cat:"Cleaning", svg:
    rr(5,5.4,14,15.2,1,C.blue) + rr(12,5.4,7,15.2,1,C.blueD) +
    sheen(5,5.4,15.2,C.blueL) +
    rr(5,5.4,14,3,1,C.blueD) + rr(12,5.4,7,3,1,C.blueL,'0.25') +
    rr(7,9.4,10,8.8,0.8,C.white) +
    pa("M9.4 11 H14.6 L13.6 16.4 a1 1 0 0 1-1 .8 H11.4 a1 1 0 0 1-1-.8 Z", C.blue) +
    rr(8.2,17,7.6,0.85,0.4,C.blueD,'0.55') };

  I.dishwasher_det = { label:"Dishwasher Detergent", cat:"Cleaning", svg:
    rr(6,5.2,12,2.8,0.6,C.teal) +
    rr(6,7.6,12,13,1,C.tealL,'0.35') + rr(6,7.6,12,13,1,C.white) + rr(13,7.6,5,13,1,C.cream) +
    rr(6,7.6,12,2.6,1,C.teal) + rr(13,7.6,5,2.6,1,C.tealD) +
    pa("M12 11.4 a3 3 0 0 1 3 3 H9 a3 3 0 0 1 3-3 Z", C.blue) +
    pa("M12 17.4 a3 3 0 0 1-3-3 H15 a3 3 0 0 1-3 3 Z", C.pink) +
    ci(12,14.4,1.1,C.white) +
    sheen(6,7.6,13,C.sheen) };

  I.bottlesoap = { label:"Bottle-Washer Soap", cat:"Cleaning", svg:
    pa("M15.4 2.8 L17.6 5 L12.8 9.8 L10.6 7.6 Z", C.kraft) + pa("M16.5 3.9 L17.6 5 L12.8 9.8 L11.7 8.7 Z", C.kraftD) +
    pa("M11 7 L13.4 9.4 L11.8 11 a1.7 1.7 0 0 1-2.4-2.4 Z", C.silver) +
    pa("M4.2 11.2 a2 2 0 0 1 2-2 H9.8 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H5.2 a1 1 0 0 1-1-1 Z", C.green) +
    pa("M8 9.2 H9.8 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H8 Z", C.greenD) +
    sheen(4.2,11.2,9.8,C.sheen) +
    rr(5.6,13,4.8,5.4,0.7,C.white) + drop(8,14.4,0.95,C.green) +
    rr(6.2,7.2,3.6,2.2,0.5,C.greenD) };

  const sprayer = (bodyC, bodyD, content) =>
    pa("M3.6 4 H10.6 V6.2 H5.8 L3.6 7.4 Z", C.ink) +              // nozzle barrel
    pa("M9.4 4 H12.8 V9.8 H9.4 Z", C.ink) +                        // neck/trigger housing
    pa("M5.8 6.2 H9.4 V9.2 L5.8 10.2 Z", C.inkSoft) +             // trigger
    pa("M7 9.6 H15 a1.6 1.6 0 0 1 1.6 1.6 V20 a1 1 0 0 1-1 1 H6.4 a1 1 0 0 1-1-1 V11.2 A1.6 1.6 0 0 1 7 9.6 Z", bodyC) +
    pa("M12 9.6 H15 a1.6 1.6 0 0 1 1.6 1.6 V20 a1 1 0 0 1-1 1 H12 Z", bodyD) +
    sheen(6.4,9.6,11.4,C.sheen) +
    rr(7.4,12.4,7.2,6,0.8,C.white) + content;

  I.glasscleaner = { label:"Glass Cleaner",       cat:"Cleaning", svg: sprayer(C.blue,   C.blueD,   star4(11,15.4,2.2,C.blue)) };
  I.allpurpose   = { label:"All-Purpose Cleaner", cat:"Cleaning", svg: sprayer(C.violet, C.violetD, ci(9.8,15.2,1.3,C.violet)+ci(12.4,14,0.95,C.violet)+ci(12.2,16.7,0.8,C.violet)) };
  I.dawn         = { label:"Dawn Power Wash",     cat:"Cleaning", svg: sprayer(C.blue,   C.blueD,   drop(11,13.4,1.2,C.blue)) };
  I.nontoxic     = { label:"Non-Toxic Cleaner",   cat:"Cleaning", svg: sprayer(C.green,  C.greenD,  leaf(11,13.4,1.25,C.green)+pa("M11 13.4 C10.7 15 10.7 16.6 11.2 18.2",C.greenD,'0')) };

  I.childwipes = { label:"Child Cleaning Wipes", cat:"Cleaning", svg:
    pa("M11 13.2 C11 9.6 13.6 10.4 13.6 6.8 L15.4 6.8 C15.4 11 11 10 11 13.2 Z", C.white) +
    pa("M3.6 10.4 H20.4 V19.4 a1.5 1.5 0 0 1-1.5 1.5 H5.1 A1.5 1.5 0 0 1 3.6 19.4 Z", C.pink) +
    pa("M12 10.4 H20.4 V19.4 a1.5 1.5 0 0 1-1.5 1.5 H12 Z", C.pinkD) +
    sheen(3.6,10.4,9,C.sheen) +
    rr(5,7.4,14,3,0.8,C.pinkD) + rr(5,7.4,14,3,0.8,C.pinkL,'0.2') +
    pa("M8.6 12.6 a3.4 3.4 0 0 1 6.8 0 V13.6 H8.6 Z", C.pinkD) +
    pa("M11.2 12.6 C11.2 9.4 13.6 10.2 13.6 6.8 L15 6.8 C15 10.2 11.2 9.4 11.2 12.6 Z", C.cream) +
    rr(7,14.8,10,2,0.5,C.white) + lines(8,15.4,5,C.pinkD) };

  I.swiffer_wet = { label:"Swiffer Wet Jet Wipes", cat:"Cleaning", svg:
    rr(3.4,8.6,17.2,6,1.2,C.blue) + rr(12,8.6,8.6,6,1.2,C.blueD) +
    rr(4.8,10.2,14.4,2.8,0.6,C.white) + lines(6,11,5,C.blueD) +
    sheen(3.4,8.6,6,C.sheen) +
    drop(8,16,0.95,C.blueL)+drop(12,16.6,0.95,C.blue)+drop(16,16,0.95,C.blueL) };

  I.swiffer_dust = { label:"Swiffer Duster Wipes", cat:"Cleaning", svg:
    rr(11.1,11,1.8,10,0.6,C.slate) +
    pa("M12 3.4 C13 4.9 14.7 4.9 16 4.2 C15.6 5.9 16.7 6.8 18.3 6.8 C17 7.9 17.2 9.4 18.3 10.5 C16.6 10.5 15.7 11.8 15.7 13.3 C14.4 12.2 12.9 12.7 12 13.9 C11.1 12.7 9.6 12.2 8.3 13.3 C8.3 11.8 7.4 10.5 5.7 10.5 C6.8 9.4 7 7.9 5.7 6.8 C7.3 6.8 8.4 5.9 8 4.2 C9.3 4.9 11 4.9 12 3.4 Z", C.violetL) +
    pa("M12 3.4 C13 4.9 14.7 4.9 16 4.2 C15.6 5.9 16.7 6.8 18.3 6.8 C17 7.9 17.2 9.4 18.3 10.5 C16.6 10.5 15.7 11.8 15.7 13.3 C14.4 12.2 12.9 12.7 12 13.9 Z", C.violet) +
    ci(12,8.4,2.2,C.violetD) };

  I.toiletpucks = { label:"Toilet Wand Pucks", cat:"Cleaning", svg:
    rr(11.2,2.8,1.8,9,0.6,C.slate) + rr(12.1,2.8,0.9,9,0.6,C.slateD) +
    pa("M6.4 11.4 H17.6 L16.4 18.9 a1.2 1.2 0 0 1-1.18 1 H8.76 a1.2 1.2 0 0 1-1.18-1 Z", C.teal) +
    pa("M12 11.4 H17.6 L16.4 18.9 a1.2 1.2 0 0 1-1.18 1 H12 Z", C.tealD) +
    rr(6.4,11.2,11.2,1.6,0.4,C.white) +
    ci(9.6,15.4,1.3,C.tealL) + ci(13.4,16.2,1.1,C.tealL) + ci(14.4,14,0.9,C.tealL) +
    sheen(7,12.6,7,C.sheen) };

  I.trashbag_bath = { label:"Bathroom Trash Bags", cat:"Cleaning", svg:
    pa("M9.6 6.6 L8 3.6 L9.7 3 L10.9 6.1 Z", C.slate) + pa("M14.4 6.6 L16 3.6 L14.3 3 L13.1 6.1 Z", C.slate) +
    pa("M7.8 8.6 C7.8 7 9.6 6.4 12 6.4 C14.4 6.4 16.2 7 16.2 8.6 L17.6 20 a1 1 0 0 1-1 1.1 H7.4 a1 1 0 0 1-1-1.1 Z", C.slateL) +
    pa("M12 6.4 C14.4 6.4 16.2 7 16.2 8.6 L17.6 20 a1 1 0 0 1-1 1.1 H12 Z", C.slate) +
    sheen(7.4,8.4,12.6,C.sheen) +
    rr(8,9,8,1.4,0.5,C.teal,'0.65') };

  /* ════════════ PHARMACY ════════════ */
  I.probiotic = { label:"Probiotic Drops", cat:"Pharmacy", svg:
    rr(10.4,2.8,3.2,2.4,0.4,C.slate) +
    pa("M11.4 5.2 H12.6 V14 a.6 .6 0 0 1-1.2 0 Z", C.slate) +
    drop(12,13.6,1.4,C.amberL) +
    pa("M7.6 9.4 H16.4 V20 a1 1 0 0 1-1 1 H8.6 a1 1 0 0 1-1-1 Z", C.amber) +
    pa("M12 9.4 H16.4 V20 a1 1 0 0 1-1 1 H12 Z", C.amberD) +
    rr(7.6,9.2,8.8,1.6,0.3,C.amberD) +
    sheen(7.6,9.4,11.6,C.sheen) +
    rr(9,12.4,6,6,0.7,C.white) + drop(12,13.6,1.0,C.amber) };

  I.sunscreen = { label:"Sunscreen", cat:"Pharmacy", svg:
    rr(9.4,3.4,5.2,2.4,0.6,C.orange) +
    pa("M7.4 5.8 H16.6 V20 a1 1 0 0 1-1 1 H8.4 a1 1 0 0 1-1-1 Z", C.amber) +
    pa("M12 5.8 H16.6 V20 a1 1 0 0 1-1 1 H12 Z", C.amberD) +
    sheen(7.4,5.8,15,C.sheen) +
    rr(9,9.4,6,8.4,0.8,C.white) +
    ci(12,12.6,2,C.orange) +
    pa("M12 9.4 L11.4 10.7 H12.6 Z M12 15.8 L11.4 14.5 H12.6 Z M8.8 12.6 L10.1 12 V13.2 Z M15.2 12.6 L13.9 12 V13.2 Z", C.orange) +
    rr(9.6,16,4.8,0.85,0.4,C.amberD,'0.5') };

  I.bugspray = { label:"Bug Spray", cat:"Pharmacy", svg:
    rr(9,4.4,3.4,1.8,0.3,C.slate) + rr(12.2,3.4,2.8,3.2,0.4,C.slateD) +
    pa("M7 8.6 a2 2 0 0 1 2-2 H11 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H8 a1 1 0 0 1-1-1 Z", C.green) +
    pa("M10 6.6 H11 a2 2 0 0 1 2 2 V20 a1 1 0 0 1-1 1 H10 Z", C.greenD) +
    sheen(7,8.6,12.4,C.sheen) +
    rr(7.6,11,4.8,7,0.7,C.white) + ci(10,14.2,1.6,C.green) +
    ci(15.6,5.8,1,C.greenL)+ci(18.2,4.2,0.8,C.green)+ci(18,8,0.8,C.greenL)+ci(20.2,6.2,0.6,C.green) };

  const pillBottle = (capC, bodyC, bodyD, content) =>
    rr(8.4,3.8,7.2,2.8,0.4,capC) + rr(12,3.8,3.6,2.8,0.4,C.capD) +
    pa("M8 6.4 H16 V20 a1 1 0 0 1-1 1 H9 a1 1 0 0 1-1-1 Z", bodyC) +
    pa("M12 6.4 H16 V20 a1 1 0 0 1-1 1 H12 Z", bodyD) +
    sheen(8,6.4,14.6,C.sheen) +
    rr(9.2,9,5.6,8.4,0.6,C.white) + content;
  I.tylenol = { label:"Tylenol", cat:"Pharmacy", svg: pillBottle(C.cap, C.red, C.redD,
    pa("M11.2 10.4 H12.8 V12 H14.4 V13.6 H12.8 V15.2 H11.2 V13.6 H9.6 V12 H11.2 Z", C.red) + rr(9.8,16,4.4,0.8,0.4,C.redD,'0.5')) };
  I.motrin = { label:"Motrin", cat:"Pharmacy", svg: pillBottle(C.cap, C.blue, C.blueD,
    ci(12,12.4,2,C.blue) + rr(10,15.4,4,0.9,0.4,C.blue,'0.85') + rr(10.4,16.8,3.2,0.8,0.4,C.blueD,'0.5')) };

  I.zyrtec = { label:"Zyrtec", cat:"Pharmacy", svg:
    rr(4.6,6.2,14.8,12.6,1,C.silverL) + rr(12,6.2,7.4,12.6,1,C.silver) +
    rr(4.6,6.2,14.8,12.6,1,C.silverD,'0') +
    ci(8.4,10,1.7,C.green) + ci(15.4,10,1.7,C.green) + ci(8.4,14.8,1.7,C.green) + ci(15.4,14.8,1.7,C.green) +
    ci(8.4,10,1.7,C.greenL,'0') +
    rr(11.5,6.2,1,12.6,0,C.silverD,'0.5') + rr(4.6,12,14.8,0.8,0,C.silverD,'0.4') +
    sheen(4.6,6.2,12.6,C.sheen) };

  /* ════════════ CAREGIVING ════════════ */
  I.diaper = { label:"Diapers", cat:"Caregiving", svg:
    pa("M3.6 7.2 H20.4 V9.6 C20.4 15.6 16.5 19.6 12 19.6 C7.5 19.6 3.6 15.6 3.6 9.6 Z", C.white) +
    pa("M12 7.2 H20.4 V9.6 C20.4 15.6 16.5 19.6 12 19.6 Z", C.cream) +
    pa("M3.6 7.2 H20.4 V9.4 H3.6 Z", C.blue) +
    pa("M6.4 12 a 5.6 5.6 0 0 0 11.2 0 Z", C.skyL,'0.55') +
    rr(4.6,5.2,4,2,0.4,C.blueL) + rr(15.4,5.2,4,2,0.4,C.blueL) +
    ci(9.6,11.2,0.7,C.blue,'0.5')+ci(14.4,11.2,0.7,C.blue,'0.5')+ci(12,12.6,0.7,C.blue,'0.5') +
    sheen(5,7.2,4,C.sheen) };

  I.diaper_night = { label:"Night Diapers", cat:"Caregiving", svg:
    pa("M3.6 7.2 H20.4 V9.6 C20.4 15.6 16.5 19.6 12 19.6 C7.5 19.6 3.6 15.6 3.6 9.6 Z", C.white) +
    pa("M12 7.2 H20.4 V9.6 C20.4 15.6 16.5 19.6 12 19.6 Z", C.cream) +
    pa("M3.6 7.2 H20.4 V9.4 H3.6 Z", C.violet) +
    rr(4.6,5.2,4,2,0.4,C.violetL) + rr(15.4,5.2,4,2,0.4,C.violetL) +
    pa("M12.4 10.4 a3.4 3.4 0 1 0 3.1 4.8 a4 4 0 0 1-3.1-4.8 Z", C.violet) +
    ci(8.4,12,0.7,C.amber)+ci(9.8,14.4,0.55,C.amber)+ci(7.4,14.6,0.45,C.amber) +
    sheen(5,7.2,4,C.sheen) };

  /* ════════════ extras the app data references ════════════ */
  I.cream = { label:"Diaper Cream", cat:"Caregiving", svg:
    rr(10.4,3.4,3.2,2.4,0.4,C.pinkD) + rr(12,3.4,1.6,2.4,0.4,C.pink) +
    pa("M9.4 8 H14.6 L16.4 19.6 a1.2 1.2 0 0 1-1.19 1.4 H8.79 a1.2 1.2 0 0 1-1.19-1.4 Z", C.white) +
    pa("M12 8 H14.6 L16.4 19.6 a1.2 1.2 0 0 1-1.19 1.4 H12 Z", C.cream) +
    rr(9.2,5.8,5.6,2.2,0.4,C.pink) +
    rr(10,11.4,4,4.6,0.6,C.pinkL,'0.45') +
    pa("M12 11.4 V16 M10 13.7 H14", C.pink,'0') +
    ci(12,13.7,1.3,C.pink) +
    sheen(7.6,8,12.4,C.sheen) };

  I.cradlecap = { label:"Cradle Cap Care", cat:"Bath", svg:
    rr(9.8,3.4,4.4,2.2,0.5,C.amber) +
    pa("M7.6 5.6 H16.4 V20 a1 1 0 0 1-1 1 H8.6 a1 1 0 0 1-1-1 Z", C.tealL) +
    pa("M12 5.6 H16.4 V20 a1 1 0 0 1-1 1 H12 Z", C.teal) +
    sheen(7.6,5.6,15,C.sheen) +
    rr(9,9,6,8.4,0.7,C.white) +
    ci(12,12.4,1.9,C.amber) + pa("M12 9.6 L11.4 10.9 H12.6 Z M8.9 12.4 L10.2 11.8 V13 Z M15.1 12.4 L13.8 11.8 V13 Z", C.amber) +
    rr(9.8,15.8,4.4,0.85,0.4,C.tealD,'0.5') };

  I.compostbag = { label:"Compost Liners", cat:"Cleaning", svg:
    pa("M9.6 6.6 L8 3.6 L9.7 3 L10.9 6.1 Z", C.greenD) + pa("M14.4 6.6 L16 3.6 L14.3 3 L13.1 6.1 Z", C.greenD) +
    pa("M7.8 8.6 C7.8 7 9.6 6.4 12 6.4 C14.4 6.4 16.2 7 16.2 8.6 L17.6 20 a1 1 0 0 1-1 1.1 H7.4 a1 1 0 0 1-1-1.1 Z", C.greenL) +
    pa("M12 6.4 C14.4 6.4 16.2 7 16.2 8.6 L17.6 20 a1 1 0 0 1-1 1.1 H12 Z", C.green) +
    sheen(7.4,8.4,12.6,C.sheen) +
    leaf(11.2,11.4,1.5,C.greenD) + pa("M11.2 11.4 C10.8 13.4 10.8 15.4 11.5 17.4", C.greenD,'0') };

  I.waterfilter = { label:"Water Filter", cat:"Kitchen", svg:
    rr(7.6,3.6,8.8,2.4,0.6,C.blue) +
    pa("M8 6 H16 V18.4 a2.6 2.6 0 0 1-2.6 2.6 H10.6 A2.6 2.6 0 0 1 8 18.4 Z", C.skyL) +
    pa("M12 6 H16 V18.4 a2.6 2.6 0 0 1-2.6 2.6 H12 Z", C.sky) +
    rr(8,6,8,1.4,0,C.blueD) +
    sheen(8,6,15,C.sheen) +
    rr(8,9.4,8,2,0,C.white,'0.75') + rr(8,12.4,8,2,0,C.white,'0.55') +
    drop(12,12,1.25,C.blue) };

  I.generic = { label:"Supply", cat:"Office", svg:
    rr(5,6,14,14,1,C.slate) + rr(12,6,7,14,1,C.slateD) +
    sheen(5,6,14,C.slateL) +
    rr(5,6,14,2.6,1,C.slateD) +
    rr(7.4,10,9.2,6.4,0.7,C.white) + ci(12,13.2,1.9,C.slate) };

  window.RICH_ICONS = I;
  window.RICH_ORDER = Object.keys(I);
})();

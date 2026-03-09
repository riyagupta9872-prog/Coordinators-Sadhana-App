// ═══════════════════════════════════════════════════════════
// 1. FIREBASE SETUP
// ═══════════════════════════════════════════════════════════
const firebaseConfig = {
    apiKey: "AIzaSyCZdmZJckSWJo1tFT14NVKVurUGsoKrRy8",
    authDomain: "rapd--sadhana-tracker.firebaseapp.com",
    projectId: "rapd--sadhana-tracker",
    storageBucket: "rapd--sadhana-tracker.firebasestorage.app",
    messagingSenderId: "811405448950",
    appId: "1:811405448950:web:8b711f3129e4bdf06dbed7"
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();
db.settings({ experimentalAutoDetectLongPolling: true, merge: true });

let currentUser    = null;
let userProfile    = null;
let activeListener = null;

// ═══════════════════════════════════════════════════════════
// 2. ROLE HELPERS
// ═══════════════════════════════════════════════════════════
const isSuperAdmin    = () => userProfile?.role === 'superAdmin';
const isDeptAdmin     = () => userProfile?.role === 'deptAdmin';
const isTeamLeader    = () => userProfile?.role === 'teamLeader';
const isAnyAdmin      = () => isSuperAdmin() || isDeptAdmin() || isTeamLeader();

// Teams per department
const DEPT_TEAMS = {
    'IGF':      ['Lalita','Visakha','Chitralekha','Champakalata','Tungavidya','Indulekha','Rangadevi','Sudevi','Other','Overall'],
    'IYF':      ['Anant','Govind','Madhav','Keshav','Overall'],
    'ICF_MTG':  ['Rohini','Rukmini','Kalindi','Satyabhama','Jamvanti','Lakshmana','Kaushal','Bhadra','Other','Overall'],
    'ICF_PRJI': ['Vasudev','Sankarshan','Anirudha','Pradyuman','Overall']
};

// Populate team dropdown based on dept
window.populateDeptTeams = (selectId, dept, selected = '') => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="" disabled selected>Select team</option>';
    if (dept && DEPT_TEAMS[dept]) {
        DEPT_TEAMS[dept].forEach(t => {
            const o = document.createElement('option');
            o.value = t; o.textContent = t;
            if (t === selected) o.selected = true;
            sel.appendChild(o);
        });
    }
};

// What users this admin can see
function getAdminScope() {
    if (isSuperAdmin()) return { type: 'all' };
    if (isDeptAdmin())  return { type: 'dept', dept: userProfile.department };
    if (isTeamLeader()) return { type: 'team', dept: userProfile.department, team: userProfile.team };
    return { type: 'self' };
}

// Filter users by scope
function matchesScope(uData) {
    const scope = getAdminScope();
    if (scope.type === 'all')  return true;
    if (scope.type === 'dept') return uData.department === scope.dept;
    if (scope.type === 'team') return uData.team === scope.team;
    return false;
}

// For backward compatibility — level categories visible
const visibleCategories = () => {
    if (isSuperAdmin()) return ['Level-1','Level-2','Level-3','Level-4'];
    if (isDeptAdmin() || isTeamLeader()) return ['Level-1','Level-2','Level-3','Level-4'];
    return [];
};

// ═══════════════════════════════════════════════════════════
// 3. HELPERS
// ═══════════════════════════════════════════════════════════
const t2m = (t, isSleep = false) => {
    if (!t || t === 'NR') return 9999;
    let [h, m] = t.split(':').map(Number);
    if (isSleep && h >= 0 && h <= 3) h += 24;
    return h * 60 + m;
};

function getWeekInfo(dateStr) {
    const d   = new Date(dateStr);
    const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    const fmt = dt => `${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleString('en-GB',{month:'short'})}`;
    return { sunStr: sun.toISOString().split('T')[0], label: `${fmt(sun)} to ${fmt(sat)}_${sun.getFullYear()}` };
}

function localDateStr(offsetDays = 0) {
    const d = new Date(); d.setDate(d.getDate() - offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getNRData(date) {
    return {
        id: date, totalScore: -30, dayPercent: -19,
        sleepTime:'NR', wakeupTime:'NR', chantingTime:'NR',
        readingMinutes:0, hearingMinutes:0, serviceMinutes:0, notesMinutes:0, daySleepMinutes:0,
        scores:{ sleep:-5, wakeup:-5, chanting:-5, reading:-5, hearing:-5, service:-5, notes:-5, daySleep:0 }
    };
}

function isPastDate(dateStr) {
    return dateStr < localDateStr(0);
}

// ─── INSTRUMENT OPTIONS per level ────────────────────────
const INSTRUMENTS_L12 = ['Whomper','Kartal','Drum','Mridanga','Harmonium'];
const INSTRUMENTS_L34 = ['Whomper','Kartal','Drum','Mridanga','Harmonium',
                         'Instrument Learning','Data Management','Management','AI','Kirtan'];

function getInstrumentOptions(level) {
    return (level === 'Level-3' || level === 'Level-4') ? INSTRUMENTS_L34 : INSTRUMENTS_L12;
}

// Populate instrument dropdown in profile based on level
window.populateInstrumentOptions = (level) => {
    const sel = document.getElementById('profile-instrument');
    if (!sel) return;
    const opts = getInstrumentOptions(level);
    sel.innerHTML = '<option value="" disabled selected>Select your instrument / activity</option>';
    opts.forEach(o => {
        const el = document.createElement('option');
        el.value = o; el.textContent = o;
        sel.appendChild(el);
    });
};

// ─── SCORING ENGINE — LEVEL-1 (independent) ──────────────
// Daily max: 105 | Weekly: 735 + 25 service = 760
function calcScoreL1(slp, wak, chn, pat, hear, ds, inst) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1380?25:slpM<=1385?20:slpM<=1390?15:slpM<=1395?10:slpM<=1400?5:slpM<=1405?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=360?25:wakM<=365?20:wakM<=370?15:wakM<=375?10:wakM<=380?5:wakM<=385?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=90?10:-5;
    const actS = (m) => m>=20?20:m>=15?15:m>=10?10:m>=5?5:m>=1?-5:-5;
    const patS  = Math.max(0, actS(pat));
    const hearS = Math.max(0, actS(hear));
    const reading = patS; const hearing = hearS;
    const bestOf  = Math.max(patS, hearS);
    // Instrument bonus: 20+=5, 15-19=3, 10-14=1, else 0
    const instrumentBonus = inst>=20?5:inst>=15?3:inst>=10?1:0;
    const total = sleep + wakeup + chanting + daySleep + bestOf;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument:0 },
             total, instrumentBonus, bestIs: patS>=hearS?'pathan':'hearing',
             dayPercent: Math.round((total/105)*100) };
}

// ─── SCORING ENGINE — LEVEL-2 (independent) ──────────────
// Daily max: 110 | Weekly: 770 + 25 service = 795
function calcScoreL2(slp, wak, chn, pat, hear, ds, inst) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1380?25:slpM<=1385?20:slpM<=1390?15:slpM<=1395?10:slpM<=1400?5:slpM<=1405?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=360?25:wakM<=365?20:wakM<=370?15:wakM<=375?10:wakM<=380?5:wakM<=385?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=90?10:-5;
    const actS = (m) => m>=25?25:m>=20?20:m>=15?15:m>=10?10:m>=5?5:m>=1?-5:-5;
    const patS  = Math.max(0, actS(pat));
    const hearS = Math.max(0, actS(hear));
    const reading = patS; const hearing = hearS;
    const bestOf  = Math.max(patS, hearS);
    // Instrument bonus: 20+=5, 15-19=3, 10-14=1, else 0
    const instrumentBonus = inst>=20?5:inst>=15?3:inst>=10?1:0;
    const total = sleep + wakeup + chanting + daySleep + bestOf;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument:0 },
             total, instrumentBonus, bestIs: patS>=hearS?'pathan':'hearing',
             dayPercent: Math.round((total/110)*100) };
}

// ─── SCORING ENGINE — LEVEL-3 (independent) ──────────────
// Daily max: 115 | Weekly: 805 + 25 service = 830
function calcScoreL3(slp, wak, chn, pat, hear, ds, inst) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1350?25:slpM<=1355?20:slpM<=1360?15:slpM<=1365?10:slpM<=1370?5:slpM<=1375?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=330?25:wakM<=335?20:wakM<=340?15:wakM<=345?10:wakM<=350?5:wakM<=355?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=60?10:-5;
    const actS = (m) => m>=30?25:m>=25?20:m>=20?15:m>=15?10:m>=10?5:m>=5?0:-5;
    const patS  = Math.max(0, actS(pat));
    const hearS = Math.max(0, actS(hear));
    const reading = patS; const hearing = hearS;
    const bestOf  = Math.max(patS, hearS);
    // Instrument compulsory: 20+=5, 15-19=3, 10-14=3, else 0
    const instrument = inst>=20?5:inst>=15?3:inst>=10?3:0;
    const total = sleep + wakeup + chanting + daySleep + bestOf + instrument;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument },
             total, instrumentBonus: 0, bestIs: patS>=hearS?'pathan':'hearing',
             dayPercent: Math.round((total/115)*100) };
}

// ─── SCORING ENGINE — LEVEL-4 (independent) ──────────────
// Daily max: 140 | Weekly: 980 + 25 service = 1005
function calcScoreL4(slp, wak, chn, pat, hear, ds, inst, notes) {
    const slpM = t2m(slp, true);
    const sleep   = slpM<=1350?25:slpM<=1355?20:slpM<=1360?15:slpM<=1365?10:slpM<=1370?5:slpM<=1375?0:-5;
    const wakM = t2m(wak);
    const wakeup  = wakM<=305?25:wakM<=310?20:wakM<=315?15:wakM<=320?10:wakM<=325?5:wakM<=330?0:-5;
    const chnM = t2m(chn);
    const chanting= chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    const daySleep= ds<=60?10:-5;
    const actS = (m) => m>=30?25:m>=25?20:m>=20?15:m>=15?10:m>=10?5:m>=5?0:-5;
    const reading = actS(pat);
    const hearing = actS(hear);
    // Instrument compulsory: 20+=5, 15-19=3, 10-14=3, else 0
    const instrument = inst>=20?5:inst>=15?3:inst>=10?3:0;
    // Notes revision bonus: 20+=20, 15-19=15, 10-14=10, 5-9=5, else 0
    const notesBonus = notes>=20?20:notes>=15?15:notes>=10?10:notes>=5?5:0;
    const total = sleep + wakeup + chanting + daySleep + reading + hearing + instrument;
    return { sc:{ sleep, wakeup, chanting, daySleep, reading, hearing, service:0, notes:0, instrument },
             total, instrumentBonus: 0, notesBonus, bestIs: null,
             dayPercent: Math.round((total/140)*100) };
}

// ─── SERVICE WEEKLY SCORE CALCULATOR ─────────────────────
function calcServiceWeekly(totalMins, level) {
    // L1: 60+=25, 50+=20, 40+=15, 30+=10, 20+=5, 10+=0, <10=-5
    if (level === 'Level-1') {
        return totalMins>=60?25:totalMins>=50?20:totalMins>=40?15:totalMins>=30?10:totalMins>=20?5:totalMins>=10?0:-5;
    }
    // L2/L3/L4: 90+=25, 80+=20, 70+=15, 60+=10, 50+=5, 40+=0, <40=-5
    return totalMins>=90?25:totalMins>=80?20:totalMins>=70?15:totalMins>=60?10:totalMins>=50?5:totalMins>=40?0:-5;
}

// ─── SUNDAY BONUS CALCULATOR ─────────────────────────────
function calcSundayBonus(dress1, dress2, tilak, mala, level) {
    // L1/L2: No=0, Yes=+5
    // L3/L4: No=-5, Yes=+5
    const noVal = (level==='Level-3'||level==='Level-4') ? -5 : 0;
    const v = (val) => val==='yes' ? 5 : noVal;
    return { dress1: v(dress1), dress2: v(dress2), tilak: v(tilak), mala: v(mala) };
}

// ─── MASTER calculateScores (for backward compat with edit modal) ──
function calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level) {
    let result;
    if      (level==='Level-1') result = calcScoreL1(slp,wak,chn,rMin,hMin,dsMin,0);
    else if (level==='Level-2') result = calcScoreL2(slp,wak,chn,rMin,hMin,dsMin,0);
    else if (level==='Level-3') result = calcScoreL3(slp,wak,chn,rMin,hMin,dsMin,0);
    else                        result = calcScoreL4(slp,wak,chn,rMin,hMin,dsMin,0,nMin);
    return { sc: result.sc, total: result.total, dayPercent: result.dayPercent };
}

// ─── DAILY MAX per level ──────────────────────────────────
function getDailyMax(level) {
    if (level==='Level-1') return 105;
    if (level==='Level-2') return 110;
    if (level==='Level-3') return 115;
    return 140;
}

// ═══════════════════════════════════════════════════════════
// 4. EXCEL DOWNLOAD  (with profile header + formatting)
// ═══════════════════════════════════════════════════════════
function xlsxSave(wb, filename) {
    try {
        XLSX.writeFile(wb, filename);
    } catch (e) {
        const arr  = XLSX.write(wb, { bookType:'xlsx', type:'array' });
        const blob = new Blob([arr], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2500);
    }
}

// Helper: set cell style (bold, fill, font color, alignment, border)
function styleCell(ws, cellRef, opts = {}) {
    if (!ws[cellRef]) ws[cellRef] = { v:'', t:'s' };
    ws[cellRef].s = {
        font:      { bold: opts.bold||false, color: opts.fontColor ? {rgb: opts.fontColor} : undefined, sz: opts.sz||11 },
        fill:      opts.fill ? { fgColor: {rgb: opts.fill}, patternType:'solid' } : undefined,
        alignment: { horizontal: opts.align||'center', vertical:'center', wrapText: false },
        border: {
            top:    { style:'thin', color:{rgb:'CCCCCC'} },
            bottom: { style:'thin', color:{rgb:'CCCCCC'} },
            left:   { style:'thin', color:{rgb:'CCCCCC'} },
            right:  { style:'thin', color:{rgb:'CCCCCC'} }
        }
    };
}

// XLSX column index → letter(s) (0=A, 25=Z, 26=AA, 27=AB …)
function colLetter(n) {
    let s = '';
    n++;
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

window.downloadUserExcel = async (userId, userName) => {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded. Please refresh.'); return; }
    try {
        // Fetch user profile
        const uDoc = await db.collection('users').doc(userId).get();
        const uData = uDoc.exists ? uDoc.data() : {};

        const snap = await db.collection('users').doc(userId).collection('sadhana').get();
        if (snap.empty) { alert('No sadhana data found for this user.'); return; }

        const level      = uData.level || 'Level-1';
        const instrument = uData.instrument || 'Instrument';
        const dept       = uData.department || '';
        const dress1Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Gopi Dress' : 'Dhoti';
        const dress2Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Blouse'     : 'Kurta';
        const isL34      = level==='Level-3'||level==='Level-4';
        const isL4       = level==='Level-4';

        const weeksData = {};
        snap.forEach(doc => {
            const wi = getWeekInfo(doc.id);
            if (!weeksData[wi.sunStr]) weeksData[wi.sunStr] = { label:wi.label, sunStr:wi.sunStr, days:{} };
            weeksData[wi.sunStr].days[doc.id] = doc.data();
        });

        const sortedWeeks = Object.keys(weeksData).sort((a,b) => b.localeCompare(a));
        const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        // Columns: Date,Bed,M,Wake,M,Chant,M,Pathan(m),M,Hearing(m),M,Instrument(m),M,Seva(m),Seva Notes,DaySleep(m),M,Bonus,Total,%
        // L4 extra: Notes(m)
        const COLS = isL4 ? 22 : 21;

        // ── PROFILE HEADER ────────────────────────────────
        const today = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
        const profileRows = [
            ['SADHANA TRACKER — INDIVIDUAL REPORT', ...Array(COLS-1).fill('')],
            ['', ...Array(COLS-1).fill('')],
            ['Name',           uData.name            || userName, ...Array(COLS-2).fill('')],
            ['Level',          level,                             ...Array(COLS-2).fill('')],
            ['Instrument',     instrument,                        ...Array(COLS-2).fill('')],
            ['Department',     dept,                              ...Array(COLS-2).fill('')],
            ['Team',           uData.team            || 'N/A',   ...Array(COLS-2).fill('')],
            ['Chanting Level', uData.chantingCategory|| 'N/A',   ...Array(COLS-2).fill('')],
            ['Exact Rounds',   uData.exactRounds     || 'N/A',   ...Array(COLS-2).fill('')],
            ['Downloaded On',  today,                             ...Array(COLS-2).fill('')],
            ['', ...Array(COLS-1).fill('')],
        ];

        const dataArray = [...profileRows];
        const PROFILE_ROWS = profileRows.length;
        const styleMap = {};

        sortedWeeks.forEach((sunStr, wi) => {
            const week  = weeksData[sunStr];
            const wRow  = dataArray.length;

            dataArray.push([`WEEK: ${week.label}`,...Array(COLS-1).fill('')]);
            styleMap[wRow] = 'weekHeader';

            const chRow = dataArray.length;
            // Headers
            const hdr = ['Date','Bed','M','Wake','M','Chant','M',
                         'Pathan(m)','M','Hearing(m)','M',
                         `${instrument}(m)`,'M',
                         'Seva(m)','Seva Notes','DaySleep(m)','M',
                         'Bonus','Total','%'];
            if (isL4) hdr.splice(17,0,'Notes(m)');
            dataArray.push(hdr);
            styleMap[chRow] = 'colHeader';

            let T = { sl:0,wu:0,ch:0,rd:0,hr:0,inst:0,ds:0, rdm:0,hrm:0,instm:0,svm:0,dsm:0,bonus:0,tot:0,ntm:0 };
            const wStart = new Date(week.sunStr);
            const weekEntries = [];

            for (let i = 0; i < 7; i++) {
                const cd  = new Date(wStart); cd.setDate(cd.getDate()+i);
                const ds  = cd.toISOString().split('T')[0];
                const lbl = `${DAY[i]} ${String(cd.getDate()).padStart(2,'0')}`;
                const e   = week.days[ds] || getNRData(ds);
                const dRow = dataArray.length;
                const bonus= e.bonusTotal||0;
                const svcS = e.scores?.instrument??0;

                T.sl  += e.scores?.sleep??0;   T.wu += e.scores?.wakeup??0;
                T.ch  += e.scores?.chanting??0; T.rd += e.scores?.reading??0;
                T.hr  += e.scores?.hearing??0;  T.inst+= e.scores?.instrument??0;
                T.ds  += e.scores?.daySleep??0;
                T.rdm += e.readingMinutes||0;   T.hrm += e.hearingMinutes||0;
                T.instm+= e.instrumentMinutes||0; T.svm += e.serviceMinutes||0;
                T.dsm += e.daySleepMinutes||0;  T.bonus+= bonus;
                T.tot += (e.totalScore??0)+bonus;
                T.ntm += e.notesMinutes||0;
                if (e.sleepTime && e.sleepTime!=='NR') weekEntries.push({id:ds,sleepTime:e.sleepTime});

                const row = [
                    lbl,
                    e.sleepTime||'NR',    e.scores?.sleep??0,
                    e.wakeupTime||'NR',   e.scores?.wakeup??0,
                    e.chantingTime||'NR', e.scores?.chanting??0,
                    e.readingMinutes||0,  e.scores?.reading??0,
                    e.hearingMinutes||0,  e.scores?.hearing??0,
                    e.instrumentMinutes||0, e.scores?.instrument??0,
                    e.serviceMinutes||0,  e.serviceText||'',
                    e.daySleepMinutes||0, e.scores?.daySleep??0,
                    bonus,
                    (e.totalScore??0)+bonus, (e.dayPercent??0)+'%'
                ];
                if (isL4) row.splice(17,0,e.notesMinutes||0);
                dataArray.push(row);
                styleMap[dRow] = (e.sleepTime === 'NR') ? 'nr' : 'data';
            }

            // Weekly service pool row
            const svcScore = calcServiceWeekly(T.svm, level);
            const svcRow   = dataArray.length;
            dataArray.push([`Service Pool: ${T.svm} min → Score: ${svcScore>=0?'+':''}${svcScore}`,...Array(COLS-1).fill('')]);
            styleMap[svcRow] = 'summary';

            const fd  = fairDenominator(week.sunStr, weekEntries, level);
            const pct = Math.round(((T.tot+svcScore)/fd)*100);
            const totRow = dataArray.length;
            const totLine = ['WEEKLY TOTAL','',T.sl,'',T.wu,'',T.ch,T.rdm,T.rd,T.hrm,T.hr,T.instm,T.inst,T.svm,'',T.dsm,T.ds,T.bonus,T.tot+svcScore,pct+'%'];
            if (isL4) totLine.splice(17,0,T.ntm);
            dataArray.push(totLine);
            styleMap[totRow] = 'total';

            const sumRow = dataArray.length;
            dataArray.push([`WEEKLY %: ${T.tot+svcScore} / ${fd} = ${pct}%`,...Array(COLS-1).fill('')]);
            styleMap[sumRow] = 'summary';

            if (wi < sortedWeeks.length-1) {
                dataArray.push(Array(COLS).fill(''));
                dataArray.push(Array(COLS).fill(''));
            }
        });

        // ── BUILD WORKSHEET ───────────────────────────────
        const ws = XLSX.utils.aoa_to_sheet(dataArray);
        ws['!cols'] = [10,8,4,8,4,8,4,9,4,9,4,9,4,8,14,10,4,7,8,6].map(w=>({wch:w}));
        if (isL4) ws['!cols'].splice(17,0,{wch:8});

        // ── MERGES ────────────────────────────────────────
        const merges = [];
        // Profile title spans all columns
        merges.push({s:{r:0,c:0}, e:{r:0,c:COLS-1}});
        // Profile rows: label in col 0, value merged cols 1-18
        for (let r=2;r<=6;r++) merges.push({s:{r,c:1}, e:{r,c:COLS-1}});

        // Week & summary row merges
        Object.entries(styleMap).forEach(([rStr, type]) => {
            const r = parseInt(rStr);
            if (type==='weekHeader' || type==='summary') {
                merges.push({s:{r,c:0}, e:{r,c:COLS-1}});
            }
        });
        ws['!merges'] = merges;

        // ── CELL STYLES ───────────────────────────────────
        // Profile title
        styleCell(ws, 'A1', { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:13, align:'center' });

        // Profile label cells (col A, rows 3-7)
        for (let r=2;r<=6;r++) {
            styleCell(ws, `A${r+1}`, { bold:true, fill:'EBF3FB', align:'left' });
            styleCell(ws, `B${r+1}`, { align:'left' });
        }

        // Data rows styling
        Object.entries(styleMap).forEach(([rStr, type]) => {
            const r    = parseInt(rStr);
            const rNum = r + 1; // 1-indexed for cell refs

            if (type === 'weekHeader') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:12, align:'center' });
                }
            } else if (type === 'colHeader') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'2E86C1', fontColor:'FFFFFF', sz:10, align:'center' });
                }
            } else if (type === 'total') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'D5E8F7', align:'center' });
                }
            } else if (type === 'summary') {
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { bold:true, fill:'EBF3FB', fontColor:'1A3C5E', align:'center' });
                }
            } else if (type === 'nr') {
                // NR row — light red background
                for (let c=0;c<COLS;c++) {
                    const ref = `${colLetter(c)}${rNum}`;
                    styleCell(ws, ref, { fill:'FDE8E8', fontColor:'C0392B', align:'center' });
                }
                // Date col left aligned
                if (ws[`A${rNum}`]) ws[`A${rNum}`].s.alignment.horizontal = 'left';
            } else if (type === 'data') {
                // Date col
                styleCell(ws, `A${rNum}`, { align:'left' });
                // Score columns (M cols): C,E,G,I,K,M,O,Q = col indices 2,4,6,8,10,12,14,16
                const scoreCols = [2,4,6,8,10,12,14,16];
                for (let c=0;c<COLS;c++) {
                    const ref  = `${colLetter(c)}${rNum}`;
                    const cell = ws[ref];
                    if (!cell) continue;
                    if (scoreCols.includes(c) || c===17) {
                        // Score cell — conditional color
                        const val = typeof cell.v === 'number' ? cell.v : parseFloat(cell.v)||0;
                        const fill  = val >= 20 ? 'D5F5E3'   // green
                                    : val >= 10 ? 'FEF9E7'   // yellow
                                    : val >=  0 ? 'FAD7A0'   // orange
                                    :             'FADBD8';   // red
                        const fColor = val < 0 ? 'C0392B' : '1A252F';
                        styleCell(ws, ref, { fill, fontColor:fColor, align:'center' });
                    } else {
                        styleCell(ws, ref, { align:'center' });
                    }
                }
                // Total col (R=index 17) — bold
                const totRef = `R${rNum}`;
                if (ws[totRef]) ws[totRef].s.font.bold = true;
            }
        });

        // Freeze top 8 rows (profile) + column A
        ws['!freeze'] = { xSplit:1, ySplit:PROFILE_ROWS, topLeftCell:'B9' };

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sadhana_Weekly');
        xlsxSave(wb, `${userName.replace(/\s+/g,'_')}_Sadhana_Weekly.xlsx`);

    } catch (err) { console.error(err); alert('Download Failed: ' + err.message); }
};

window.downloadMasterReport = async () => {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded. Please refresh.'); return; }
    try {
        const usersSnap = await db.collection('users').get();
        const userData = [];
        const weekMap = new Map();

        for (const uDoc of usersSnap.docs) {
            const u = uDoc.data();
            if (!matchesScope(u)) continue;
            const sSnap = await uDoc.ref.collection('sadhana').get();
            const entries = sSnap.docs.map(d=>({date:d.id, score:d.data().totalScore||0}));
            entries.forEach(en => {
                const wi = getWeekInfo(en.date);
                weekMap.set(wi.sunStr, wi.label);
            });
            userData.push({ user:u, entries });
        }
        userData.sort((a,b)=>(a.user.name||'').localeCompare(b.user.name||''));

        // Sort weeks by sunStr descending (newest first) — YYYY-MM-DD sorts perfectly
        const allWeeks = Array.from(weekMap.entries())
            .sort((a,b) => b[0].localeCompare(a[0]))
            .map(([sunStr, label]) => ({ sunStr, label }));

        const rows = [['User Name','Level','Department','Team','Chanting Category',...allWeeks.map(w=>w.label.replace('_',' '))]];

        userData.forEach(({user,entries}) => {
            const row = [user.name, user.level||'Level-1', user.department||'-', user.team||'-', user.chantingCategory||'N/A'];
            allWeeks.forEach(({ sunStr }) => {
                let tot = 0; const masterWeekEnts = [];
                const wSun = new Date(sunStr);
                for (let i=0;i<7;i++) {
                    const c  = new Date(wSun); c.setDate(c.getDate()+i);
                    const ds = c.toISOString().split('T')[0];
                    const en = entries.find(e=>e.date===ds);
                    tot += en ? en.score : -30;
                    if(en) masterWeekEnts.push({id:ds,sleepTime:en.sleepTime||''});
                }
                const mfd = fairDenominator(wSun, masterWeekEnts);
                const pct = Math.round((tot/mfd)*100);
                row.push(pct < 0 ? `(${Math.abs(pct)}%)` : `${pct}%`);
            });
            rows.push(row);
        });

        const ws = XLSX.utils.aoa_to_sheet(rows);

        // Style header row
        const hCols = rows[0].length;
        for (let c = 0; c < hCols; c++) {
            const ref = `${colLetter(c)}1`;
            styleCell(ws, ref, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:11, align: c===0 ? 'left' : 'center' });
        }

        // Style data rows with matching colors
        for (let r = 1; r < rows.length; r++) {
            const stripeBg = r % 2 === 0 ? 'F8FAFC' : 'FFFFFF';
            // Name, level, chanting cols
            for (let c = 0; c < 3; c++) {
                const ref = `${colLetter(c)}${r+1}`;
                styleCell(ws, ref, { fill: stripeBg, align:'left', bold: c===0 });
            }
            // Week pct cols
            for (let c = 3; c < rows[r].length; c++) {
                const ref  = `${colLetter(c)}${r+1}`;
                const cell = ws[ref];
                if (!cell) continue;
                const raw  = parseInt(String(cell.v).replace('%','').replace('(','').replace(')','')) || 0;
                const isNeg = String(cell.v).includes('(');
                const pct  = isNeg ? -Math.abs(raw) : raw;
                let fill = stripeBg, fontColor = '1A252F'; let bold = false;
                if (pct < 0)   { fill = 'FFFDE7'; fontColor = 'B91C1C'; bold = true; }
                else if (pct < 20) { fill = 'FFFDE7'; fontColor = 'B91C1C'; bold = true; }
                else if (pct >= 70){ fontColor = '15803D'; bold = true; }
                styleCell(ws, ref, { fill, fontColor, bold, align:'center' });
            }
        }

        ws['!cols'] = [{ wch:22 }, { wch:16 }, { wch:12 }, ...Array(allWeeks.length).fill({ wch:18 })];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Master_Report');
        xlsxSave(wb, 'Master_Sadhana_Report.xlsx');

    } catch (err) { console.error(err); alert('Download Failed: ' + err.message); }
};

// ═══════════════════════════════════════════════════════════
// 5. AUTH
// ═══════════════════════════════════════════════════════════
let _profileUnsub = null;
auth.onAuthStateChanged((user) => {
    // Unsubscribe previous profile listener
    if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }

    if (user) {
        currentUser = user;
        let _dashboardInited = false;

        // Real-time profile listener — updates instantly when admin changes role
        _profileUnsub = db.collection('users').doc(user.uid).onSnapshot(docSnap => {
            if (!docSnap.exists) { showSection('profile'); return; }

            const prevLevel = userProfile ? userProfile.level : null;
            userProfile = docSnap.data();

            // Sirf name, department, team zaroori hain — level default Level-1 hoga
            if (!userProfile.name || !userProfile.department || !userProfile.team) {
                document.getElementById('profile-title').textContent    = 'Complete Your Profile';
                document.getElementById('profile-subtitle').textContent = 'Please fill in your details to continue';
                document.getElementById('profile-name').value           = userProfile.name || '';
                populateInstrumentOptions(userProfile.level || 'Level-1');
                showSection('profile');
                return;
            }

            if (!_dashboardInited) {
                _dashboardInited = true;
                initDashboard();
            } else {
                // Profile updated in background — refresh fields instantly
                refreshFormFields();
            }
        });
    } else {
        currentUser = null;
        userProfile = null;
        showSection('auth');
    }
});

function initDashboard() {
    const roleLabel = isSuperAdmin()  ? '👑 Super Admin'
                    : isDeptAdmin()   ? `🛡️ Dept Admin — ${userProfile.department||''}`
                    : isTeamLeader()  ? `👥 Team Leader — ${userProfile.team||''}`
                    : `${userProfile.level||'Level-1'} | ${userProfile.department||''} | ${userProfile.team||''}`;
    document.getElementById('user-display-name').textContent = userProfile.name;
    document.getElementById('user-role-display').textContent = roleLabel;
    if (isAnyAdmin()) { const ab = document.getElementById('admin-menu-btn'); if(ab) ab.classList.remove('hidden'); }
    showSection('dashboard');
    switchTab('sadhana');
    if (window._initNotifications) window._initNotifications();
    setupDateSelect();
    refreshFormFields();
}

// ═══════════════════════════════════════════════════════════
// 6. NAVIGATION
// ═══════════════════════════════════════════════════════════
window.switchTab = (t) => {
    // Hide ALL panels including admin-panel
    ['sadhana-panel','reports-panel','progress-panel','admin-panel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById(t + '-panel');
    if (panel) panel.classList.add('active');
    const btn = document.querySelector(`.tab-btn[onclick*="'${t}'"]`);
    if (btn) btn.classList.add('active');

    if (t === 'reports')  loadReports(currentUser.uid, 'weekly-reports-container');
    if (t === 'progress') loadMyProgressChart('daily');
};

function showSection(sec) {
    ['auth-section','profile-section','dashboard-section'].forEach(id =>
        document.getElementById(id).classList.add('hidden'));
    document.getElementById(sec+'-section').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// 7. REPORTS TABLE
// ═══════════════════════════════════════════════════════════
const APP_START = '2026-02-12';

// Fair denominator: dailyMax × submitted/NR days in week (no future days)
function fairDenominator(sunStr, weekData, level) {
    const dailyMax = getDailyMax(level || 'Level-1');
    const today = localDateStr(0);
    let days = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(sunStr); d.setDate(d.getDate() + i);
        const ds = d.toISOString().split('T')[0];
        if (ds < APP_START) continue;
        if (ds > today) break;
        if (ds === today) {
            const submitted = weekData && weekData.find(e => e.id === ds && e.sleepTime !== 'NR');
            if (!submitted) break;
        }
        days++;
    }
    return Math.max(days, 1) * dailyMax;
}

// ─── Bonus popup ──────────────────────────────────────────
window.openBonusPopup = (bonusJson) => {
    const bonus = JSON.parse(decodeURIComponent(bonusJson));
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    const row = (label, val) => {
        const color = val>0?'#15803d':val<0?'#dc2626':'#888';
        const disp  = val>0?`+${val}`:val===0?'0':val;
        // Show what value means
        const meaning = val===5?'✅ Yes':val===-5?'❌ No':val===0?'—':'';
        return `<tr>
            <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;">${label}</td>
            <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;color:#888;font-size:12px;">${meaning}</td>
            <td style="padding:7px 10px;font-weight:700;color:${color};border-bottom:1px solid #f0f0f0;">${disp}</td>
        </tr>`;
    };
    if (bonus.instrument !== undefined) html += row(`🎵 ${bonus.instrumentName||'Instrument'} (${bonus.instrumentMins} min)`, bonus.instrument);
    if (bonus.notes !== undefined && bonus.notes!==undefined) html += row(`📝 Notes Revision (${bonus.notesMins} min)`, bonus.notes);
    if (bonus.dress1 !== undefined)     html += row(`👗 ${bonus.dress1Label||'Dress 1'}`, bonus.dress1);
    if (bonus.dress2 !== undefined)     html += row(`👗 ${bonus.dress2Label||'Dress 2'}`, bonus.dress2);
    if (bonus.tilak !== undefined)      html += row(`🔱 Tilak`, bonus.tilak);
    if (bonus.mala !== undefined)       html += row(`📿 Mala`, bonus.mala);
    const total = (bonus.instrument||0)+(bonus.notes||0)+(bonus.dress1||0)+(bonus.dress2||0)+(bonus.tilak||0)+(bonus.mala||0);
    html += `<tr style="background:#f8fafc;">
        <td colspan="2" style="padding:8px 10px;font-weight:700;">Total Bonus</td>
        <td style="padding:8px 10px;font-weight:800;color:${total>=0?'#15803d':'#dc2626'};">${total>=0?'+':''}${total}</td>
    </tr>`;
    html += '</table>';
    document.getElementById('bonus-popup-content').innerHTML = html;
    document.getElementById('bonus-popup').classList.remove('hidden');
};
window.closeBonusPopup = () => document.getElementById('bonus-popup').classList.add('hidden');

// ── User Guide Tab Switcher ────────────────────────────────
window.guideTab = (tab) => {
    ['intro','form','level1','level2','level3','level4','reports','admin','faq'].forEach(t => {
        document.getElementById('gpanel-'+t)?.classList.add('hidden');
        document.getElementById('gtab-'+t)?.classList.remove('active');
    });
    document.getElementById('gpanel-'+tab)?.classList.remove('hidden');
    document.getElementById('gtab-'+tab)?.classList.add('active');
};

function loadReports(userId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (activeListener) { activeListener(); activeListener = null; }

    container.innerHTML = '<p style="text-align:center;color:#aaa;padding:20px;">Loading…</p>';

    // Use userProfile if viewing own reports, else fetch from Firestore
    const profilePromise = (userId === currentUser?.uid && userProfile)
        ? Promise.resolve(userProfile)
        : db.collection('users').doc(userId).get().then(d => d.exists ? d.data() : {});

    profilePromise.then(uData => {
        const level      = uData.level       || 'Level-1';
        const dept       = uData.department  || '';
        const instrument = uData.instrument  || '';
        const isL34      = level==='Level-3'||level==='Level-4';
        const dailyMax   = getDailyMax(level);
        const dress1Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Gopi Dress' : 'Dhoti';
        const dress2Label= (dept==='IGF'||dept==='ICF_MTG') ? 'Blouse'     : 'Kurta';

        activeListener = db.collection('users').doc(userId).collection('sadhana')
            .onSnapshot(snap => {
                const weeksList = [];
                for (let i=0;i<4;i++) {
                    const d = new Date(); d.setDate(d.getDate()-i*7);
                    weeksList.push(getWeekInfo(d.toISOString().split('T')[0]));
                }
                const weeks = {};
                weeksList.forEach(w => { weeks[w.label] = {range:w.label, sunStr:w.sunStr, data:[], total:0}; });

                snap.forEach(doc => {
                    if (doc.id < APP_START) return;
                    const data = doc.data(); const wk = getWeekInfo(doc.id);
                    if (weeks[wk.label]) { weeks[wk.label].data.push({id:doc.id,...data}); weeks[wk.label].total+=(data.totalScore||0); }
                });

                weeksList.forEach(wi => {
                    const wk = weeks[wi.label];
                    let curr = new Date(wi.sunStr);
                    for (let i=0;i<7;i++) {
                        const ds = curr.toISOString().split('T')[0];
                        if (ds>=APP_START && isPastDate(ds) && !wk.data.find(e=>e.id===ds)) {
                            const nr=getNRData(ds); wk.data.push(nr); wk.total+=nr.totalScore;
                        }
                        curr.setDate(curr.getDate()+1);
                    }
                });

                container.innerHTML = '';
                weeksList.forEach(wi => {
                    const wk    = weeks[wi.label];
                    // Weekly service pool
                    const svcTotal   = wk.data.reduce((s,e)=>s+(e.serviceMinutes||0),0);
                    const svcScore   = calcServiceWeekly(svcTotal, level);
                    const weekBonus  = wk.data.reduce((s,e)=>s+(e.bonusTotal||0),0);

                    const wkFD    = fairDenominator(wi.sunStr, wk.data, level);
                    const wkTotal = wk.total + svcScore + weekBonus;
                    const wkPct   = Math.round((wkTotal / wkFD) * 100);
                    const wkColor = wkTotal < 0 ? '#dc2626' : wkPct < 30 ? '#d97706' : '#16a34a';
                    const div     = document.createElement('div'); div.className='week-card';
                    const bodyId  = containerId.replace(/[^a-zA-Z0-9]/g,'') + '-wb-' + wi.sunStr;

                    // Score cell styling
                    const mkS = (v) => {
                        const color = v<0?'#b91c1c':v>=20?'#15803d':'#1a252f';
                        const bg    = v<0?'#fff5f5':v>=20?'#f0fdf4':'';
                        const bold  = v!==0?'700':'400';
                        const disp  = v<0?`(${v})`:v;
                        return `<td style="background:${bg};color:${color};font-weight:${bold};">${disp}</td>`;
                    };
                    // Green+bold for best-of
                    const mkBest = (v, isBest) => {
                        const color = isBest ? '#15803d' : (v<0?'#b91c1c':'#1a252f');
                        const bg    = isBest ? '#f0fdf4' : (v<0?'#fff5f5':'');
                        const bold  = isBest ? '800' : (v!==0?'600':'400');
                        const disp  = v<0?`(${v})`:v;
                        const border= isBest ? 'border:2px solid #16a34a;' : '';
                        return `<td style="background:${bg};color:${color};font-weight:${bold};${border}">${disp}</td>`;
                    };

                    // Sunday service pool progress — week header mein show hoga, table mein nahi
                    const svcPoolInfo = `🛠️ ${svcTotal}min`;

                    const rowsHtml = wk.data.sort((a,b)=>b.id.localeCompare(a.id)).map((e, ri) => {
                        const isNR     = e.sleepTime === 'NR';
                        const stripeBg = ri%2===0?'#ffffff':'#f8fafc';
                        const rowBg    = isNR ? '#fff5f5' : stripeBg;
                        const sc       = e.scores || {};
                        const editedBadge = e.editedAt
                            ? `<span class="edited-badge" onclick="showEditHistory(event,'${e.id}','${userId}')" title="View edit history">✏️</span>` : '';
                        const editBtn = isSuperAdmin()
                            ? `<button onclick="openEditModal('${userId}','${e.id}')" class="btn-edit-cell">Edit</button>` : '';

                        // Best of pathan/hearing
                        const patS  = sc.reading??0;
                        const hearS = sc.hearing??0;
                        const patIsBest  = !isL34 && patS >= hearS;
                        const hearIsBest = !isL34 && hearS > patS;

                        // Bonus total + JSON for popup
                        const bonus = e.bonus || {};
                        const bonusTotal = (bonus.instrument||0)+(bonus.notes||0)+(bonus.dress1||0)+(bonus.dress2||0)+(bonus.tilak||0)+(bonus.mala||0);
                        const bonusObj = {
                            level, instrument: bonus.instrument, instrumentName: instrument,
                            instrumentMins: e.instrumentMinutes||0,
                            notes: bonus.notes, notesMins: e.notesMinutes||0,
                            dress1: bonus.dress1, dress1Label,
                            dress2: bonus.dress2, dress2Label,
                            tilak: bonus.tilak, mala: bonus.mala
                        };
                        const bonusJson = encodeURIComponent(JSON.stringify(bonusObj));
                        const bonusBg   = bonusTotal>0?'#faf5ff':bonusTotal<0?'#fff5f5':'';
                        const bonusColor= bonusTotal>0?'#7c3aed':bonusTotal<0?'#b91c1c':'#888';
                        const bonusCell = bonusTotal!==0
                            ? `<td style="background:${bonusBg};color:${bonusColor};font-weight:700;cursor:pointer;text-decoration:underline dotted;" onclick="openBonusPopup('${bonusJson}')" title="Click for breakdown">${bonusTotal>0?'+':''}${bonusTotal}</td>`
                            : `<td style="color:#aaa;">—</td>`;
                        // Grand total = daily score + bonus
                        const grandTotal = (e.totalScore||0) + bonusTotal;
                        const gtColor    = grandTotal<0?'#b91c1c':grandTotal>=(dailyMax*0.8)?'#15803d':'#1a252f';

                        // Service — minutes only, no marks (weekly pool)
                        const svcMins = e.serviceMinutes||0;

                        return `<tr style="background:${rowBg};">
                            <td style="font-weight:600;">${e.id.split('-').slice(1).reverse().join('/')}${editedBadge}</td>
                            <td style="${isNR?'color:#b91c1c;font-weight:700;':''}">${e.sleepTime||'NR'}</td>${mkS(sc.sleep??0)}
                            <td style="${isNR?'color:#b91c1c;':''}">${e.wakeupTime||'NR'}</td>${mkS(sc.wakeup??0)}
                            <td>${e.chantingTime||'NR'}</td>${mkS(sc.chanting??0)}
                            <td>${e.readingMinutes||0}m</td>${mkBest(patS, patIsBest)}
                            <td>${e.hearingMinutes||0}m</td>${mkBest(hearS, hearIsBest)}
                            <td>${e.instrumentMinutes||0}m</td>${mkS(sc.instrument??0)}
                            <td>${e.daySleepMinutes||0}m</td>${mkS(sc.daySleep??0)}
                            <td style="color:#6b7280;">${svcMins}m</td>
                            ${bonusCell}
                            <td style="font-weight:800;color:${gtColor};">${grandTotal}</td>
                            <td>${e.dayPercent??0}%</td>
                            ${isSuperAdmin()?`<td style="padding:2px 4px;">${editBtn}</td>`:''}
                        </tr>`;
                    }).join('');

                    const instrHeader = isL34 ? `<th>${instrument||'Instrument'}</th><th>M</th>` : `<th>${instrument||'Instrument'}</th><th>M</th>`;
                    const editThCol   = isSuperAdmin() ? '<th></th>' : '';

                    div.innerHTML = `
                        <div class="week-header" onclick="document.getElementById('${bodyId}').classList.toggle('open')">
                            <span style="white-space:nowrap;">📅 ${wk.range.replace('_',' ')}</span>
                            <span style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;">
                                <span style="font-size:11px;color:#6b7280;white-space:nowrap;">🛠️ ${svcTotal}min→${svcScore>=0?'+':''}${svcScore}</span>
                                <strong style="white-space:nowrap;color:${wkColor}">${wkTotal} / ${wkFD} (${wkPct}%) ▼</strong>
                            </span>
                        </div>
                        <div class="week-body" id="${bodyId}">
                            <table class="data-table">
                            <thead><tr>
                                <th>Date</th><th>Bed</th><th>M</th><th>Wake</th><th>M</th><th>Chant</th><th>M</th>
                                <th>Pathan</th><th>M</th><th>Hearing</th><th>M</th>
                                ${instrHeader}
                                <th>Day Sleep</th><th>M</th>
                                <th>Seva(m)</th>
                                <th>Bonus</th>
                                <th>Total</th><th>%</th>
                                ${editThCol}
                            </tr></thead>
                            <tbody>${rowsHtml}</tbody></table>
                        </div>`;
                    container.appendChild(div);
                });
            }, err => console.error('Snapshot error:', err));
    }).catch(err => {
        console.error('loadReports profile fetch error:', err);
        container.innerHTML = '<p style="text-align:center;color:#dc2626;padding:20px;">Error loading reports. Please try again.</p>';
    });
}

// ═══════════════════════════════════════════════════════════
// 8. PROGRESS CHARTS
// ═══════════════════════════════════════════════════════════
let myChartInstance    = null;
let modalChartInstance = null;
let progressModalUserId   = null;
let progressModalUserName = null;

async function fetchChartData(userId, view) {
    const snap = await db.collection('users').doc(userId).collection('sadhana')
        .orderBy(firebase.firestore.FieldPath.documentId()).get();
    const allEntries = [];
    snap.forEach(doc => {
        if (doc.id >= APP_START) allEntries.push({ date: doc.id, score: doc.data().totalScore || 0 });
    });

    if (view === 'daily') {
        const labels = [], data = [];
        for (let i = 27; i >= 0; i--) {
            const ds    = localDateStr(i);
            if (ds < APP_START) continue;
            const entry = allEntries.find(e => e.date === ds);
            if (i === 0 && !entry) continue; // skip today if not yet submitted
            labels.push(ds.split('-').slice(1).reverse().join('/'));
            data.push(entry ? entry.score : -35);
        }
        return { labels, data, label:'Daily Score', max:160, color:'#3498db' };
    }

    if (view === 'weekly') {
        const labels = [], data = [];
        const todayStr = localDateStr(0);
        for (let i = 11; i >= 0; i--) {
            const d  = new Date(); d.setDate(d.getDate() - i*7);
            const wi = getWeekInfo(d.toISOString().split('T')[0]);
            if (wi.sunStr < APP_START) continue;
            let tot = 0; let curr = new Date(wi.sunStr);
            for (let j=0;j<7;j++) {
                const ds = curr.toISOString().split('T')[0];
                if (ds > todayStr) { curr.setDate(curr.getDate()+1); continue; }
                const en = allEntries.find(e=>e.date===ds);
                if (ds === todayStr && !en) { curr.setDate(curr.getDate()+1); continue; }
                tot += en ? en.score : -30;
                curr.setDate(curr.getDate()+1);
            }
            labels.push(wi.label.split('_')[0].split(' to ')[0]);
            data.push(tot);
        }
        return { labels, data, label:'Weekly Score', max:1120, color:'#27ae60' };
    }

    if (view === 'monthly') {
        const monthMap = {};
        allEntries.forEach(en => {
            const ym = en.date.substring(0,7);
            monthMap[ym] = (monthMap[ym]||0) + en.score;
        });
        const sorted = Object.keys(monthMap).sort();
        const labels = sorted.map(ym => {
            const [y,m] = ym.split('-');
            return `${new Date(y,m-1).toLocaleString('en-GB',{month:'short'})} ${y}`;
        });
        return { labels, data: sorted.map(k=>monthMap[k]), label:'Monthly Score', max:null, color:'#8b5cf6' };
    }
}

function renderChart(canvasId, chartData, existingInstance) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    if (existingInstance) existingInstance.destroy();
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: chartData.labels,
            datasets: [{
                label: chartData.label,
                data: chartData.data,
                borderColor: chartData.color,
                backgroundColor: chartData.color + '22',
                borderWidth: 2.5,
                pointRadius: 4,
                pointHoverRadius: 6,
                fill: true,
                tension: 0.35
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` Score: ${ctx.parsed.y}${chartData.max?' / '+chartData.max:''}` } }
            },
            scales: {
                x: { ticks: { font:{size:10}, maxRotation:45 }, grid:{display:false} },
                y: {
                    ticks: { font:{size:11} }, grid: { color:'#f0f0f0' },
                    suggestedMin: chartData.max ? -chartData.max*0.15 : undefined,
                    suggestedMax: chartData.max || undefined
                }
            }
        }
    });
}

async function loadMyProgressChart(view) {
    const data = await fetchChartData(currentUser.uid, view);
    myChartInstance = renderChart('my-progress-chart', data, myChartInstance);
}

window.setChartView = async (view, btn) => {
    document.querySelectorAll('.chart-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await loadMyProgressChart(view);
};

window.openProgressModal = async (userId, userName) => {
    progressModalUserId   = userId;
    progressModalUserName = userName;
    document.getElementById('progress-modal-title').textContent = `📈 ${userName} — Progress`;
    document.getElementById('progress-modal').classList.remove('hidden');
    document.querySelectorAll('#progress-modal-tabs .chart-tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
    const data = await fetchChartData(userId, 'daily');
    modalChartInstance = renderChart('modal-progress-chart', data, modalChartInstance);
};

window.closeProgressModal = () => {
    document.getElementById('progress-modal').classList.add('hidden');
    if (modalChartInstance) { modalChartInstance.destroy(); modalChartInstance = null; }
};

window.setModalChartView = async (view, btn) => {
    document.querySelectorAll('#progress-modal-tabs .chart-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const data = await fetchChartData(progressModalUserId, view);
    modalChartInstance = renderChart('modal-progress-chart', data, modalChartInstance);
};

// ═══════════════════════════════════════════════════════════
// 9. SADHANA FORM SCORING  (with sleep time warning)
// ═══════════════════════════════════════════════════════════
document.getElementById('sadhana-form').onsubmit = async (e) => {
    e.preventDefault();
    const date = document.getElementById('sadhana-date').value;
    const existing = await db.collection('users').doc(currentUser.uid).collection('sadhana').doc(date).get();
    if (existing.exists) { alert(`❌ Sadhana for ${date} already submitted! Contact admin for corrections.`); return; }

    const level = userProfile.level || 'Level-1';
    const dept  = userProfile.department || '';
    const instrument = userProfile.instrument || '';
    let slp     = document.getElementById('sleep-time').value;
    const wak   = document.getElementById('wakeup-time').value;
    const chn   = document.getElementById('chanting-time').value;
    const rMin  = parseInt(document.getElementById('reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('service-mins')?.value)||0;
    const svcTxt= document.getElementById('service-text')?.value?.trim()||'';
    const nMin  = parseInt(document.getElementById('notes-mins')?.value)||0;
    const dsMin = parseInt(document.getElementById('day-sleep-minutes').value)||0;
    const instMin = parseInt(document.getElementById('instrument-mins')?.value)||0;

    // Sleep time sanity check
    if (slp) {
        const [sh] = slp.split(':').map(Number);
        if (sh >= 4 && sh <= 20) {
            const goAhead = confirm(
                `⚠️ Bed Time Warning\n\nYou entered "${slp}" as bed time.\nThis looks like a daytime hour.\n\nDid you mean night time? e.g. 23:00 instead of 11:00?\n\nTap OK if "${slp}" is correct.\nTap Cancel to go back and fix it.`
            );
            if (!goAhead) return;
        }
    }

    // ── Calculate scores using independent per-level engine ──
    let result;
    if      (level==='Level-1') result = calcScoreL1(slp,wak,chn,rMin,hMin,dsMin,instMin);
    else if (level==='Level-2') result = calcScoreL2(slp,wak,chn,rMin,hMin,dsMin,instMin);
    else if (level==='Level-3') result = calcScoreL3(slp,wak,chn,rMin,hMin,dsMin,instMin);
    else                        result = calcScoreL4(slp,wak,chn,rMin,hMin,dsMin,instMin,nMin);

    // ── Sunday bonus ──
    const today    = new Date(date);
    const isSunday = today.getDay() === 0;
    let bonus = {};
    if (isSunday) {
        const dress1Val = document.getElementById('dress1-field')?.value||'no';
        const dress2Val = document.getElementById('dress2-field')?.value||'no';
        const tilakVal  = document.getElementById('tilak-field')?.value||'no';
        const malaVal   = document.getElementById('mala-field')?.value||'no';
        const sb = calcSundayBonus(dress1Val, dress2Val, tilakVal, malaVal, level);
        bonus = { dress1: sb.dress1, dress2: sb.dress2, tilak: sb.tilak, mala: sb.mala };
    }

    // L1/L2: instrument is bonus, L3/L4: instrument already in total
    const isL12 = level==='Level-1'||level==='Level-2';
    if (isL12) bonus.instrument = result.instrumentBonus;
    if (level==='Level-4') bonus.notes = result.notesBonus||0;

    const bonusTotal = Object.values(bonus).reduce((s,v)=>s+v,0);

    await db.collection('users').doc(currentUser.uid).collection('sadhana').doc(date).set({
        sleepTime: slp, wakeupTime: wak, chantingTime: chn,
        readingMinutes: rMin, hearingMinutes: hMin,
        serviceMinutes: sMin, serviceText: svcTxt,
        notesMinutes: nMin, instrumentMinutes: instMin,
        daySleepMinutes: dsMin,
        scores: result.sc, totalScore: result.total,
        bonus, bonusTotal,
        dayPercent: result.dayPercent,
        bestOf: result.bestIs,
        levelAtSubmission: level, instrument,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    alert(`✅ Submitted!\nScore: ${result.total} + Bonus: ${bonusTotal} = ${result.total+bonusTotal} (${result.dayPercent}%)`);
    switchTab('reports');
};

// ═══════════════════════════════════════════════════════════
// 10. ADMIN PANEL
// ═══════════════════════════════════════════════════════════

window.filterInactive = (minDays, btn) => {
    document.querySelectorAll('.inactive-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const body = document.getElementById('inactive-cards-body');
    if (body && window._buildInactiveCards) {
        body.innerHTML = window._buildInactiveCards(minDays);
    }
};

let adminPanelLoaded = false;
window.openAdminDrawer = () => {
    document.getElementById('admin-drawer').classList.add('open');
    document.getElementById('admin-drawer-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // Show admin panel, hide others
    ['sadhana-panel','reports-panel','progress-panel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const ap = document.getElementById('admin-panel');
    if (ap) ap.classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    // Ensure reports sub-panel is shown by default
    document.querySelectorAll('.admin-sub-panel').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    const defaultPanel = document.getElementById('admin-sub-reports');
    if (defaultPanel) { defaultPanel.classList.remove('hidden'); defaultPanel.classList.add('active'); }
    document.querySelectorAll('.drawer-nav-item').forEach(b => b.classList.remove('active'));
    const firstNav = document.querySelector('.drawer-nav-item');
    if (firstNav) firstNav.classList.add('active');
    if (!adminPanelLoaded) { adminPanelLoaded = true; loadAdminPanel(); }
};

window.closeAdminDrawer = () => {
    document.getElementById('admin-drawer').classList.remove('open');
    document.getElementById('admin-drawer-overlay').classList.add('hidden');
    document.body.style.overflow = '';
};

window.selectAdminSection = (section, btn) => {
    // Switch active nav item
    document.querySelectorAll('.drawer-nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Switch content panel
    document.querySelectorAll('.admin-sub-panel').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    const panel = document.getElementById('admin-sub-' + section);
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
    // Close drawer
    closeAdminDrawer();
};

window.filterAdminUsers = () => {
    const query    = (document.getElementById('admin-search-input')?.value || '').toLowerCase().trim();
    const category = document.getElementById('admin-category-filter')?.value || '';
    const cards    = document.querySelectorAll('#admin-users-list .user-card');
    cards.forEach(card => {
        const name = (card.querySelector('.user-name')?.textContent || '').toLowerCase();
        const meta = (card.querySelector('.user-meta')?.textContent || '');
        const matchName = !query    || name.includes(query);
        const matchCat  = !category || meta.includes(category);
        card.style.display = (matchName && matchCat) ? '' : 'none';
    });
};
async function loadAdminPanel() {
    const tableBox        = document.getElementById('admin-comparative-reports-container');
    const usersList       = document.getElementById('admin-users-list');
    const inactiveCont    = document.getElementById('admin-inactive-container');
    tableBox.innerHTML    = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    usersList.innerHTML   = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    if (inactiveCont) inactiveCont.innerHTML = '';

    const weeks = [];
    for (let i=0;i<4;i++) {
        const d=new Date(); d.setDate(d.getDate()-i*7);
        weeks.push(getWeekInfo(d.toISOString().split('T')[0]));
    }
    weeks.reverse();

    const usersSnap = await db.collection('users').get();
    const filtered = usersSnap.docs
        .filter(doc => matchesScope(doc.data()))
        .sort((a,b) => (a.data().name||'').localeCompare(b.data().name||''));

    // Color helper for percentage cells
    const pctStyle = (pct) => {
        if (pct < 0)   return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`(${pct}%)` };
        if (pct < 20)  return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`${pct}%`   };
        if (pct >= 70) return { bg:'',        color:'#15803d', bold:true, text:`${pct}%`   };
        return              { bg:'',        color:'#1a252f', bold:false, text:`${pct}%`  };
    };

    let tHtml = `<table class="comp-table" id="comp-perf-table">
        <thead><tr>
            <th class="comp-th comp-th-name">Name</th>
            <th class="comp-th">Level</th>
            <th class="comp-th">Dept</th>
            <th class="comp-th">Team</th>
            <th class="comp-th">Chanting</th>
            ${weeks.map(w=>`<th class="comp-th">${w.label.split('_')[0]}</th>`).join('')}
        </tr></thead><tbody>`;

    usersList.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = `info-banner ${isSuperAdmin()?'banner-purple':'banner-blue'}`;
    const scope = getAdminScope();
    banner.innerHTML = isSuperAdmin()
        ? '👑 <strong>Super Admin</strong> — All departments, full role management'
        : isDeptAdmin()
        ? `🛡️ <strong>Dept Admin</strong> — Department: <strong>${userProfile.department||''}</strong>`
        : `👥 <strong>Team Leader</strong> — Team: <strong>${userProfile.team||''}</strong>`;
    usersList.appendChild(banner);

    // Category filter — only visible to super admin
    const catFilter = document.getElementById('admin-category-filter');
    if (catFilter) catFilter.style.display = isSuperAdmin() ? '' : 'none';
    const searchInput = document.getElementById('admin-search-input');
    if (searchInput) searchInput.value = '';
    if (catFilter) catFilter.value = '';

    // ── INACTIVE DEVOTEES SECTION ─────────────────────────
    // Calculate consecutive missing days (excluding today) per user
    // We check up to 30 days back to find max consecutive streak

    // Inactive list will be populated inside main user loop below
    // Each entry: { id, name, level, lastDate, missedDays }
    const inactiveUsers = [];
    const userSadhanaCache = new Map(); // uid → entries array (reuse in comparative table)

    for (const uDoc of filtered) {
        const u     = uDoc.data();
        const sSnap = await uDoc.ref.collection('sadhana').get();
        const ents  = sSnap.docs.map(d=>({date:d.id, score:d.data().totalScore||0, sleepTime:d.data().sleepTime||''}));
        userSadhanaCache.set(uDoc.id, ents);

        // Calculate consecutive missing days from yesterday backwards (excl. today)
        const submittedDates = new Set(sSnap.docs.map(d => d.id).filter(d => d >= APP_START));
        let missedDays = 0;
        for (let i = 1; i <= 30; i++) {
            const ds = localDateStr(i);
            if (ds < APP_START) break;
            if (submittedDates.has(ds)) break; // streak broken
            missedDays++;
        }
        if (missedDays >= 2) {
            const allDates = Array.from(submittedDates).sort((a,b) => b.localeCompare(a));
            const lastDate = allDates[0] || null;
            inactiveUsers.push({ id: uDoc.id, name: u.name, level: u.level, lastDate, missedDays });
        }

        const rowIdx = filtered.indexOf(uDoc);
        const stripeBg = rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
        tHtml += `<tr style="background:${stripeBg}">
            <td class="comp-td comp-name">${u.name}</td>
            <td class="comp-td comp-meta">${u.level||'L1'}</td>
            <td class="comp-td comp-meta">${u.department||'-'}</td>
            <td class="comp-td comp-meta">${u.team||'-'}</td>
            <td class="comp-td comp-meta">${u.chantingCategory||'N/A'}</td>`;
        weeks.forEach(w => {
            let tot=0; let curr=new Date(w.sunStr);
            const weekEnts=[];
            const todayComp = localDateStr(0);
            for (let i=0;i<7;i++) {
                const ds=curr.toISOString().split('T')[0];
                if (ds < APP_START) { curr.setDate(curr.getDate()+1); continue; } // skip pre-app
                if (ds > todayComp) { curr.setDate(curr.getDate()+1); continue; } // skip future
                const en=ents.find(e=>e.date===ds);
                if (en) {
                    tot += en.score;
                    weekEnts.push({id:ds, sleepTime:en.sleepTime||'', score:en.score});
                } else if (ds < todayComp) {
                    tot += -35; // past day NR
                }
                // today not submitted — skip (not in fd either)
                curr.setDate(curr.getDate()+1);
            }
            const fd = fairDenominator(w.sunStr, weekEnts);
            const pct = Math.round((tot/fd)*100);
            const ps  = pctStyle(pct);
            const cellBg = ps.bg || stripeBg;
            tHtml += `<td class="comp-td comp-pct" style="background:${cellBg};color:${ps.color};font-weight:${ps.bold?'700':'400'};" title="${tot}/${fd}">${ps.text}</td>`;
        });
        tHtml += '</tr>';

        const card = document.createElement('div');
        card.className = 'user-card';

        let badge = '';
        if (u.role==='superAdmin')  badge=`<span class="role-badge" style="background:#7e22ce;color:white;">👑 Super Admin</span>`;
        else if (u.role==='deptAdmin') badge=`<span class="role-badge" style="background:#1a5276;color:white;">🛡️ Dept Admin (${u.department||''})</span>`;
        else if (u.role==='teamLeader') badge=`<span class="role-badge" style="background:#1e8449;color:white;">👥 Team Leader (${u.team||''})</span>`;

        const safe = (u.name||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");

        let roleDropdown = '';
        if (isSuperAdmin()) {
            // Super admin can assign any role
            let opts = '<option value="" disabled selected>Change Role…</option>';
            if (u.role === 'superAdmin') {
                opts += '<option value="demote">🚫 Revoke Super Admin</option>';
            } else {
                opts += `<option value="superAdmin">👑 Make Super Admin</option>`;
                ['IGF','IYF','ICF_MTG','ICF_PRJI'].forEach(dept => {
                    opts += `<option value="deptAdmin:${dept}">🛡️ Dept Admin — ${dept}</option>`;
                    if (DEPT_TEAMS[dept]) {
                        DEPT_TEAMS[dept].forEach(team => {
                            opts += `<option value="teamLeader:${dept}:${team}">👥 Team Leader — ${team} (${dept})</option>`;
                        });
                    }
                });
                opts += '<option value="demote">🚫 Revoke to User</option>';
            }
            roleDropdown = `<select onchange="handleRoleDropdown('${uDoc.id}',this)"
                style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;height:34px;background:white;cursor:pointer;flex:1;min-width:180px;max-width:220px;margin:0;">
                ${opts}</select>`;
        } else if (isDeptAdmin() && u.department === userProfile.department && u.role !== 'superAdmin') {
            // Dept admin can only assign teamLeader within their dept
            let opts = '<option value="" disabled selected>Change Role…</option>';
            if (DEPT_TEAMS[userProfile.department]) {
                DEPT_TEAMS[userProfile.department].forEach(team => {
                    opts += `<option value="teamLeader:${userProfile.department}:${team}">👥 Team Leader — ${team}</option>`;
                });
            }
            opts += '<option value="demote">🚫 Revoke to User</option>';
            roleDropdown = `<select onchange="handleRoleDropdown('${uDoc.id}',this)"
                style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;height:34px;background:white;cursor:pointer;flex:1;min-width:180px;max-width:220px;margin:0;">
                ${opts}</select>`;
        }

        card.innerHTML = `
            <div class="user-card-top">
                <span class="user-name">${u.name}</span>${badge}
                <div class="user-meta">${u.level||'Level-1'} · ${u.department||'-'} · ${u.team||'-'} · ${u.chantingCategory||'N/A'} · ${u.exactRounds||'?'} rounds</div>
            </div>
            <div class="user-actions">
                <button onclick="openUserModal('${uDoc.id}','${safe}')" class="btn-primary btn-sm">History</button>
                <button onclick="downloadUserExcel('${uDoc.id}','${safe}')" class="btn-success btn-sm">Excel</button>
                <button onclick="openProgressModal('${uDoc.id}','${safe}')" class="btn-purple btn-sm">Progress</button>
                <select onchange="handleLevelChange('${uDoc.id}', this)"
                    style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;height:34px;background:white;cursor:pointer;width:auto;margin:2px;">
                    <option value="" disabled selected>Level: ${u.level||'Level-1'}</option>
                    <option value="Level-1">Level-1</option>
                    <option value="Level-2">Level-2</option>
                    <option value="Level-3">Level-3</option>
                    <option value="Level-4">Level-4</option>
                </select>
                ${roleDropdown}
            </div>`;
        usersList.appendChild(card);
    }
    // ── Now build inactive section (inactiveUsers is fully populated) ──
    inactiveUsers.sort((a,b) => (a.name||'').localeCompare(b.name||''));

    // Store globally for filter buttons to use
    window._inactiveUsers = inactiveUsers;

    const inactiveSection = document.createElement('div');
    inactiveSection.className = 'inactive-section';

    // Build cards HTML for a given filter
    const buildInactiveCards = (minDays) => {
        // minDays: 2 = exactly 2, 3 = exactly 3, 4 = 4 and above
        const filtered2 = minDays === 4
            ? inactiveUsers.filter(u => u.missedDays >= 4)
            : inactiveUsers.filter(u => u.missedDays === minDays);
        const label = minDays === 4 ? '4+ consecutive days' : `exactly ${minDays} days`;
        if (filtered2.length === 0) return `<div class="inactive-empty">✅ No devotees missing ${label}!</div>`;
        return filtered2.map(u => {
            const lastTxt = u.lastDate
                ? `Last entry: ${u.lastDate.split('-').slice(1).join(' ')}`
                : 'No entries yet';
            const safe = (u.name||'').replace(/'/g,"\'");
            const dot = u.missedDays >= 4 ? '🔴' : u.missedDays === 3 ? '🟠' : '🟡';
            return `<div class="inactive-card">
                <div class="inactive-card-left">
                    <span class="inactive-dot">${dot}</span>
                    <div>
                        <div class="inactive-name">${u.name}</div>
                        <div class="inactive-meta">${u.level||'Level-1'} · ${lastTxt} · <strong>${u.missedDays} days missed</strong></div>
                    </div>
                </div>
                <div class="inactive-actions">
                    <button onclick="openUserModal('${u.id}','${safe}')" class="btn-primary btn-sm">History</button>
                    <button onclick="downloadUserExcel('${u.id}','${safe}')" class="btn-success btn-sm">Excel</button>
                </div>
            </div>`;
        }).join('');
    };

    const totalCount = inactiveUsers.length;
    const count4plus = inactiveUsers.filter(u => u.missedDays >= 4).length;

    inactiveSection.innerHTML = `
        <div class="inactive-filter-bar">
            <button class="inactive-filter-btn" onclick="filterInactive(2, this)">2 Days</button>
            <button class="inactive-filter-btn" onclick="filterInactive(3, this)">3 Days</button>
            <button class="inactive-filter-btn active" onclick="filterInactive(4, this)">4+ Days</button>
        </div>
        <div class="inactive-body" id="inactive-cards-body">
            ${buildInactiveCards(4)}
        </div>`;

    // Store builder for filter function
    window._buildInactiveCards = buildInactiveCards;
    const inactiveContainer = document.getElementById('admin-inactive-container');
    if (inactiveContainer) inactiveContainer.innerHTML = '';
    if (inactiveContainer) inactiveContainer.appendChild(inactiveSection);

    // Update inactive tab badge count — show 4+ days count
    const tabBadge = document.getElementById('inactive-tab-badge');
    if (tabBadge) tabBadge.textContent = count4plus > 0 ? count4plus : '';

    tableBox.innerHTML = tHtml + '</tbody></table>';
}

window.handleLevelChange = async (uid, sel) => {
    const newLevel = sel.value; sel.value = '';
    if (!newLevel) return;
    if (!confirm(`Change this devotee's level to ${newLevel}?`)) return;
    await db.collection('users').doc(uid).update({ level: newLevel });
    showToast(`✅ Level updated to ${newLevel}`, 'success');
    loadAdminPanel();
};

window.handleRoleDropdown = async (uid, sel) => {
    const val = sel.value; sel.value = '';
    if (!val) return;
    let newRole, dept = null, team = null, msg = '';

    if (val === 'superAdmin') {
        newRole = 'superAdmin';
        msg = '👑 Make this user SUPER ADMIN?\nFull access to all departments.';
    } else if (val.startsWith('deptAdmin:')) {
        newRole = 'deptAdmin';
        dept    = val.split(':')[1];
        msg     = `🛡️ Assign as Dept Admin for: ${dept}?`;
    } else if (val.startsWith('teamLeader:')) {
        const parts = val.split(':');
        newRole = 'teamLeader';
        dept    = parts[1];
        team    = parts[2];
        msg     = `👥 Assign as Team Leader for team: ${team} (${dept})?`;
    } else if (val === 'demote') {
        newRole = 'user';
        msg     = '🚫 Revoke all admin access and set as regular User?';
    } else return;

    if (!confirm(msg)) return;
    if (!confirm('Final confirmation?')) return;

    const updateData = { role: newRole, department: dept || (await db.collection('users').doc(uid).get()).data().department, team: team || (await db.collection('users').doc(uid).get()).data().team };
    await db.collection('users').doc(uid).update(updateData);
    alert('✅ Role updated!');
    if (window._sendRoleNotification) window._sendRoleNotification(uid, '', val, dept);
    loadAdminPanel();
};

// ═══════════════════════════════════════════════════════════
// 11. SUPER ADMIN — EDIT SADHANA
// ═══════════════════════════════════════════════════════════
let editModalUserId = null;
let editModalDate   = null;
let editModalOriginal = null;

window.openEditModal = async (userId, date) => {
    if (!isSuperAdmin()) return;

    editModalUserId = userId;
    editModalDate   = date;

    const docRef  = db.collection('users').doc(userId).collection('sadhana').doc(date);
    const docSnap = await docRef.get();
    if (!docSnap.exists) { alert('Entry not found.'); return; }

    const d = docSnap.data();
    editModalOriginal = { ...d }; // snapshot of original before edit

    // Fetch user's level for scoring context
    const uSnap   = await db.collection('users').doc(userId).get();
    const uLevel  = uSnap.exists ? (uSnap.data().level || 'Senior Batch') : 'Senior Batch';
    document.getElementById('edit-user-level').value = uLevel;

    // Populate fields
    document.getElementById('edit-sleep-time').value      = d.sleepTime      || '';
    document.getElementById('edit-wakeup-time').value     = d.wakeupTime     || '';
    document.getElementById('edit-chanting-time').value   = d.chantingTime   || '';
    document.getElementById('edit-reading-mins').value    = d.readingMinutes  || 0;
    document.getElementById('edit-hearing-mins').value    = d.hearingMinutes  || 0;
    document.getElementById('edit-service-mins').value    = d.serviceMinutes  || 0;
    document.getElementById('edit-notes-mins').value      = d.notesMinutes    || 0;
    document.getElementById('edit-day-sleep-mins').value  = d.daySleepMinutes || 0;
    document.getElementById('edit-reason').value          = '';

    // Get user name from admin panel context
    const uData = uSnap.exists ? uSnap.data() : {};
    document.getElementById('edit-modal-title').textContent = `✏️ Edit Sadhana — ${uData.name||userId} · ${date}`;

    // Show/hide notes field based on level
    document.getElementById('edit-notes-row').classList.toggle('hidden', uLevel !== 'Senior Batch');

    updateEditPreview();
    document.getElementById('edit-sadhana-modal').classList.remove('hidden');
};

window.closeEditModal = () => {
    document.getElementById('edit-sadhana-modal').classList.add('hidden');
    editModalUserId = editModalDate = editModalOriginal = null;
};

window.updateEditPreview = () => {
    const slp   = document.getElementById('edit-sleep-time').value;
    const wak   = document.getElementById('edit-wakeup-time').value;
    const chn   = document.getElementById('edit-chanting-time').value;
    const rMin  = parseInt(document.getElementById('edit-reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('edit-hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('edit-service-mins').value)||0;
    const nMin  = parseInt(document.getElementById('edit-notes-mins').value)||0;
    const dsMin = parseInt(document.getElementById('edit-day-sleep-mins').value)||0;
    const level = document.getElementById('edit-user-level').value || 'Senior Batch';

    if (!slp || !wak || !chn) return;
    const { total, dayPercent } = calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level);
    const prev = document.getElementById('edit-score-preview');
    prev.textContent = `New Score: ${total} / 160 (${dayPercent}%)`;
    prev.style.color = total < 0 ? '#dc2626' : total < 80 ? '#d97706' : '#16a34a';
};

window.submitEditSadhana = async () => {
    if (!isSuperAdmin() || !editModalUserId || !editModalDate) return;

    const slp   = document.getElementById('edit-sleep-time').value;
    const wak   = document.getElementById('edit-wakeup-time').value;
    const chn   = document.getElementById('edit-chanting-time').value;
    const rMin  = parseInt(document.getElementById('edit-reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('edit-hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('edit-service-mins').value)||0;
    const nMin  = parseInt(document.getElementById('edit-notes-mins').value)||0;
    const dsMin = parseInt(document.getElementById('edit-day-sleep-mins').value)||0;
    const reason= document.getElementById('edit-reason').value.trim();
    const level = document.getElementById('edit-user-level').value || 'Senior Batch';

    if (!slp||!wak||!chn) { alert('Please fill all time fields.'); return; }
    if (!confirm(`Save changes to ${editModalDate}?\nThis will update scores and log edit history.`)) return;

    const { sc, total, dayPercent } = calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level);

    // Build edit log entry — store original data
    // NOTE: serverTimestamp() cannot be used inside arrayUnion nested objects
    // So we use JS Date string for the log entry timestamp instead
    const now = new Date().toISOString();
    const editLog = {
        editedBy:    userProfile.name,
        editedByUid: currentUser.uid,
        editedAt:    now,
        reason:      reason || 'No reason provided',
        original: {
            sleepTime:       editModalOriginal.sleepTime       || 'NR',
            wakeupTime:      editModalOriginal.wakeupTime      || 'NR',
            chantingTime:    editModalOriginal.chantingTime    || 'NR',
            readingMinutes:  editModalOriginal.readingMinutes  || 0,
            hearingMinutes:  editModalOriginal.hearingMinutes  || 0,
            serviceMinutes:  editModalOriginal.serviceMinutes  || 0,
            notesMinutes:    editModalOriginal.notesMinutes    || 0,
            daySleepMinutes: editModalOriginal.daySleepMinutes || 0,
            totalScore:      editModalOriginal.totalScore      || 0,
            dayPercent:      editModalOriginal.dayPercent      || 0
        }
    };

    try {
        const docRef = db.collection('users').doc(editModalUserId).collection('sadhana').doc(editModalDate);

        // Step 1: Update all field values (serverTimestamp safe here at top level)
        await docRef.update({
            sleepTime:       slp,
            wakeupTime:      wak,
            chantingTime:    chn,
            readingMinutes:  rMin,
            hearingMinutes:  hMin,
            serviceMinutes:  sMin,
            notesMinutes:    nMin,
            daySleepMinutes: dsMin,
            scores:          sc,
            totalScore:      total,
            dayPercent:      dayPercent,
            editedAt:        firebase.firestore.FieldValue.serverTimestamp(),
            editedBy:        userProfile.name
        });

        // Step 2: Append to editLog array separately
        // (arrayUnion cannot contain serverTimestamp inside nested objects — so we use ISO string in editLog)
        await docRef.update({
            editLog: firebase.firestore.FieldValue.arrayUnion(editLog)
        });

        closeEditModal();
        alert(`✅ Sadhana updated!\nNew Score: ${total} (${dayPercent}%)`);
    } catch (err) {
        console.error('Edit save error:', err);
        alert('❌ Save failed: ' + err.message);
    }
};

// Show edit history modal — full field-by-field comparison
window.showEditHistory = async (evt, date, userId) => {
    evt.stopPropagation();
    const docSnap = await db.collection('users').doc(userId).collection('sadhana').doc(date).get();
    if (!docSnap.exists) return;
    const cur = docSnap.data();
    const log = cur.editLog || [];

    if (log.length === 0) {
        alert('No edit history found.');
        return;
    }

    // Field definitions — label, key in original object, key in current doc
    const FIELDS = [
        { label: 'Bed Time',      oKey: 'sleepTime',       cKey: 'sleepTime'       },
        { label: 'Wake Up',       oKey: 'wakeupTime',      cKey: 'wakeupTime'      },
        { label: 'Chanting By',   oKey: 'chantingTime',    cKey: 'chantingTime'    },
        { label: 'Reading (min)', oKey: 'readingMinutes',  cKey: 'readingMinutes'  },
        { label: 'Hearing (min)', oKey: 'hearingMinutes',  cKey: 'hearingMinutes'  },
        { label: 'Service (min)', oKey: 'serviceMinutes',  cKey: 'serviceMinutes'  },
        { label: 'Notes (min)',   oKey: 'notesMinutes',    cKey: 'notesMinutes'    },
        { label: 'Day Sleep(min)',oKey: 'daySleepMinutes', cKey: 'daySleepMinutes' },
        { label: 'Total Score',   oKey: 'totalScore',      cKey: 'totalScore'      },
    ];

    let html = '';
    log.forEach((entry, i) => {
        // Parse timestamp
        let ts = 'Unknown time';
        if (entry.editedAt) {
            const d = typeof entry.editedAt === 'string'
                ? new Date(entry.editedAt)
                : entry.editedAt.toDate?.();
            if (d) ts = d.toLocaleString('en-IN', {
                day:'2-digit', month:'short', year:'numeric',
                hour:'2-digit', minute:'2-digit'
            });
        }

        html += `<div class="eh-entry">`;
        html += `<div class="eh-header">✏️ Edit ${i+1} &nbsp;|&nbsp; <span class="eh-who">${entry.editedBy||'Admin'}</span> &nbsp;|&nbsp; <span class="eh-when">${ts}</span></div>`;
        html += `<div class="eh-reason">📝 ${entry.reason || 'No reason provided'}</div>`;

        if (entry.original) {
            const o = entry.original;
            // Only show fields that actually changed
            const changedFields = FIELDS.filter(f => {
                const oval = o[f.oKey] ?? '—';
                const cval = cur[f.cKey] ?? '—';
                return String(oval) !== String(cval);
            });

            if (changedFields.length === 0) {
                html += `<div class="eh-nochange">No field changes detected in this edit.</div>`;
            } else {
                html += `<table class="eh-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>`;
                changedFields.forEach(f => {
                    const oval = o[f.oKey] ?? '—';
                    const cval = cur[f.cKey] ?? '—';
                    html += `<tr><td class="eh-field">${f.label}</td><td class="eh-before">${oval}</td><td class="eh-after">${cval}</td></tr>`;
                });
                html += `</tbody></table>`;
            }
        } else {
            html += `<div class="eh-nochange">Original data not recorded for this edit.</div>`;
        }
        html += `</div>`;
    });

    document.getElementById('edit-history-content').innerHTML = html;
    document.getElementById('edit-history-modal').classList.remove('hidden');
};

window.closeEditHistoryModal = () => {
    document.getElementById('edit-history-modal').classList.add('hidden');
};

// ═══════════════════════════════════════════════════════════
// 12. DATE SELECT & PROFILE FORM
// ═══════════════════════════════════════════════════════════
function setupDateSelect() {
    const s = document.getElementById('sadhana-date');
    if (!s) return;
    s.innerHTML = '';
    for (let i=0;i<3;i++) {
        const ds = localDateStr(i);
        const opt = document.createElement('option');
        opt.value = ds;
        const parts = ds.split('-');
        // OLD LINE (restore after 1 week):
        opt.textContent = parts[2] + '/' + parts[1] + '/' + parts[0] + (i===0 ? ' (Today)' : ' (Yesterday)');
        opt.textContent = parts[2] + '/' + parts[1] + '/' + parts[0] + (i===0 ? ' (Today)' : i===1 ? ' (Yesterday)' : ' (2 days ago)');
        s.appendChild(opt);
    }
    refreshFormFields();
}


function refreshFormFields() {
    if (!userProfile) return;
    const level  = userProfile.level || 'Level-1';
    const dept   = userProfile.department || '';
    const instrument = userProfile.instrument || 'Instrument';
    const isL34  = level==='Level-3'||level==='Level-4';
    const isL4   = level==='Level-4';

    // Notes Revision — L4 only
    const notesArea = document.getElementById('notes-area');
    if (notesArea) notesArea.classList.toggle('hidden', !isL4);

    // Instrument label — show instrument name from profile
    const instrLabel = document.getElementById('instrument-form-label');
    if (instrLabel) instrLabel.textContent = `🎵 ${instrument} — Minutes${isL34?' (Compulsory)':' (Bonus)'}`;

    // Sunday bonus — show only if today is Sunday
    const todayDay = new Date().getDay();
    const selectedDate = document.getElementById('sadhana-date')?.value;
    const selDay = selectedDate ? new Date(selectedDate).getDay() : -1;
    const isSunday = selDay === 0;
    const sundayArea = document.getElementById('sunday-bonus-area');
    if (sundayArea) sundayArea.classList.toggle('hidden', !isSunday);

    // Sunday dress fields based on dept
    if (isSunday) {
        const dress1Label = (dept==='IGF'||dept==='ICF_MTG') ? 'Gopi Dress' : 'Dhoti';
        const dress2Label = (dept==='IGF'||dept==='ICF_MTG') ? 'Blouse'     : 'Kurta';
        const noOpt = isL34
            ? '<option value="no">No (-5) ❌</option><option value="yes">Yes (+5) ✅</option>'
            : '<option value="yes">Yes (+5) ✅</option><option value="no">No (0)</option>';
        document.getElementById('dress-fields').innerHTML = `
            <label class="form-label">👗 ${dress1Label}</label>
            <select id="dress1-field">${noOpt}</select>
            <label class="form-label">👗 ${dress2Label}</label>
            <select id="dress2-field">${noOpt}</select>`;
        // Tilak/Mala options based on level
        const tilakMalaOpts = isL34
            ? '<option value="no">No (-5) ❌</option><option value="yes">Yes (+5) ✅</option>'
            : '<option value="yes">Yes (+5) ✅</option><option value="no">No (0)</option>';
        const tilakSel = document.getElementById('tilak-field');
        const malaSel  = document.getElementById('mala-field');
        if (tilakSel) tilakSel.innerHTML = tilakMalaOpts;
        if (malaSel)  malaSel.innerHTML  = tilakMalaOpts;
    }
}

// Re-check Sunday bonus when date changes
document.addEventListener('DOMContentLoaded', () => {
    const dateEl = document.getElementById('sadhana-date');
    if (dateEl) dateEl.addEventListener('change', refreshFormFields);
});
document.getElementById('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const data = {
        name:             document.getElementById('profile-name').value.trim(),
        level:            userProfile?.level || 'Level-1',  // Level admin set karega, user nahi
        department:       document.getElementById('profile-dept').value,
        team:             document.getElementById('profile-team').value,
        chantingCategory: document.getElementById('profile-chanting').value,
        exactRounds:      document.getElementById('profile-exact-rounds').value,
        instrument:       document.getElementById('profile-instrument').value || '',
        role:             userProfile?.role || 'user'
    };
    if (!data.name)       { alert('Please enter your name.'); return; }
    if (!data.department || !data.team) { alert('Please select Department and Team.'); return; }
    await db.collection('users').doc(currentUser.uid).set(data, { merge: true });
    alert('✅ Profile saved!');
    location.reload();
};

// ═══════════════════════════════════════════════════════════
// 13. PASSWORD MODAL
// ═══════════════════════════════════════════════════════════
window.openPasswordModal = () => {
    document.getElementById('pwd-new').value     = '';
    document.getElementById('pwd-confirm').value = '';
    document.getElementById('password-modal').classList.remove('hidden');
};

window.closePasswordModal = () => {
    document.getElementById('password-modal').classList.add('hidden');
};

window.submitPasswordChange = async () => {
    const newPwd  = document.getElementById('pwd-new').value.trim();
    const confPwd = document.getElementById('pwd-confirm').value.trim();
    if (!newPwd)           { alert('❌ Please enter a new password.'); return; }
    if (newPwd.length < 6) { alert('❌ Password must be at least 6 characters.'); return; }
    if (newPwd !== confPwd){ alert('❌ Passwords do not match!'); return; }
    if (!confirm('🔑 Confirm password change?')) return;
    try {
        await currentUser.updatePassword(newPwd);
        closePasswordModal();
        alert('✅ Password changed successfully!');
    } catch (err) {
        if (err.code === 'auth/requires-recent-login') {
            alert('⚠️ For security, please logout and login again, then try changing your password.');
        } else {
            alert('❌ Failed: ' + err.message);
        }
    }
};

// ═══════════════════════════════════════════════════════════
// 14. MISC BINDINGS
// ═══════════════════════════════════════════════════════════
document.getElementById('login-form').onsubmit = (e) => {
    e.preventDefault();
    auth.signInWithEmailAndPassword(
        document.getElementById('login-email').value,
        document.getElementById('login-password').value
    ).catch(err => alert(err.message));
};

document.getElementById('logout-btn').onclick = () => auth.signOut();

window.openUserModal = (id, name) => {
    document.getElementById('user-report-modal').classList.remove('hidden');
    document.getElementById('modal-user-name').textContent = `📋 ${name} — History`;
    loadReports(id, 'modal-report-container');
};

window.closeUserModal = () => {
    document.getElementById('user-report-modal').classList.add('hidden');
    if (activeListener) { activeListener(); activeListener = null; }
};

window.openProfileEdit = () => {
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

    setTxt('profile-title',    'Edit Profile');
    setTxt('profile-subtitle', 'Update your details');
    setVal('profile-name',     userProfile.name             || '');
    setVal('profile-chanting', userProfile.chantingCategory || '');
    setVal('profile-exact-rounds', userProfile.exactRounds  || '');

    const deptSel = document.getElementById('profile-dept');
    if (deptSel) deptSel.value = userProfile.department || '';
    populateDeptTeams('profile-team', userProfile.department || '', userProfile.team || '');
    populateInstrumentOptions(userProfile.level || 'Level-1');
    const instrSel = document.getElementById('profile-instrument');
    if (instrSel) instrSel.value = userProfile.instrument || '';

    const cancelBtn = document.getElementById('cancel-edit');
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    showSection('profile');
};

// ═══════════════════════════════════════════════════════════
// 15. FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════
window.openForgotPassword = (e) => {
    e.preventDefault();
    const email = prompt('Enter your email address to reset password:');
    if (!email) return;
    if (!email.includes('@')) { alert('❌ Please enter a valid email address!'); return; }
    if (confirm(`Send password reset email to: ${email}?`)) {
        auth.sendPasswordResetEmail(email)
            .then(() => alert(`✅ Password reset email sent to ${email}!\n\nCheck your inbox and spam folder.`))
            .catch(error => {
                if (error.code==='auth/user-not-found') alert('❌ No account found with this email address!');
                else if (error.code==='auth/invalid-email') alert('❌ Invalid email format!');
                else alert('❌ Error: ' + error.message);
            });
    }
};


// ═══════════════════════════════════════════════════════════
// PWA — Service Worker Registration
// ═══════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => {
                console.log('SW registered:', reg.scope);
                window._swReg = reg;
            })
            .catch(err => console.log('SW registration failed:', err));
    });
}

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS SYSTEM
// ═══════════════════════════════════════════════════════════

// VAPID public key — replace with your actual key from Firebase Console
// For now using a placeholder — see setup instructions
const VAPID_PUBLIC_KEY = 'BBIaVXF1wlqwE_41UCqmXQpi89u0tIt5UUHjibouttw0b_BE-Xt7EmTaNaP8JY0wYH279aiWlUVSQ2w6zbr00Tc';

// Convert VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

// ── Request notification permission ──
window.requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
        alert('This browser does not support notifications.');
        return;
    }
    const perm = await Notification.requestPermission();
    const btn = document.getElementById('notif-bell-btn');
    if (perm === 'granted') {
        if (btn) { btn.classList.add('granted'); btn.title = 'Notifications enabled ✅'; }
        await saveNotificationToken();
        showToast('🔔 Notifications enabled!', 'success');
    } else {
        showToast('Notifications blocked. Please enable in browser settings.', 'warn');
    }
};

// ── Save FCM/Push token to Firestore ──
async function saveNotificationToken() {
    if (!currentUser) return;
    try {
        const reg = window._swReg || await navigator.serviceWorker.ready;
        if (!reg.pushManager) return;

        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            if (VAPID_PUBLIC_KEY === 'BBIaVXF1wlqwE_41UCqmXQpi89u0tIt5UUHjibouttw0b_BE-Xt7EmTaNaP8JY0wYH279aiWlUVSQ2w6zbr00Tc') return; // not configured yet
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }
        // Save subscription to Firestore under user doc
        await db.collection('users').doc(currentUser.uid).update({
            pushSubscription: JSON.stringify(sub),
            notifEnabled: true,
            notifUpdatedAt: new Date().toISOString()
        });
        console.log('Push subscription saved.');
    } catch (err) {
        console.warn('Push subscription failed:', err);
    }
}

// ── Show toast notification (in-app) ──
function showToast(msg, type = 'info') {
    const existing = document.getElementById('sadhana-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'sadhana-toast';
    const bg = type === 'success' ? '#16a34a' : type === 'warn' ? '#d97706' : type === 'error' ? '#dc2626' : '#1A3C5E';
    toast.style.cssText = `
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:${bg}; color:white; padding:12px 22px; border-radius:12px;
        font-size:14px; font-weight:600; z-index:9999; box-shadow:0 4px 16px rgba(0,0,0,0.2);
        max-width:90vw; text-align:center; transition:opacity 0.4s;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 3500);
}

// ── In-app notification sender (for admin actions) ──
// Called after admin does role changes, promotions etc.
async function sendInAppNotification(userId, title, body) {
    try {
        await db.collection('notifications').add({
            userId,
            title,
            body,
            read: false,
            createdAt: new Date().toISOString()
        });
    } catch (err) {
        console.warn('Notification save failed:', err);
    }
}

// ── Check unread notifications for current user ──
async function loadUserNotifications() {
    if (!currentUser) return;
    try {
        const snap = await db.collection('notifications')
            .where('userId', '==', currentUser.uid)
            .where('read', '==', false)
            .orderBy('createdAt', 'desc')
            .limit(10)
            .get();

        const count = snap.docs.length;
        // Update sidebar badge
        const badge = document.getElementById('sidebar-notif-badge');
        if (badge) {
            if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
            else { badge.classList.add('hidden'); }
        }

        if (count > 0) {
            // Show latest notification as toast
            const latest = snap.docs[0].data();
            showToast(`${latest.title}: ${latest.body}`, 'info');
            // Mark all as read
            snap.docs.forEach(d => d.ref.update({ read: true }));
        }
    } catch (err) {
        // notifications collection may not exist yet — silent fail
    }
}

// ── Sadhana fill reminder check (runs on dashboard load) ──
async function checkSadhanaReminder() {
    if (!currentUser) return;
    try {
        const today = localDateStr(0);
        const yesterday = localDateStr(1);
        const dayBefore = localDateStr(2);

        const snap = await db.collection('users').doc(currentUser.uid)
            .collection('sadhana')
            .where(firebase.firestore.FieldPath.documentId(), 'in', [today, yesterday, dayBefore])
            .get();

        const submitted = new Set(snap.docs.map(d => d.id));
        const missedDays = [yesterday, dayBefore].filter(d => !submitted.has(d) && d >= APP_START);

        if (missedDays.length >= 2 && Notification.permission === 'granted') {
            new Notification('🙏 Sadhana Reminder', {
                body: `You haven't filled Sadhana for ${missedDays.length} days. Please submit now.`,
                icon: ''
            });
        }

        if (missedDays.length >= 2) {
            showToast(`⚠️ Sadhana pending for ${missedDays.length} days — please fill now!`, 'warn');
        }
    } catch (err) {
        console.warn('Reminder check failed:', err);
    }
}

// ── Hook into admin role change — send notification ──
// Called after handleRoleDropdown updates Firestore
window._sendRoleNotification = async (userId, userName, newRole, category) => {
    let msg = '';
    if (newRole === 'superAdmin') msg = 'You have been promoted to Super Admin!';
    else if (newRole === 'admin' && category) msg = `You have been made Admin — ${category.replace(' Coordinator','')}`;
    else if (newRole === 'user') msg = 'Your admin role has been updated.';
    else if (newRole === 'sb') msg = 'You have been moved to Senior Batch.';

    if (msg) await sendInAppNotification(userId, '👑 Role Update', msg);
};

// ── Init notifications on dashboard load ──
window._initNotifications = () => {
    loadUserNotifications();
    checkSadhanaReminder();
    const adminBtn = document.getElementById('admin-menu-btn');
    if (adminBtn && isAnyAdmin()) adminBtn.classList.remove('hidden');
};

// USER SIDEBAR
window.openUserSidebar = () => {
    document.getElementById('user-sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    if (typeof userProfile !== 'undefined' && userProfile) {
        const n = document.getElementById('sidebar-user-name');
        const r = document.getElementById('sidebar-user-role');
        if (n) n.textContent = userProfile.name || '';
        if (r) r.textContent = userProfile.role === 'superAdmin' ? '👑 Super Admin'
            : userProfile.role === 'deptAdmin' ? `🛡️ Dept Admin — ${userProfile.department||''}`
            : userProfile.role === 'teamLeader' ? `👥 Team Leader — ${userProfile.team||''}`
            : `${userProfile.level||'Level-1'} | ${userProfile.department||''} | ${userProfile.team||''}`;
    }
    const bellIcon = document.getElementById('sidebar-bell-icon');
    const bellLabel = document.getElementById('sidebar-bell-label');
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        if (bellIcon) bellIcon.textContent = '✅';
        if (bellLabel) bellLabel.textContent = 'Notifications Enabled';
    }
};
window.closeUserSidebar = () => {
    document.getElementById('user-sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
    document.body.style.overflow = '';
};
// openUserGuide is defined inline in index.html (handles level-based tab jumping)
window.openAbout = () => { document.getElementById('about-modal').classList.remove('hidden'); };
window.closeNotificationsPanel = () => { document.getElementById('notifications-modal').classList.add('hidden'); };
window.openNotificationsPanel = async () => {
    document.getElementById('notifications-modal').classList.remove('hidden');
    if (!currentUser) return;
    try {
        const snap = await db.collection('notifications').where('userId','==',currentUser.uid).orderBy('createdAt','desc').limit(20).get();
        const list = document.getElementById('notifications-list');
        if (!list) return;
        if (snap.empty) { list.innerHTML = '<p style="color:gray;text-align:center;padding:20px 0;font-size:13px;">No notifications yet</p>'; return; }
        list.innerHTML = snap.docs.map(d => { const n=d.data(); const u=!n.read; return '<div style="padding:10px 12px;border-radius:8px;margin-bottom:6px;background:'+(u?'#eff6ff':'#f9fafb')+';border-left:3px solid '+(u?'#3b82f6':'#e5e7eb')+';"><div style="font-weight:600;font-size:13px;">'+( n.title||'')+'</div><div style="font-size:12px;color:#555;margin-top:2px;">'+(n.body||'')+'</div><div style="font-size:10px;color:gray;margin-top:4px;">'+(n.createdAt||'').slice(0,10)+'</div></div>'; }).join('');
        snap.docs.forEach(d => { if (!d.data().read) d.ref.update({read:true}); });
        const badge = document.getElementById('sidebar-notif-badge');
        if (badge) badge.classList.add('hidden');
    } catch(e) { console.warn(e); }
};

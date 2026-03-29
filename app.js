// ═══════════════════════════════════════════════════════════
// 1. FIREBASE SETUP
// ═══════════════════════════════════════════════════════════
const firebaseConfig = {
    apiKey: "AIzaSyDbRy8ZMJAWeTyZVnTphwRIei6jAckagjA",
    authDomain: "sadhana-tracker-b65ff.firebaseapp.com",
    projectId: "sadhana-tracker-b65ff",
    storageBucket: "sadhana-tracker-b65ff.firebasestorage.app",
    messagingSenderId: "926961218888",
    appId: "1:926961218888:web:db8f12ef8256d13f036f7d"
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
const isCategoryAdmin = () => userProfile?.role === 'admin';
const isAnyAdmin      = () => isSuperAdmin() || isCategoryAdmin();
const visibleCategories = () => {
    if (isSuperAdmin()) return ['Senior Batch','IGF Co-ordinator','IYF Co-ordinator','ICF Coordinator'];
    if (isCategoryAdmin()) {
        // Old admins with "IGF & IYF Coordinator" see both new categories
        if (userProfile.adminCategory === 'IGF & IYF Coordinator') return ['IGF Co-ordinator','IYF Co-ordinator'];
        return [userProfile.adminCategory];
    }
    return [];
};

// HTML-escape to prevent XSS when inserting user data into innerHTML
const _escDiv = document.createElement('div');
function esc(s) { _escDiv.textContent = s || ''; return _escDiv.innerHTML; }

// NR penalty based on level (Senior Batch gets extra -5 for notes)
function nrPenalty(level) { return level === 'Senior Batch' ? -35 : -30; }

// ═══════════════════════════════════════════════════════════
// 3. HELPERS
// ═══════════════════════════════════════════════════════════
const t2m = (t, isSleep = false) => {
    if (!t || t === 'NR') return 9999;
    let [h, m] = t.split(':').map(Number);
    if (isSleep && h >= 0 && h <= 3) h += 24;
    return h * 60 + m;
};

// Convert stored HH:MM → 12-hour display (e.g. "22:30" → "10:30 PM"). Display-only — never used for scoring.
function fmt12(t) {
    if (!t || t === 'NR') return 'NR';
    const parts = t.split(':');
    if (parts.length < 2) return t;
    const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return t;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Show 12-hour hint below a time input. Called via oninput on each time field.
window.updateTimeHint = (inputId, hintId) => {
    const val  = document.getElementById(inputId)?.value;
    const hint = document.getElementById(hintId);
    if (!hint) return;
    hint.textContent = val ? fmt12(val) : '';
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

function getNRData(date, level) {
    const isSB = level === 'Senior Batch';
    const notesScore = isSB ? -5 : 0;
    const total = -30 + notesScore; // sleep(-5)+wake(-5)+chant(-5)+read(-5)+hear(-5)+service(-5) + notes
    return {
        id: date, totalScore: total, dayPercent: Math.round((total/160)*100),
        sleepTime:'NR', wakeupTime:'NR', chantingTime:'NR',
        readingMinutes:0, hearingMinutes:0, serviceMinutes:0, notesMinutes:0, daySleepMinutes:0,
        scores:{ sleep:-5, wakeup:-5, chanting:-5, reading:-5, hearing:-5, service:-5, notes:notesScore, daySleep:0 }
    };
}

// Pre-join placeholder — no penalties, just dashes
function getPreJoinData(date) {
    return {
        id: date, totalScore: 0, dayPercent: 0, preJoin: true,
        sleepTime:'—', wakeupTime:'—', chantingTime:'—',
        readingMinutes:0, hearingMinutes:0, serviceMinutes:0, notesMinutes:0, daySleepMinutes:0,
        scores:{ sleep:0, wakeup:0, chanting:0, reading:0, hearing:0, service:0, notes:0, daySleep:0 }
    };
}

function isPastDate(dateStr) {
    return dateStr < localDateStr(0);
}

// ─── SCORING ENGINE ───────────────────────────────────────
function calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level) {
    const sc = { sleep:-5, wakeup:-5, chanting:-5, reading:-5, hearing:-5, service:-5, notes:-5, daySleep:0 };
    const slpM = t2m(slp, true);
    sc.sleep = slpM<=1350?25:slpM<=1355?20:slpM<=1360?15:slpM<=1365?10:slpM<=1370?5:slpM<=1375?0:-5;
    const wakM = t2m(wak);
    sc.wakeup = wakM<=305?25:wakM<=310?20:wakM<=315?15:wakM<=320?10:wakM<=325?5:wakM<=330?0:-5;
    const chnM = t2m(chn);
    sc.chanting = chnM<=540?25:chnM<=570?20:chnM<=660?15:chnM<=870?10:chnM<=1020?5:chnM<=1140?0:-5;
    sc.daySleep = dsMin<=60?10:-5;
    const act = (m,thr) => m>=thr?25:m>=thr-10?20:m>=20?15:m>=15?10:m>=10?5:m>=5?0:-5;
    const isSB = level === 'Senior Batch';
    sc.reading  = act(rMin, isSB?40:30);
    sc.hearing  = act(hMin, isSB?40:30);
    let total = sc.sleep + sc.wakeup + sc.chanting + sc.reading + sc.hearing + sc.daySleep;
    if (isSB) {
        sc.service = sMin>=15?10:sMin>=10?5:sMin>=5?0:-5;
        sc.notes   = nMin>=20?15:nMin>=15?10:nMin>=10?5:nMin>=5?0:-5;
        total += sc.service + sc.notes;
    } else {
        sc.service = act(sMin, 30);
        sc.notes   = 0;
        total += sc.service;
    }
    return { sc, total, dayPercent: Math.round((total/160)*100) };
}

// ═══════════════════════════════════════════════════════════
// 4. EXCEL DOWNLOAD
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

const BORDER_THIN = { style:'thin', color:{rgb:'CCCCCC'} };
const BORDER_ALL  = { top:BORDER_THIN, bottom:BORDER_THIN, left:BORDER_THIN, right:BORDER_THIN };

function styleCell(ws, cellRef, opts = {}) {
    if (!ws[cellRef]) ws[cellRef] = { v:'', t:'s' };
    ws[cellRef].s = {
        font:      { bold: opts.bold||false, color: opts.fontColor ? {rgb: opts.fontColor} : undefined, sz: opts.sz||11, name: opts.font||'Calibri' },
        fill:      opts.fill ? { fgColor: {rgb: opts.fill}, patternType:'solid' } : undefined,
        alignment: { horizontal: opts.align||'center', vertical:'center', wrapText: opts.wrap||false },
        border:    opts.noBorder ? undefined : BORDER_ALL,
        numFmt:    opts.numFmt || undefined
    };
}

// Style an entire row
function styleRow(ws, row, cols, opts) {
    for (let c = 0; c < cols; c++) styleCell(ws, `${colLetter(c)}${row}`, opts);
}

// Style an entire range
function styleRange(ws, startRow, endRow, cols, rowStyleFn) {
    for (let r = startRow; r <= endRow; r++) {
        const opts = rowStyleFn(r);
        if (opts) for (let c = 0; c < cols; c++) styleCell(ws, `${colLetter(c)}${r}`, typeof opts === 'function' ? opts(c) : opts);
    }
}

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
        const uDoc = await db.collection('users').doc(userId).get();
        const uData = uDoc.exists ? uDoc.data() : {};
        const snap = await db.collection('users').doc(userId).collection('sadhana').get();
        if (snap.empty) { alert('No sadhna data found for this user.'); return; }
        const weeksData = {};
        snap.forEach(doc => {
            const wi = getWeekInfo(doc.id);
            if (!weeksData[wi.sunStr]) weeksData[wi.sunStr] = { label:wi.label, sunStr:wi.sunStr, days:{} };
            weeksData[wi.sunStr].days[doc.id] = doc.data();
        });
        const sortedWeeks = Object.keys(weeksData).sort((a,b) => b.localeCompare(a));
        const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const COLS = 19;
        const today = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
        const profileRows = [
            ['SADHANA TRACKER — INDIVIDUAL REPORT', ...Array(COLS-1).fill('')],
            ['', ...Array(COLS-1).fill('')],
            ['Name',          uData.name            || userName, ...Array(COLS-2).fill('')],
            ['Position Level',uData.level           || 'N/A',    ...Array(COLS-2).fill('')],
            ['Chanting Level',uData.chantingCategory|| 'N/A',    ...Array(COLS-2).fill('')],
            ['Exact Rounds',  uData.exactRounds     || 'N/A',    ...Array(COLS-2).fill('')],
            ['Downloaded On', today,                              ...Array(COLS-2).fill('')],
            ['', ...Array(COLS-1).fill('')],
        ];
        const dataArray = [...profileRows];
        const PROFILE_ROWS = profileRows.length;
        const styleMap = {};
        sortedWeeks.forEach((sunStr, wi) => {
            const week   = weeksData[sunStr];
            const wRow   = dataArray.length;
            dataArray.push([`WEEK: ${week.label}`,...Array(COLS-1).fill('')]);
            styleMap[wRow] = 'weekHeader';
            const chRow  = dataArray.length;
            dataArray.push(['Date','Bed','M','Wake','M','Chant','M','Read(m)','M','Hear(m)','M','Seva(m)','M','Notes(m)','M','DaySleep(m)','M','Total','%']);
            styleMap[chRow] = 'colHeader';
            let T = { sl:0,wu:0,ch:0,rd:0,hr:0,sv:0,nt:0,ds:0, rdm:0,hrm:0,svm:0,ntm:0,dsm:0, tot:0 };
            const wStart = new Date(week.sunStr);
            for (let i = 0; i < 7; i++) {
                const cd  = new Date(wStart); cd.setDate(cd.getDate()+i);
                const ds  = cd.toISOString().split('T')[0];
                const lbl = `${DAY[i]} ${String(cd.getDate()).padStart(2,'0')}`;
                const _exJd = uData.joinedDate || APP_START;
                const e   = (ds < _exJd) ? getPreJoinData(ds) : (week.days[ds] || getNRData(ds, uData.level));
                const dRow = dataArray.length;
                T.sl+=e.scores?.sleep??0; T.wu+=e.scores?.wakeup??0; T.ch+=e.scores?.chanting??0;
                T.rd+=e.scores?.reading??0; T.hr+=e.scores?.hearing??0; T.sv+=e.scores?.service??0;
                T.nt+=e.scores?.notes??0;  T.ds+=e.scores?.daySleep??0;
                T.rdm+=e.readingMinutes||0; T.hrm+=e.hearingMinutes||0;
                T.svm+=e.serviceMinutes||0; T.ntm+=e.notesMinutes||0;
                T.dsm+=e.daySleepMinutes||0; T.tot+=e.totalScore??0;
                dataArray.push([
                    lbl,
                    fmt12(e.sleepTime||'NR'),    e.scores?.sleep??0,
                    fmt12(e.wakeupTime||'NR'),   e.scores?.wakeup??0,
                    fmt12(e.chantingTime||'NR'), e.scores?.chanting??0,
                    e.readingMinutes||0,  e.scores?.reading??0,
                    e.hearingMinutes||0,  e.scores?.hearing??0,
                    e.serviceMinutes||0,  e.scores?.service??0,
                    e.notesMinutes||0,    e.scores?.notes??0,
                    e.daySleepMinutes||0, e.scores?.daySleep??0,
                    e.totalScore??0, (e.dayPercent??0)+'%'
                ]);
                styleMap[dRow] = e.preJoin ? 'data' : (e.sleepTime === 'NR') ? 'nr' : 'data';
            }
            const fd      = fairDenominator(week.sunStr, Object.entries(week.days).map(([id,d])=>({id,sleepTime:d.sleepTime||''})), uData.joinedDate);
            const pct     = Math.round((T.tot/fd)*100);
            const totRow  = dataArray.length;
            dataArray.push(['WEEKLY TOTAL','',T.sl,'',T.wu,'',T.ch,T.rdm,T.rd,T.hrm,T.hr,T.svm,T.sv,T.ntm,T.nt,T.dsm,T.ds,T.tot,pct+'%']);
            styleMap[totRow] = 'total';
            const sumRow  = dataArray.length;
            dataArray.push([`WEEKLY %: ${T.tot} / ${fd} = ${pct}%`,...Array(COLS-1).fill('')]);
            styleMap[sumRow] = 'summary';
            if (wi < sortedWeeks.length-1) {
                dataArray.push(Array(COLS).fill(''));
                dataArray.push(Array(COLS).fill(''));
            }
        });
        const ws = XLSX.utils.aoa_to_sheet(dataArray);
        ws['!cols'] = [10,8,4,8,4,8,4,9,4,9,4,9,4,9,4,11,4,8,6].map(w=>({wch:w}));
        const merges = [];
        merges.push({s:{r:0,c:0}, e:{r:0,c:COLS-1}});
        for (let r=2;r<=6;r++) merges.push({s:{r,c:1}, e:{r,c:COLS-1}});
        Object.entries(styleMap).forEach(([rStr, type]) => {
            const r = parseInt(rStr);
            if (type==='weekHeader' || type==='summary') merges.push({s:{r,c:0}, e:{r,c:COLS-1}});
        });
        ws['!merges'] = merges;
        styleCell(ws, 'A1', { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:13, align:'center' });
        for (let r=2;r<=6;r++) {
            styleCell(ws, `A${r+1}`, { bold:true, fill:'EBF3FB', align:'left' });
            styleCell(ws, `B${r+1}`, { align:'left' });
        }
        Object.entries(styleMap).forEach(([rStr, type]) => {
            const r    = parseInt(rStr);
            const rNum = r + 1;
            if (type === 'weekHeader') {
                for (let c=0;c<COLS;c++) styleCell(ws, `${colLetter(c)}${rNum}`, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:12, align:'center' });
            } else if (type === 'colHeader') {
                for (let c=0;c<COLS;c++) styleCell(ws, `${colLetter(c)}${rNum}`, { bold:true, fill:'2E86C1', fontColor:'FFFFFF', sz:10, align:'center' });
            } else if (type === 'total') {
                for (let c=0;c<COLS;c++) styleCell(ws, `${colLetter(c)}${rNum}`, { bold:true, fill:'D5E8F7', align:'center' });
            } else if (type === 'summary') {
                for (let c=0;c<COLS;c++) styleCell(ws, `${colLetter(c)}${rNum}`, { bold:true, fill:'EBF3FB', fontColor:'1A3C5E', align:'center' });
            } else if (type === 'nr') {
                for (let c=0;c<COLS;c++) styleCell(ws, `${colLetter(c)}${rNum}`, { fill:'FDE8E8', fontColor:'C0392B', align:'center' });
                if (ws[`A${rNum}`]) ws[`A${rNum}`].s.alignment.horizontal = 'left';
            } else if (type === 'data') {
                styleCell(ws, `A${rNum}`, { align:'left' });
                const scoreCols = [2,4,6,8,10,12,14,16];
                for (let c=0;c<COLS;c++) {
                    const ref  = `${colLetter(c)}${rNum}`;
                    const cell = ws[ref];
                    if (!cell) continue;
                    if (scoreCols.includes(c) || c===17) {
                        const val = typeof cell.v === 'number' ? cell.v : parseFloat(cell.v)||0;
                        const fill  = val >= 20 ? 'D5F5E3' : val >= 10 ? 'FEF9E7' : val >= 0 ? 'FAD7A0' : 'FADBD8';
                        const fColor = val < 0 ? 'C0392B' : '1A252F';
                        styleCell(ws, ref, { fill, fontColor:fColor, align:'center' });
                    } else {
                        styleCell(ws, ref, { align:'center' });
                    }
                }
                const totRef = `R${rNum}`;
                if (ws[totRef]) ws[totRef].s.font.bold = true;
            }
        });
        ws['!freeze'] = { xSplit:1, ySplit:PROFILE_ROWS, topLeftCell:'B9' };
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sadhna_Weekly');
        xlsxSave(wb, `${userName.replace(/\s+/g,'_')}_Sadhna_Weekly.xlsx`);
    } catch (err) { console.error(err); alert('Download Failed: ' + err.message); }
};

window.downloadMasterReport = async () => {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded. Please refresh.'); return; }
    try {
        const usersSnap = await db.collection('users').get();
        const cats = visibleCategories();
        const userData = [];
        const weekMap = new Map();
        for (const uDoc of usersSnap.docs) {
            const u = uDoc.data();
            if (!cats.includes(u.level||'Senior Batch')) continue;
            const sSnap = await uDoc.ref.collection('sadhana').get();
            const entries = sSnap.docs.map(d=>({date:d.id, score:d.data().totalScore||0, sleepTime:d.data().sleepTime||''}));
            entries.forEach(en => { const wi = getWeekInfo(en.date); weekMap.set(wi.sunStr, wi.label); });
            userData.push({ user:u, entries });
        }
        userData.sort((a,b)=>(a.user.name||'').localeCompare(b.user.name||''));
        const allWeeks = Array.from(weekMap.entries()).sort((a,b) => b[0].localeCompare(a[0])).map(([sunStr, label]) => ({ sunStr, label }));
        const rows = [['User Name','Position Level','Chanting Category',...allWeeks.map(w=>w.label.replace('_',' '))]];
        userData.forEach(({user,entries}) => {
            const row = [user.name, user.level||'Senior Batch', user.chantingCategory||'Level-1'];
            const mJd = user.joinedDate || APP_START;
            allWeeks.forEach(({ sunStr }) => {
                let tot = 0; const masterWeekEnts = [];
                const wSun = new Date(sunStr);
                const todayM = localDateStr(0);
                for (let i=0;i<7;i++) {
                    const c  = new Date(wSun); c.setDate(c.getDate()+i);
                    const ds = c.toISOString().split('T')[0];
                    if (ds < mJd) continue; // skip pre-join dates
                    if (ds > todayM) break;  // skip future dates
                    const en = entries.find(e=>e.date===ds);
                    if (en) { tot += en.score; masterWeekEnts.push({id:ds,sleepTime:en.sleepTime||''}); }
                    else if (ds < todayM) { tot += nrPenalty(user.level); } // only penalize past dates
                }
                const mfd = fairDenominator(wSun, masterWeekEnts, mJd);
                const pct = Math.round((tot/mfd)*100);
                row.push(pct < 0 ? `(${Math.abs(pct)}%)` : `${pct}%`);
            });
            rows.push(row);
        });
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const hCols = rows[0].length;
        for (let c = 0; c < hCols; c++) {
            styleCell(ws, `${colLetter(c)}1`, { bold:true, fill:'1A3C5E', fontColor:'FFFFFF', sz:11, align: c===0 ? 'left' : 'center' });
        }
        for (let r = 1; r < rows.length; r++) {
            const stripeBg = r % 2 === 0 ? 'F8FAFC' : 'FFFFFF';
            for (let c = 0; c < 3; c++) styleCell(ws, `${colLetter(c)}${r+1}`, { fill: stripeBg, align:'left', bold: c===0 });
            for (let c = 3; c < rows[r].length; c++) {
                const ref  = `${colLetter(c)}${r+1}`;
                const cell = ws[ref];
                if (!cell) continue;
                const raw  = parseInt(String(cell.v).replace('%','').replace('(','').replace(')','')) || 0;
                const isNeg = String(cell.v).includes('(');
                const pct  = isNeg ? -Math.abs(raw) : raw;
                let fill = stripeBg, fontColor = '1A252F', bold = false;
                if (pct < 0)   { fill = 'FFFDE7'; fontColor = 'B91C1C'; bold = true; }
                else if (pct < 20) { fill = 'FFFDE7'; fontColor = 'B91C1C'; bold = true; }
                else if (pct >= 70){ fontColor = '15803D'; bold = true; }
                styleCell(ws, ref, { fill, fontColor, bold, align:'center' });
            }
        }
        ws['!cols'] = [{ wch:22 }, { wch:16 }, { wch:12 }, ...Array(allWeeks.length).fill({ wch:18 })];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Master_Report');
        xlsxSave(wb, 'Master_Sadhna_Report.xlsx');
    } catch (err) { console.error(err); alert('Download Failed: ' + err.message); }
};

// Category-wise Excel: one file per category, each user as a separate sheet
window.downloadCategoryExcel = async (category) => {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded. Please refresh.'); return; }
    const catLabel = category.replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB');
    try {
        const usersSnap = await db.collection('users').get();
        const catUsers = usersSnap.docs
            .filter(d => (d.data().level || 'Senior Batch') === category)
            .sort((a, b) => (a.data().name || '').localeCompare(b.data().name || ''));

        if (!catUsers.length) { alert('No users found in ' + catLabel); return; }

        const wb = XLSX.utils.book_new();
        const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

        for (const uDoc of catUsers) {
            const u = uDoc.data();
            const sSnap = await uDoc.ref.collection('sadhana').get();
            if (sSnap.empty) continue;

            const weeksData = {};
            sSnap.forEach(doc => {
                if (doc.id < APP_START) return;
                const d = doc.data(); const wi = getWeekInfo(doc.id);
                if (!weeksData[wi.label]) weeksData[wi.label] = { sunStr: wi.sunStr, label: wi.label, days: {} };
                weeksData[wi.label].days[doc.id] = d;
            });

            const sortedWeeks = Object.keys(weeksData).sort((a, b) => weeksData[b].sunStr.localeCompare(weeksData[a].sunStr));
            const uJd = u.joinedDate || APP_START;
            const todayE = localDateStr(0);
            const rows = [
                ['Name', u.name || ''], ['Level', u.level || ''], ['Chanting', u.chantingCategory || ''],
                ['Rounds', u.exactRounds || ''], ['Joined', uJd], ['']
            ];

            sortedWeeks.forEach(wLabel => {
                const week = weeksData[wLabel];
                rows.push([`WEEK: ${wLabel.replace('_',' ')}`]);
                rows.push(['Date','Bed','M','Wake','M','Chant','M','Read(m)','M','Hear(m)','M','Seva(m)','M','Notes(m)','M','DaySleep(m)','M','Total','%']);
                let tot = 0;
                const wStart = new Date(week.sunStr);
                const weekEnts = [];
                for (let i = 0; i < 7; i++) {
                    const cd = new Date(wStart); cd.setDate(cd.getDate() + i);
                    const ds = cd.toISOString().split('T')[0];
                    if (ds > todayE) continue;
                    const lbl = `${DAY[i]} ${String(cd.getDate()).padStart(2,'0')}`;
                    if (ds < uJd) {
                        rows.push([lbl, '—','—','—','—','—','—','—','—','—','—','—','—','—','—','—','—','—','Not joined']);
                        continue;
                    }
                    const e = week.days[ds];
                    if (e) {
                        const sc = e.scores || {};
                        tot += e.totalScore || 0;
                        weekEnts.push({ id: ds, sleepTime: e.sleepTime || '' });
                        rows.push([lbl, fmt12(e.sleepTime||'NR'), sc.sleep??0, fmt12(e.wakeupTime||'NR'), sc.wakeup??0,
                            fmt12(e.chantingTime||'NR'), sc.chanting??0, e.readingMinutes||0, sc.reading??0,
                            e.hearingMinutes||0, sc.hearing??0, e.serviceMinutes||0, sc.service??0,
                            e.notesMinutes||0, sc.notes??0, e.daySleepMinutes||0, sc.daySleep??0,
                            e.totalScore||0, (e.dayPercent||0)+'%']);
                    } else {
                        const _nrP = nrPenalty(u.level);
                        const _nrN = u.level === 'Senior Batch' ? -5 : 0;
                        tot += _nrP;
                        rows.push([lbl, 'NR',-5,'NR',-5,'NR',-5,0,-5,0,-5,0,-5,0,_nrN,0,0,_nrP,Math.round((_nrP/160)*100)+'%']);
                    }
                }
                const fd = fairDenominator(week.sunStr, weekEnts, uJd);
                const pct = Math.round((tot / fd) * 100);
                rows.push(['TOTAL','','','','','','','','','','','','','','','','', tot, pct + '%']);
                rows.push(['']);
            });

            const ws = XLSX.utils.aoa_to_sheet(rows);
            const COLS = 19;
            ws['!cols'] = [{ wch: 12 }, ...Array(COLS - 1).fill({ wch: 10 })];

            // Apply formatting row by row
            for (let r = 0; r < rows.length; r++) {
                const rv = rows[r];
                const rowNum = r + 1;
                if (r < 5 && rv.length >= 2) {
                    // Profile rows: label bold, value normal
                    styleCell(ws, `A${rowNum}`, { bold: true, fill: '1A3C5E', fontColor: 'FFFFFF', align: 'left' });
                    styleCell(ws, `B${rowNum}`, { align: 'left', fill: 'EEF2F7' });
                } else if (typeof rv[0] === 'string' && rv[0].startsWith('WEEK:')) {
                    // Week header row: dark blue fill, white bold text
                    for (let c = 0; c < COLS; c++) styleCell(ws, `${colLetter(c)}${rowNum}`, { bold: true, fill: '1A3C5E', fontColor: 'FFFFFF', align: 'left', sz: 11 });
                } else if (rv[0] === 'Date') {
                    // Column header row: medium blue fill
                    for (let c = 0; c < COLS; c++) styleCell(ws, `${colLetter(c)}${rowNum}`, { bold: true, fill: '3B82F6', fontColor: 'FFFFFF', sz: 10 });
                    styleCell(ws, `A${rowNum}`, { bold: true, fill: '3B82F6', fontColor: 'FFFFFF', align: 'left', sz: 10 });
                } else if (rv[0] === 'TOTAL') {
                    // Total row: green-tinted bold
                    for (let c = 0; c < COLS; c++) styleCell(ws, `${colLetter(c)}${rowNum}`, { bold: true, fill: 'DCFCE7', sz: 11 });
                    styleCell(ws, `A${rowNum}`, { bold: true, fill: 'DCFCE7', align: 'left', sz: 11 });
                } else if (rv.length >= 3 && rv[1] === 'NR') {
                    // NR row: red tint
                    for (let c = 0; c < COLS; c++) styleCell(ws, `${colLetter(c)}${rowNum}`, { fill: 'FFF5F5', fontColor: 'B91C1C' });
                    styleCell(ws, `A${rowNum}`, { fill: 'FFF5F5', fontColor: 'B91C1C', align: 'left', bold: true });
                } else if (rv.length >= 3 && rv[1] === '—') {
                    // Pre-join row: grey
                    for (let c = 0; c < COLS; c++) styleCell(ws, `${colLetter(c)}${rowNum}`, { fill: 'F3F4F6', fontColor: 'B0B5BC' });
                    styleCell(ws, `A${rowNum}`, { fill: 'F3F4F6', fontColor: 'B0B5BC', align: 'left' });
                } else if (rv.length >= COLS) {
                    // Data row: alternate stripe
                    const stripe = (r % 2 === 0) ? 'FFFFFF' : 'F8FAFC';
                    for (let c = 0; c < COLS; c++) styleCell(ws, `${colLetter(c)}${rowNum}`, { fill: stripe });
                    styleCell(ws, `A${rowNum}`, { fill: stripe, align: 'left', bold: true });
                    // Color the score columns (negative = red, high = green)
                    [2,4,6,8,10,12,14,16].forEach(sc => {
                        const val = rv[sc];
                        if (typeof val === 'number') {
                            const fc = val < 0 ? 'DC2626' : val >= 20 ? '15803D' : undefined;
                            if (fc) styleCell(ws, `${colLetter(sc)}${rowNum}`, { fill: stripe, fontColor: fc, bold: val < 0 });
                        }
                    });
                    // Total column
                    const totalVal = rv[17];
                    if (typeof totalVal === 'number') {
                        const fc = totalVal < 0 ? 'DC2626' : totalVal >= 112 ? '15803D' : undefined;
                        styleCell(ws, `${colLetter(17)}${rowNum}`, { fill: stripe, bold: true, fontColor: fc || undefined });
                    }
                }
            }

            const sheetName = (u.name || uDoc.id).slice(0, 31);
            XLSX.utils.book_append_sheet(wb, ws, sheetName);
        }

        xlsxSave(wb, `Sadhna_${catLabel}_Report.xlsx`);
    } catch (err) { console.error(err); alert('Download Failed: ' + err.message); }
};

// ═══════════════════════════════════════════════════════════
// 5. AUTH
// ═══════════════════════════════════════════════════════════

// Wipe ALL cached state — called on every sign-in/sign-out to prevent data leaking between accounts
function resetAppState() {
    // WCR / admin panel caches
    _userWCRLoaded    = false;
    adminPanelLoaded  = false;
    window._wcrUserList       = [];
    window._adminCmpUserList  = [];
    window._adminSadhanaCache = new Map();
    window._inactiveUsers     = [];
    // Performance analytics
    _perfAllData  = [];
    _perfYear     = null;
    _perfMonth    = null;
    _perfWeekIdx  = 0;
    _activeFilter = '';
    // Leaderboard
    _lbLoading          = false;
    _lbCategoryFilter   = '';
    _lbMode             = 'current-week';
    _homeWeekOffset     = 0;
    _sSadhanaTab        = 'entry';
    // Activity Analysis
    if (_aaChartDonut) { try { _aaChartDonut.destroy(); } catch(e){} _aaChartDonut = null; }
    if (_aaChartBar)   { try { _aaChartBar.destroy();   } catch(e){} _aaChartBar   = null; }
    _aaUID = null; _aaName = null;
    // Charts — destroy to prevent canvas reuse errors
    if (myChartInstance)    { try { myChartInstance.destroy();    } catch(e){} myChartInstance    = null; }
    if (modalChartInstance) { try { modalChartInstance.destroy(); } catch(e){} modalChartInstance = null; }
    // Bottom nav
    const ubn = document.getElementById('user-bottom-nav');
    const sbn = document.getElementById('sa-bottom-nav');
    if (ubn) ubn.classList.remove('visible');
    if (sbn) sbn.classList.remove('visible');
    document.body.classList.remove('has-bottom-nav');
    // Active Firestore real-time listener
    if (activeListener) { activeListener(); activeListener = null; }
    // Edit / reject modal state
    editModalUserId = null; editModalDate = null; editModalOriginal = null;
    _rejectState    = null;
    _uacUID = null; _uacName = null;
    window._profilePicDataUrl = null;
}

let _profileUnsub = null;
auth.onAuthStateChanged((user) => {
    if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }
    resetAppState(); // always wipe stale state before loading any account
    if (user) {
        currentUser = user;
        let _dashboardInited = false;
        _profileUnsub = db.collection('users').doc(user.uid).onSnapshot(docSnap => {
            if (!docSnap.exists) { showSection('profile'); return; }
            userProfile = docSnap.data();
            if (!userProfile.level && userProfile.role !== 'superAdmin') {
                document.getElementById('profile-title').textContent    = 'Complete Your Profile';
                document.getElementById('profile-subtitle').textContent = 'Please fill in your details to continue';
                document.getElementById('profile-name').value           = userProfile.name || '';
                showSection('profile');
                return;
            }
            // Prompt old users with "IGF & IYF Coordinator" to pick IGF or IYF
            if (userProfile.level === 'IGF & IYF Coordinator') {
                document.getElementById('profile-title').textContent    = 'Update Your Position';
                document.getElementById('profile-subtitle').textContent = 'IGF & IYF has been split — please select whether you are IGF or IYF';
                document.getElementById('profile-name').value           = userProfile.name || '';
                document.getElementById('profile-level').value          = '';
                document.getElementById('profile-chanting').value       = userProfile.chantingCategory || '';
                document.getElementById('profile-exact-rounds').value   = userProfile.exactRounds || '';
                showSection('profile');
                return;
            }
            if (!_dashboardInited) {
                _dashboardInited = true;
                initDashboard();
            } else {
                refreshFormFields();
            }
        });
    } else {
        currentUser = null;
        userProfile = null;
        showSection('auth');
    }
});

// ═══════════════════════════════════════════════════════════
// 6. INIT DASHBOARD — permanent, clean logic
// ═══════════════════════════════════════════════════════════
function initDashboard() {
    const roleLabel = isSuperAdmin() ? '👑 Super Admin'
                    : isCategoryAdmin() ? `🛡️ Admin — ${userProfile.adminCategory}`
                    : (userProfile.level || 'Senior Batch');
    document.getElementById('user-display-name').textContent = userProfile.name;
    document.getElementById('user-role-display').textContent = roleLabel;
    updateAvatarDisplay(userProfile.photoURL || null, userProfile.name || '');
    showSection('dashboard');

    const userTabs = document.getElementById('user-nav-tabs');
    const saTabs   = document.getElementById('sa-nav-tabs');
    const adminBtn = document.getElementById('admin-menu-btn');

    const userBnav = document.getElementById('user-bottom-nav');
    const saBnav   = document.getElementById('sa-bottom-nav');

    if (isSuperAdmin()) {
        // SuperAdmin: SA bottom nav, admin panel — no home/sadhna panels
        if (userTabs) userTabs.style.display = 'none';
        if (saTabs)   saTabs.style.display   = 'none';
        if (adminBtn) adminBtn.classList.add('hidden');
        if (userBnav) userBnav.classList.remove('visible');
        if (saBnav)   saBnav.classList.add('visible');
        document.body.classList.add('has-bottom-nav');
        // Explicitly force-hide user panels (safety against cached active class)
        ['home-panel','mysadhana-panel','team-panel'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.classList.remove('active'); el.style.display = 'none'; }
        });
        // SA doesn't do tasks — hide tasks bell in header
        const tasksBtn = document.getElementById('header-tasks-btn');
        if (tasksBtn) tasksBtn.style.display = 'none';
        const adminSubNav = document.getElementById('admin-sub-nav');
        if (adminSubNav) adminSubNav.style.display = 'none';
        switchTab('admin');
        adminPanelLoaded = true;
        loadAdminPanel();
        document.querySelectorAll('.sa-lvl-bar').forEach(b => b.style.display = 'flex');
        // Default to Home sub-panel
        saTab('home', null);
    } else {
        // Regular user or category admin — user bottom nav
        if (userTabs) userTabs.style.display = 'none'; // replaced by bottom nav
        if (saTabs)   saTabs.style.display   = 'none';
        if (saBnav)   saBnav.classList.remove('visible');
        if (userBnav) userBnav.classList.add('visible');
        document.body.classList.add('has-bottom-nav');
        // Show Manage tab for category admins
        const manageBtn = document.getElementById('bnav-manage');
        if (manageBtn) manageBtn.style.display = isAnyAdmin() ? '' : 'none';
        // Show Team > WCR sub-tab for everyone (users see their category only)
        const teamWcrBtn = document.getElementById('team-btn-wcr');
        if (teamWcrBtn) teamWcrBtn.classList.remove('hidden');
        // Gear button no longer needed (Manage tab replaces drawer for nav)
        if (adminBtn) adminBtn.classList.add('hidden');
        // Ensure user panels are visible (might be force-hidden from prior SA session)
        ['home-panel','mysadhana-panel','team-panel'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
        // Show tasks bell for regular users
        const tasksBtnU = document.getElementById('header-tasks-btn');
        if (tasksBtnU) tasksBtnU.style.display = '';
        setupDateSelect();
        refreshFormFields();
        switchTab('home');
    }
    if (window._initNotifications) window._initNotifications();
}

// ═══════════════════════════════════════════════════════════
// 7. NAVIGATION
// ═══════════════════════════════════════════════════════════

// ── Load WCR for regular users/category admins ────────────
let _userWCRLoaded = false;
async function loadUserWCR() {
    const container = document.getElementById('user-wcr-container');
    if (!container) return;
    if (_userWCRLoaded) return; // already loaded
    _userWCRLoaded = true;
    container.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';

    const usersSnap = await db.collection('users').get();
    const cats      = visibleCategories();
    // Normal users (non-admin) see their own level's data to enable competition
    const levelFilter = cats.length > 0 ? cats : [userProfile.level || 'Senior Batch'];
    const filtered  = usersSnap.docs
        .filter(doc => levelFilter.includes(doc.data().level||'Senior Batch'))
        .sort((a,b) => (a.data().name||'').localeCompare(b.data().name||''));

    const weeks = [];
    for (let i=0;i<4;i++) {
        const d=new Date(); d.setDate(d.getDate()-i*7);
        weeks.push(getWeekInfo(d.toISOString().split('T')[0]));
    }
    weeks.reverse();

    const pctStyle = (pct) => {
        if (pct < 0)   return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`(${pct}%)` };
        if (pct < 20)  return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`${pct}%`   };
        if (pct >= 70) return { bg:'',        color:'#15803d', bold:true, text:`${pct}%`   };
        return              { bg:'',        color:'#1a252f', bold:false, text:`${pct}%`  };
    };

    const sadhanaCache = new Map();

    window._wcrUserList = [];

    let tHtml = `<div style="overflow-x:auto;"><table class="comp-table" style="min-width:500px;">
        <thead><tr>
            <th class="comp-th comp-th-name">Name</th>
            <th class="comp-th">Level</th>
            ${weeks.map(w=>`<th class="comp-th">${w.label.split('_')[0]}</th>`).join('')}
        </tr></thead><tbody>`;

    // Fetch all sadhana subcollections in parallel (was sequential — big speed gain)
    const allSnaps = await Promise.all(filtered.map(uDoc => uDoc.ref.collection('sadhana').get()));

    filtered.forEach((uDoc, rowIdx) => {
        const u     = uDoc.data();
        const sSnap = allSnaps[rowIdx];
        const ents  = sSnap.docs.map(d=>({date:d.id, score:d.data().totalScore||0, sleepTime:d.data().sleepTime||'', scores:d.data().scores||{}}));
        sadhanaCache.set(uDoc.id, ents);

        const stripeBg = rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
        const lvlShort = (u.level||'SB').replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB');

        const wcrIdx = window._wcrUserList.length;
        window._wcrUserList.push({ uid: uDoc.id, name: u.name||'', level: u.level||'', chanting: u.chantingCategory||'', rounds: u.exactRounds||'0', role: u.role||'user' });

        const nameClick = isAnyAdmin()
            ? ` onclick="openWCRUser(${wcrIdx})" style="cursor:pointer;" title="View ${u.name||'user'}"`
            : '';
        tHtml += `<tr style="background:${stripeBg}">
            <td class="comp-td comp-name"${nameClick}>${u.name}</td>
            <td class="comp-td comp-meta">${lvlShort}</td>`;

        const uJoined = u.joinedDate || APP_START;
        weeks.forEach(w => {
            let tot=0; const weekEnts=[]; const todayC = localDateStr(0);
            let curr=new Date(w.sunStr);
            for (let i=0;i<7;i++) {
                const ds=curr.toISOString().split('T')[0];
                if (ds < APP_START || ds > todayC || ds < uJoined) { curr.setDate(curr.getDate()+1); continue; }
                const en=ents.find(e=>e.date===ds);
                if (en) { tot += en.score; weekEnts.push({id:ds,sleepTime:en.sleepTime||''}); }
                else if (ds < todayC) { tot += nrPenalty(u.level); }
                curr.setDate(curr.getDate()+1);
            }
            const fd  = fairDenominator(w.sunStr, weekEnts, uJoined);
            const pct = Math.round((tot/fd)*100);
            const ps  = pctStyle(pct);
            const pf  = `<span class="pf-badge ${pct>=50?'pf-pass':'pf-fail'}" style="margin-left:4px;">${pct>=50?'P':'F'}</span>`;
            tHtml += `<td class="comp-td comp-pct" style="background:${ps.bg||stripeBg};color:${ps.color};font-weight:${ps.bold?'700':'400'};" title="${tot}/${fd}">${ps.text}${pf}</td>`;
        });
        tHtml += '</tr>';
    });
    tHtml += '</tbody></table></div>';
    container.innerHTML = tHtml;

    // Compute performers using this data
    window._adminSadhanaCache = sadhanaCache;
    // Save data for WCR re-rendering when perf filter changes
    window._wcrFilteredUsers = filtered.map(uDoc => {
        const u = uDoc.data();
        return { uid: uDoc.id, name: u.name||'', level: u.level||'', chanting: u.chantingCategory||'', rounds: u.exactRounds||'0', role: u.role||'user', joinedDate: u.joinedDate || APP_START };
    });
    window._wcrContainerId = 'user-wcr-container';
    computePerformers(filtered);
}

// Re-render WCR table for a specific month (called when perf filter changes)
function rerenderWCRForMonth(year, month) {
    const users    = window._wcrFilteredUsers;
    const cache    = window._adminSadhanaCache;
    const contId   = window._wcrContainerId || 'user-wcr-container';
    const container = document.getElementById(contId);
    if (!users || !cache || !container) return;

    // Build weeks for the selected month
    const monthStart = `${year}-${String(month+1).padStart(2,'0')}-01`;
    const monthEnd   = new Date(year, month+1, 0).toISOString().split('T')[0];
    const mStart     = new Date(monthStart);
    const mEnd       = new Date(monthEnd);
    const weeks = [];
    const cur = new Date(mStart); cur.setDate(cur.getDate() - cur.getDay()); // go to Sunday
    while (cur <= mEnd) {
        const sunStr = cur.toISOString().split('T')[0];
        const sat = new Date(cur); sat.setDate(sat.getDate()+6);
        const fmt = dt => `${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleString('en-GB',{month:'short'})}`;
        weeks.push({ sunStr, label: `${fmt(cur)} to ${fmt(sat)}_${cur.getFullYear()}` });
        cur.setDate(cur.getDate() + 7);
    }

    const pctStyle = (pct) => {
        if (pct < 0)   return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`(${pct}%)` };
        if (pct < 20)  return { bg:'#FFFDE7', color:'#b91c1c', bold:true, text:`${pct}%` };
        if (pct >= 70) return { bg:'',        color:'#15803d', bold:true, text:`${pct}%` };
        return              { bg:'',        color:'#1a252f', bold:false, text:`${pct}%` };
    };

    const todayC = localDateStr(0);
    let tHtml = `<div style="overflow-x:auto;"><table class="comp-table" style="min-width:500px;">
        <thead><tr>
            <th class="comp-th comp-th-name">Name</th>
            <th class="comp-th">Level</th>
            ${weeks.map(w=>`<th class="comp-th">${w.label.split('_')[0]}</th>`).join('')}
        </tr></thead><tbody>`;

    users.forEach((u, rowIdx) => {
        const ents = cache.get(u.uid) || [];
        const stripeBg = rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
        const lvlShort = (u.level||'SB').replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB');

        const nameClick = isAnyAdmin()
            ? ` onclick="openWCRUser(${rowIdx})" style="cursor:pointer;" title="View ${esc(u.name)}"`
            : '';
        tHtml += `<tr style="background:${stripeBg}">
            <td class="comp-td comp-name"${nameClick}>${esc(u.name)}</td>
            <td class="comp-td comp-meta">${lvlShort}</td>`;

        const uJoined = u.joinedDate || APP_START;
        weeks.forEach(w => {
            let tot=0; const weekEnts=[];
            let curr2=new Date(w.sunStr);
            for (let i=0;i<7;i++) {
                const ds=curr2.toISOString().split('T')[0];
                if (ds < APP_START || ds > todayC || ds < uJoined) { curr2.setDate(curr2.getDate()+1); continue; }
                const en=ents.find(e=>e.date===ds);
                if (en) { tot += en.score; weekEnts.push({id:ds,sleepTime:en.sleepTime||''}); }
                else if (ds < todayC) { tot += nrPenalty(u.level); }
                curr2.setDate(curr2.getDate()+1);
            }
            const fd  = fairDenominator(w.sunStr, weekEnts, uJoined);
            const pct = Math.round((tot/fd)*100);
            const ps  = pctStyle(pct);
            const pf  = `<span class="pf-badge ${pct>=50?'pf-pass':'pf-fail'}" style="margin-left:4px;">${pct>=50?'P':'F'}</span>`;
            tHtml += `<td class="comp-td comp-pct" style="background:${ps.bg||stripeBg};color:${ps.color};font-weight:${ps.bold?'700':'400'};" title="${tot}/${fd}">${ps.text}${pf}</td>`;
        });
        tHtml += '</tr>';
    });
    tHtml += '</tbody></table></div>';
    container.innerHTML = tHtml;

    // Re-apply column highlight
    setTimeout(highlightWCRColumn, 100);
}

window.switchTab = (t) => {
    // Normalise: 'manage' maps to 'admin' panel for category admins
    const panelId = t === 'manage' ? 'admin' : t;
    ['home-panel','mysadhana-panel','team-panel','admin-panel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById(panelId + '-panel');
    if (panel) panel.classList.add('active');
    // Sync user bottom nav (Home=0, Sadhana=1, Team=2, Manage=3)
    const uTabMap = { home: 0, mysadhana: 1, team: 2, manage: 3, admin: 3 };
    const uBnavItems = document.querySelectorAll('#user-bottom-nav .bnav-item');
    uBnavItems.forEach((b, i) => b.classList.toggle('active', i === (uTabMap[t] ?? -1)));
    // Load data for the tab
    if (t === 'home') {
        loadHomePanel(_homeWeekOffset);
        loadTasks();
    }
    if (t === 'team') loadLeaderboard(false);
    if (t === 'manage' || (t === 'admin' && !isSuperAdmin())) {
        // Category admin manage tab — show admin-sub-nav, load admin panel
        const subNav = document.getElementById('admin-sub-nav');
        if (subNav) subNav.style.display = 'flex';
        if (!adminPanelLoaded) { adminPanelLoaded = true; loadAdminPanel(); }
        // default to WCR sub-panel
        selectAdminSection('reports', null);
    }
};

// Sadhana tab sub-navigation (Entry | Reports | Progress)
let _sSadhanaTab = 'entry';
window.switchSadhanaTab = (sub, btn) => {
    _sSadhanaTab = sub;
    ['sadhana-entry-sub','sadhana-reports-sub','sadhana-progress-sub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    document.querySelectorAll('#mysadhana-panel .subtab-btn').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById('sadhana-' + sub + '-sub');
    if (panel) panel.classList.add('active');
    const btnEl = btn || document.getElementById('stab-' + sub);
    if (btnEl) btnEl.classList.add('active');
    if (sub === 'reports')  loadReports(currentUser.uid, 'weekly-reports-container');
    if (sub === 'progress') loadMyProgressChart('daily');
};

// Team tab sub-navigation (Rankings | WCR)
window.switchTeamTab = (sub, btn) => {
    ['team-rankings-sub','team-wcr-sub'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    document.querySelectorAll('#team-subtab-bar .subtab-btn').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById('team-' + sub + '-sub');
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
    if (sub === 'rankings') loadLeaderboard(false);
    if (sub === 'wcr')      loadUserWCR();
};

// Home week filter
let _homeWeekOffset = 0;
window.switchHomeWeek = (offset, btn) => {
    _homeWeekOffset = offset;
    document.querySelectorAll('#home-week-tabs .chart-tab-btn').forEach((b, i) =>
        b.classList.toggle('active', i === (offset === 0 ? 0 : 1)));
    loadHomePanel(offset);
};

function showSection(sec) {
    ['auth-section','profile-section','dashboard-section'].forEach(id =>
        document.getElementById(id).classList.add('hidden'));
    document.getElementById(sec+'-section').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// 7b. HOME PANEL — ring chart, streak, activity bars
// ═══════════════════════════════════════════════════════════

function drawRing(canvas, pct, color) {
    const ctx = canvas.getContext('2d');
    const cx = canvas.width / 2, cy = canvas.height / 2, r = cx - 8;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 10; ctx.stroke();
    if (pct > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (pct / 100) * Math.PI * 2);
        ctx.strokeStyle = color || '#3b82f6'; ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.stroke();
    }
}

function animateRing(canvas, targetPct, color) {
    if (!canvas) return;
    const duration = 900, start = performance.now();
    (function frame(now) {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        drawRing(canvas, targetPct * eased, color);
        if (p < 1) requestAnimationFrame(frame);
    })(start);
}

function renderStreakDots(weekDates, filledSet, todayStr) {
    const row = document.getElementById('home-streak-row');
    if (!row) return;
    const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    row.innerHTML = weekDates.map((d, i) => {
        const day = dayLabels[new Date(d + 'T00:00:00').getDay()];
        const isFilled  = filledSet.has(d);
        const isToday   = d === todayStr;
        const isFuture  = d > todayStr;
        let dotClass = 'streak-dot';
        if (isFilled) dotClass += ' filled';
        else if (!isFuture && !isToday) dotClass += ' missed';
        if (isToday) dotClass += ' today';
        return `<div class="streak-day-wrap" style="animation-delay:${i * 50}ms">
            <div class="${dotClass}"></div>
            <div class="streak-dot-label">${day}</div>
        </div>`;
    }).join('');
}

async function loadHomePanel(weekOffset) {
    if (!currentUser || isSuperAdmin()) return;
    const today = localDateStr();
    const toStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    // Build full week dates (Sun–Sat) INCLUDING today (not capped at yesterday like leaderboard)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const ws = new Date(now); ws.setDate(now.getDate() - dayOfWeek - ((weekOffset ?? 0) * 7)); ws.setHours(0,0,0,0);
    const we = new Date(ws); we.setDate(ws.getDate() + 6);
    // For current week, cap at today (not yesterday)
    if ((weekOffset ?? 0) === 0 && we > now) we.setTime(now.getTime());
    const dates = [];
    const cur = new Date(ws);
    while (cur <= we) { dates.push(toStr(cur)); cur.setDate(cur.getDate() + 1); }
    if (!dates.length) return;

    // Also fetch 7 extra days before the week for accurate streak calculation
    const streakExtra = [];
    const se = new Date(ws); se.setDate(se.getDate() - 1);
    for (let i = 0; i < 7; i++) { streakExtra.push(toStr(se)); se.setDate(se.getDate() - 1); }
    const allFetchDates = [...dates, ...streakExtra];

    const snaps = await Promise.all(
        allFetchDates.map(d => db.collection('users').doc(currentUser.uid)
            .collection('sadhana').doc(d).get())
    );
    const filledSet = new Set();
    let totalScore = 0, dayCount = 0;
    const actTotals = { sleep: 0, wakeup: 0, chanting: 0, reading: 0, hearing: 0, service: 0, notes: 0 };
    const _isSB = userProfile?.level === 'Senior Batch';
    const actMax    = { sleep: 25, wakeup: 25, chanting: 25, reading: 25, hearing: 25, service: _isSB ? 10 : 25, notes: _isSB ? 15 : 0 };

    snaps.forEach((snap, i) => {
        if (snap.exists) {
            const d = snap.data();
            if ((d.totalScore ?? 0) > 0 || d.sleepTime) {
                filledSet.add(allFetchDates[i]);
                // Only count this week's dates for the stats
                if (i < dates.length) {
                    dayCount++;
                    totalScore += d.totalScore ?? 0;
                    const sc = d.scores || {};
                    actTotals.sleep    += sc.sleep    ?? 0;
                    actTotals.wakeup   += sc.wakeup   ?? 0;
                    actTotals.chanting += sc.chanting ?? 0;
                    actTotals.reading  += sc.reading  ?? 0;
                    actTotals.hearing  += sc.hearing  ?? 0;
                    actTotals.service  += sc.service  ?? 0;
                    actTotals.notes    += sc.notes    ?? 0;
                }
            }
        }
    });

    // Fair percentage: divide by days actually filled, not total days in range
    const weekPct = dayCount > 0 ? Math.round(totalScore * 100 / (dayCount * 160)) : 0;

    // Ring
    const canvas = document.getElementById('home-ring-canvas');
    const pctColor = weekPct >= 70 ? '#059669' : weekPct >= 50 ? '#d97706' : '#dc2626';
    animateRing(canvas, weekPct, pctColor);
    const pctEl = document.getElementById('home-ring-pct');
    if (pctEl) pctEl.textContent = weekPct + '%';

    // Stats
    const wpEl = document.getElementById('home-week-pts');
    if (wpEl) wpEl.textContent = totalScore;
    const dcEl = document.getElementById('home-days-count');
    if (dcEl) dcEl.textContent = dayCount;

    // Streak — for current week: count backwards from today/yesterday
    // For past weeks: count consecutive filled days from end of that week backwards
    let streak = 0;
    const checkDate = new Date(
        (weekOffset ?? 0) === 0
            ? today + 'T00:00:00'                        // current week: start from today
            : toStr(we) + 'T00:00:00'                    // past week: start from last day of that week
    );
    // If starting day isn't filled, step back one day (only for current week)
    if ((weekOffset ?? 0) === 0 && !filledSet.has(toStr(checkDate))) {
        checkDate.setDate(checkDate.getDate() - 1);
    }
    while (true) {
        const ds = toStr(checkDate);
        if (filledSet.has(ds)) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
        else break;
    }
    const scEl = document.getElementById('home-streak-count');
    if (scEl) scEl.textContent = streak;

    // Streak dots
    renderStreakDots(dates, filledSet, today);

    // Fill alert (only for current week)
    const alertEl = document.getElementById('home-fill-alert');
    if (alertEl) {
        const shouldShow = (weekOffset === 0) && !filledSet.has(today);
        alertEl.classList.toggle('hidden', !shouldShow);
    }

    // Activity bars
    const actCard = document.getElementById('home-activity-card');
    const actBars = document.getElementById('home-activity-bars');
    if (actCard && actBars && dayCount > 0) {
        actCard.style.display = '';
        const labels = { sleep:'🛌 Sleep', wakeup:'⏰ Wake-up', chanting:'📿 Chanting',
                         reading:'📖 Reading', hearing:'🎧 Hearing', service:'🛠️ Service', notes:'📝 Notes' };
        actBars.innerHTML = Object.keys(actTotals).map(k => {
            const maxK = actMax[k] * dayCount;
            const pct  = maxK > 0 ? Math.min(Math.round(actTotals[k] * 100 / maxK), 100) : 0;
            return `<div class="act-bar-row">
                <div class="act-bar-label">${labels[k]}</div>
                <div class="act-bar-track"><div class="act-bar-fill" style="width:0" data-pct="${pct}"></div></div>
                <div class="act-bar-val">${pct}%</div>
            </div>`;
        }).join('');
        // Animate bars after render
        requestAnimationFrame(() => requestAnimationFrame(() => {
            actBars.querySelectorAll('.act-bar-fill').forEach(el =>
                el.style.width = el.dataset.pct + '%');
        }));
    } else if (actCard) {
        actCard.style.display = dayCount === 0 ? 'none' : '';
    }
}

// ═══════════════════════════════════════════════════════════
// 7c. SA HOME PANEL — overview dashboard for super admin
// ═══════════════════════════════════════════════════════════

let _saHomeLoaded = false;
async function loadSAHome(weekOffset, btn) {
    if (btn) {
        document.querySelectorAll('#sa-home-week-tabs .chart-tab-btn').forEach((b, i) =>
            b.classList.toggle('active', i === (weekOffset === 0 ? 0 : 1)));
    }
    const today = localDateStr(0);
    const toStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    // Week dates
    const now = new Date();
    const dow = now.getDay();
    const ws = new Date(now); ws.setDate(now.getDate() - dow - ((weekOffset ?? 0) * 7)); ws.setHours(0,0,0,0);
    const we = new Date(ws); we.setDate(ws.getDate() + 6);
    if ((weekOffset ?? 0) === 0 && we > now) we.setTime(now.getTime());
    const dates = [];
    const cur = new Date(ws);
    while (cur <= we) { dates.push(toStr(cur)); cur.setDate(cur.getDate() + 1); }
    const fairDays = dates.length;

    const usersSnap = await db.collection('users').get();
    const allCats = ['Senior Batch','IGF Co-ordinator','IYF Co-ordinator','ICF Coordinator'];
    const catCounts = {};
    allCats.forEach(c => { catCounts[c] = 0; });

    const userRows = [];

    // Fetch all sadhana in parallel
    const nonSADocs = usersSnap.docs.filter(d => d.data().role !== 'superAdmin');
    const allSnaps = await Promise.all(nonSADocs.map(uDoc =>
        Promise.all(dates.map(d => uDoc.ref.collection('sadhana').doc(d).get()))
    ));

    nonSADocs.forEach((uDoc, idx) => {
        const u = uDoc.data();
        const lvl = u.level || 'Senior Batch';
        if (catCounts[lvl] !== undefined) catCounts[lvl]++;
        else catCounts[lvl] = 1;

        const snaps = allSnaps[idx];
        let daysFilled = 0, totalScore = 0;
        snaps.forEach(snap => {
            if (snap.exists) {
                const d = snap.data();
                if (d.sleepTime && d.sleepTime !== 'NR') { daysFilled++; totalScore += d.totalScore ?? 0; }
            }
        });
        const weekPct = daysFilled > 0 ? Math.round(totalScore * 100 / (daysFilled * 160)) : 0;

        // Streak: count consecutive days backwards from today/yesterday
        let streak = 0;
        const chk = new Date(today + 'T00:00:00');
        // Check if today is filled (from snaps if weekOffset=0)
        const todayIdx = (weekOffset ?? 0) === 0 ? dates.indexOf(today) : -1;
        const todayFilled = todayIdx >= 0 && snaps[todayIdx]?.exists && snaps[todayIdx].data().sleepTime && snaps[todayIdx].data().sleepTime !== 'NR';
        if (!todayFilled) chk.setDate(chk.getDate() - 1);
        const filledSet = new Set();
        snaps.forEach((s, i) => {
            if (s.exists && s.data().sleepTime && s.data().sleepTime !== 'NR') filledSet.add(dates[i]);
        });
        while (filledSet.has(toStr(chk))) { streak++; chk.setDate(chk.getDate() - 1); }

        const lvlShort = lvl.replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB');
        userRows.push({ uid: uDoc.id, name: u.name || '—', level: lvlShort, chanting: u.chantingCategory||'N/A', rounds: u.exactRounds||'?', role: u.role||'user', daysFilled, fairDays, weekPct, streak, totalScore });
    });

    // Total count + category counts in filter badges
    const totalEl = document.getElementById('sa-home-total');
    if (totalEl) totalEl.textContent = nonSADocs.length;
    const catLabels = { 'Senior Batch': 'SB', 'IGF Co-ordinator': 'IGF', 'IYF Co-ordinator': 'IYF', 'ICF Coordinator': 'ICF' };
    allCats.forEach(c => {
        const el = document.getElementById('sa-cat-count-' + catLabels[c]);
        if (el) el.textContent = `(${catCounts[c] || 0})`;
    });

    // Store rows globally for filtering
    window._saHomeRows = userRows;
    window._saHomeFilter = '';

    // Render table
    renderSAHomeTable(userRows);

    // Top 3
    const top3El = document.getElementById('sa-home-top3');
    if (top3El) {
        const top3 = userRows.slice(0, 3);
        const medals = ['🥇','🥈','🥉'];
        top3El.innerHTML = top3.length === 0
            ? '<p style="color:#aaa;text-align:center;">No data yet</p>'
            : top3.map((r, i) => `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 0;${i < 2 ? 'border-bottom:1px solid var(--border);' : ''}">
                    <span style="font-size:20px;">${medals[i]}</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:700;font-size:14px;color:var(--primary);">${esc(r.name)}</div>
                        <div style="font-size:11px;color:var(--text-3);">${r.level} · ${r.daysFilled}/${r.fairDays} days · 🔥${r.streak}</div>
                    </div>
                    <div style="font-size:18px;font-weight:800;color:${r.weekPct >= 70 ? '#15803d' : r.weekPct >= 50 ? '#d97706' : '#dc2626'};">${r.weekPct}%</div>
                </div>
            `).join('');
    }

    _saHomeLoaded = true;
}

function renderSAHomeTable(rows) {
    rows.sort((a, b) => b.daysFilled - a.daysFilled || b.weekPct - a.weekPct);
    const tbody = document.getElementById('sa-home-tbody');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#aaa;">No devotees in this category</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map((r, i) => {
        const missed = r.fairDays - r.daysFilled;
        const pctColor = r.weekPct >= 70 ? '#15803d' : r.weekPct >= 50 ? '#d97706' : '#dc2626';
        const missedColor = missed === 0 ? '#15803d' : missed <= 1 ? '#d97706' : '#dc2626';
        const missedBg = missed >= 2 ? '#fff5f5' : '';
        const stripe = i % 2 === 0 ? '#fff' : '#f8fafc';
        const bg = missed >= 2 ? missedBg : stripe;
        const safe = (r.name||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return `<tr style="background:${bg};cursor:pointer;" onclick="openUAC('${r.uid}','${safe}','${r.level}','${r.chanting}','${r.rounds}','${r.role}')">
            <td style="padding:8px 10px;text-align:left;font-weight:600;">${esc(r.name)}</td>
            <td style="padding:8px 6px;text-align:center;font-size:11px;color:var(--text-2);">${r.level}</td>
            <td style="padding:8px 6px;text-align:center;font-weight:700;color:#15803d;">✅ ${r.daysFilled}/${r.fairDays}</td>
            <td style="padding:8px 6px;text-align:center;font-weight:700;color:${missedColor};">${missed === 0 ? '—' : '❌ ' + missed}</td>
            <td style="padding:8px 6px;text-align:center;font-weight:700;color:${pctColor};">${r.weekPct}%</td>
        </tr>`;
    }).join('');
}

window.filterSAHome = (cat, btn) => {
    document.querySelectorAll('#sa-home-cat-filters .sa-lvl-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    window._saHomeFilter = cat;
    const rows = window._saHomeRows || [];
    const filtered = cat ? rows.filter(r => r.level === cat) : rows;
    renderSAHomeTable(filtered);

    // Update total count display
    const totalEl = document.getElementById('sa-home-total');
    if (totalEl) totalEl.textContent = filtered.length;
};

// ═══════════════════════════════════════════════════════════
// 8. SUPER ADMIN: Tab switching + Level filters + UAC sheet
// ═══════════════════════════════════════════════════════════

// SA tab buttons (WCR / Individual Reports / Inactive Devotees / Leaderboard / Tasks)
window.saTab = (section, btn) => {
    document.querySelectorAll('.sa-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.admin-sub-panel').forEach(p => {
        p.classList.remove('active'); p.classList.add('hidden');
    });
    const panel = document.getElementById('admin-sub-' + section);
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
    if (section === 'home')        loadSAHome(0);
    if (section === 'leaderboard') loadLeaderboard(false);
    if (section === 'tasks')       loadSATasks();
    // Sync SA bottom nav (Home=0, WCR=1, Devotees=2, Inactive=3, Rankings=4, Tasks=5)
    const saTabMap = { home: 0, reports: 1, usermgmt: 2, inactive: 3, leaderboard: 4, tasks: 5 };
    document.querySelectorAll('#sa-bottom-nav .bnav-item').forEach((b, i) =>
        b.classList.toggle('active', i === (saTabMap[section] ?? -1)));
};

window.saBnavTab = (section) => saTab(section, null);

// Level filter buttons
window.saLvlFilter = (panel, level, btn) => {
    const bar = btn ? btn.closest('.sa-lvl-bar') : null;
    if (bar) bar.querySelectorAll('.sa-lvl-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Sync performers filter when reports filter changes
    if (panel === 'reports') {
        _activeFilter = level;
        renderPerformersFromCache();
    }

    if (panel === 'reports') {
        document.querySelectorAll('#comp-perf-table tbody tr').forEach(row => {
            if (!level) { row.style.display = ''; return; }
            const cell = row.querySelector('td:nth-child(2)');
            const txt  = cell ? cell.textContent.trim() : '';
            row.style.display = (
                (level === 'SB'      && txt === 'SB')       ||
                (level === 'IGF'     && txt === 'IGF')       ||
                (level === 'IYF'     && txt === 'IYF')       ||
                (level === 'ICF'     && txt === 'ICF')
            ) ? '' : 'none';
        });
    }
    if (panel === 'usermgmt') {
        document.querySelectorAll('#admin-users-list .user-card').forEach(card => {
            if (!level) { card.style.display = ''; return; }
            const meta = card.querySelector('.sa-user-meta')?.textContent || '';
            card.style.display = meta.includes(level) ? '' : 'none';
        });
    }
    if (panel === 'inactive') {
        document.querySelectorAll('#admin-inactive-container .inactive-card').forEach(card => {
            if (!level) { card.style.display = ''; return; }
            const meta = card.querySelector('.inactive-meta')?.textContent || '';
            card.style.display = meta.includes(level) ? '' : 'none';
        });
    }
};

// ── User Action Sheet (Individual Reports) ──────────────────
let _uacUID = null, _uacName = null;

window.openUAC = (uid, name, level, chanting, rounds, role) => {
    _uacUID  = uid;
    _uacName = name;
    document.getElementById('uac-name').textContent = name;
    document.getElementById('uac-sub').textContent  = level + ' · ' + chanting + ' · ' + rounds + ' rounds';

    const roleWrap = document.getElementById('uac-role-wrap');
    if (isSuperAdmin()) {
        let opts = '<option value="" disabled selected>Select…</option>';
        if (role === 'superAdmin') {
            opts += '<option value="demote">🚫 Revoke Super Admin</option>';
        } else if (role === 'admin') {
            opts += '<option value="superAdmin">👑 Make Super Admin</option><option disabled>── Shift Category ──</option><option value="shift:Senior Batch">⭐ Shift to Senior Batch</option><option value="shift:IGF Co-ordinator">⭐ Shift to IGF Co-ordinator</option><option value="shift:IYF Co-ordinator">⭐ Shift to IYF Co-ordinator</option><option value="shift:ICF Coordinator">⭐ Shift to ICF Coordinator</option><option disabled>── Make Admin ──</option><option value="cat:Senior Batch">🛡️ Admin — Senior Batch</option><option value="cat:IGF Co-ordinator">🛡️ Admin — IGF</option><option value="cat:IYF Co-ordinator">🛡️ Admin — IYF</option><option value="cat:ICF Coordinator">🛡️ Admin — ICF</option><option value="demote">🚫 Revoke Admin</option>';
        } else {
            opts += '<option value="superAdmin">👑 Make Super Admin</option><option disabled>── Shift Category ──</option><option value="shift:Senior Batch">⭐ Shift to Senior Batch</option><option value="shift:IGF Co-ordinator">⭐ Shift to IGF Co-ordinator</option><option value="shift:IYF Co-ordinator">⭐ Shift to IYF Co-ordinator</option><option value="shift:ICF Coordinator">⭐ Shift to ICF Coordinator</option><option disabled>── Make Admin ──</option><option value="cat:Senior Batch">🛡️ Admin — Senior Batch</option><option value="cat:IGF Co-ordinator">🛡️ Admin — IGF</option><option value="cat:IYF Co-ordinator">🛡️ Admin — IYF</option><option value="cat:ICF Coordinator">🛡️ Admin — ICF</option>';
        }
        document.getElementById('uac-role-sel').innerHTML = opts;
        roleWrap.style.display = '';
    } else {
        roleWrap.style.display = 'none';
    }
    // Activity Analysis — only for admins
    const actWrap = document.getElementById('uac-activity-wrap');
    if (actWrap) actWrap.style.display = isAnyAdmin() ? '' : 'none';

    document.getElementById('uac-sheet').classList.add('open');
    document.getElementById('uac-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

window.closeUAC = () => {
    document.getElementById('uac-sheet').classList.remove('open');
    document.getElementById('uac-overlay').classList.add('hidden');
    document.body.style.overflow = '';
};

window.uacHistory  = () => { closeUAC(); openUserModal(_uacUID, _uacName); };
window.uacExcel    = () => { closeUAC(); downloadUserExcel(_uacUID, _uacName); };
window.uacProgress = () => { closeUAC(); openProgressModal(_uacUID, _uacName); };

// Called when a name in the WCR table is clicked — opens the action sheet
window.openWCRUser = (idx) => {
    const u = (window._wcrUserList || [])[idx];
    if (!u) return;
    openUAC(u.uid, u.name, u.level, u.chanting, u.rounds, u.role);
};

// Called when a name in the SA comparative table is clicked — opens the action sheet
window.openAdminCmpUser = (idx) => {
    const u = (window._adminCmpUserList || [])[idx];
    if (!u) return;
    openUAC(u.uid, u.name, u.level, u.chanting, u.rounds, u.role);
};
window.uacRoleChange = async (sel) => {
    const val = sel.value; if (!val) return;
    await handleRoleDropdown(_uacUID, { value: val });
    sel.value = '';
    closeUAC();
    adminPanelLoaded = false;
    loadAdminPanel();
};
window.uacRemove = async () => {
    if (!confirm('Remove ' + _uacName + '? This cannot be undone.')) return;
    try {
        await db.collection('users').doc(_uacUID).delete();
        closeUAC();
        alert('✅ User removed.');
        adminPanelLoaded = false;
        loadAdminPanel();
    } catch(e) { alert('Error: ' + e.message); }
};

// ═══════════════════════════════════════════════════════════
// 9. REPORTS TABLE
// ═══════════════════════════════════════════════════════════
const APP_START = '2026-02-12';

function fairDenominator(sunStr, weekData, joinedDate) {
    const today = localDateStr(0);
    let days = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(sunStr); d.setDate(d.getDate() + i);
        const ds = d.toISOString().split('T')[0];
        if (ds < APP_START) continue;
        if (joinedDate && ds < joinedDate) continue; // skip pre-join days
        if (ds > today) break;
        if (ds === today) {
            const submitted = weekData && weekData.find(e => e.id === ds && e.sleepTime !== 'NR' && e.sleepTime !== '—');
            if (!submitted) break;
        }
        days++;
    }
    return Math.max(days, 1) * 160;
}

function loadReports(userId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (activeListener) { activeListener(); activeListener = null; }

    // Fetch the VIEWED user's profile (not the logged-in user's)
    db.collection('users').doc(userId).get().then(userDoc => {
        const viewedUser = userDoc.exists ? userDoc.data() : {};
        const _jd = viewedUser.joinedDate || APP_START;

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
                if (weeks[wk.label]) { weeks[wk.label].data.push({id:doc.id,...data}); weeks[wk.label].total+=data.totalScore||0; }
            });
            weeksList.forEach(wi => {
                const wk = weeks[wi.label];
                let curr = new Date(wi.sunStr);
                for (let i=0;i<7;i++) {
                    const ds = curr.toISOString().split('T')[0];
                    if (ds>=APP_START && isPastDate(ds) && !wk.data.find(e=>e.id===ds)) {
                        if (ds < _jd) {
                            wk.data.push(getPreJoinData(ds));
                        } else {
                            const nr=getNRData(ds, viewedUser.level); wk.data.push(nr); wk.total+=nr.totalScore;
                        }
                    }
                    curr.setDate(curr.getDate()+1);
                }
            });
            container.innerHTML = '';
            weeksList.forEach(wi => {
                const wk     = weeks[wi.label];
                const wkFD   = fairDenominator(wi.sunStr, wk.data, _jd);
                const wkPct  = Math.round((wk.total / wkFD) * 100);
                const wkColor = wk.total < 0 ? '#dc2626' : wkPct < 30 ? '#d97706' : '#16a34a';
                const div    = document.createElement('div'); div.className='week-card';
                const bodyId = containerId.replace(/[^a-zA-Z0-9]/g,'') + '-wb-' + wi.sunStr;
                const scoreStyle = (v) => {
                    if (v < 0)  return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v < 10) return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v >= 20) return 'color:#15803d;font-weight:600;';
                    return 'color:#1a252f;';
                };
                const scoreVal = (v) => v < 0 ? `(${v})` : `${v}`;
                const totalStyle = (v) => {
                    if (v < 0)   return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v < 32)  return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v >= 112) return 'color:#15803d;font-weight:700;';
                    return 'font-weight:600;color:#1a252f;';
                };
                const totalVal = (v) => v < 0 ? `(${v})` : `${v}`;
                const hasActionCol = isAnyAdmin() && userId !== currentUser.uid;
                const rowsHtml = wk.data.sort((a,b)=>b.id.localeCompare(a.id)).map((e, ri) => {
                    // Pre-join day — show grey dash row, no scores
                    if (e.preJoin) {
                        const colSpan = hasActionCol ? 15 : 14;
                        return `<tr style="background:#f9fafb;color:#c0c5cc;">
                            <td></td>
                            <td style="font-weight:600;color:#b0b5bc;">${e.id.split('-').slice(1).reverse().join('/')}</td>
                            <td colspan="${colSpan - 2}" style="text-align:center;font-size:12px;font-style:italic;color:#b0b5bc;">— Not yet joined —</td>
                        </tr>`;
                    }
                    const isNR     = e.sleepTime === 'NR';
                    const stripeBg = ri % 2 === 0 ? '#ffffff' : '#f8fafc';
                    const rowBg    = e.rejected ? '#fef2f2' : isNR ? '#fff5f5' : stripeBg;
                    const editedBadge = e.editedAt
                        ? `<span class="edited-badge" onclick="showEditHistory(event,'${e.id}','${userId}')" title="View edit history">✏️</span>`
                        : '';
                    const rejectedBadge = e.rejected
                        ? `<span class="rejected-badge" title="Rejected by ${(e.rejectedBy||'Admin').replace(/'/g,"'")}${e.rejectionReason?': '+e.rejectionReason:''}">🚫</span>`
                        : '';
                    const editBtn = isSuperAdmin()
                        ? `<button onclick="openEditModal('${userId}','${e.id}')" class="btn-edit-cell" title="Edit this entry">Edit</button> `
                        : '';
                    let rejectBtn = '';
                    if (hasActionCol && !isNR) {
                        rejectBtn = e.rejected
                            ? `<button onclick="openRejectModal('${userId}','${e.id}',true)" class="btn-revoke-cell" title="Revoke rejection">Revoke</button>`
                            : `<button onclick="openRejectModal('${userId}','${e.id}',false)" class="btn-reject-cell" title="Reject this entry">Reject</button>`;
                    }
                    const dayPct = e.dayPercent ?? 0;
                    const pfBadge = `<span class="pf-badge ${dayPct >= 50 ? 'pf-pass' : 'pf-fail'}">${dayPct >= 50 ? 'Pass' : 'Fail'}</span>`;
                    const sc = e.scores || {};
                    const mkS = (v) => `<td style="${scoreStyle(v)}">${scoreVal(v)}</td>`;
                    return `<tr style="background:${rowBg};">
                        <td style="padding:2px 4px;">${pfBadge}</td>
                        <td style="font-weight:600;">${e.id.split('-').slice(1).reverse().join('/')}${editedBadge}${rejectedBadge}</td>
                        <td style="${isNR?'color:#b91c1c;font-weight:700;':''}">${fmt12(e.sleepTime||'NR')}</td>${mkS(sc.sleep??0)}
                        <td style="${isNR?'color:#b91c1c;':''}">${fmt12(e.wakeupTime||'NR')}</td>${mkS(sc.wakeup??0)}
                        <td>${fmt12(e.chantingTime||'NR')}</td>${mkS(sc.chanting??0)}
                        <td>${e.readingMinutes||0}m</td>${mkS(sc.reading??0)}
                        <td>${e.hearingMinutes||0}m</td>${mkS(sc.hearing??0)}
                        <td>${e.serviceMinutes||0}m</td>${mkS(sc.service??0)}
                        <td>${e.notesMinutes||0}m</td>${mkS(sc.notes??0)}
                        <td>${e.daySleepMinutes||0}m</td>${mkS(sc.daySleep??0)}
                        <td style="${totalStyle(e.totalScore??0)}">${totalVal(e.totalScore??0)}</td>
                        <td>${e.dayPercent??0}%</td>
                        ${hasActionCol ? `<td style="padding:2px 4px;white-space:nowrap;">${editBtn}${rejectBtn}</td>` : ''}
                    </tr>`;
                }).join('');
                const editThCol = hasActionCol ? '<th></th>' : '';
                div.innerHTML = `
                    <div class="week-header" onclick="document.getElementById('${bodyId}').classList.toggle('open')">
                        <span style="white-space:nowrap;">📅 ${wk.range.replace('_',' ')}</span>
                        <strong style="white-space:nowrap;color:${wkColor}">
                            ${wk.total} / ${wkFD} (${wkPct}%) ▼
                        </strong>
                    </div>
                    <div class="week-body" id="${bodyId}">
                        <table class="data-table">
                        <thead><tr>
                            <th>P/F</th><th>Date</th><th>Bed</th><th>M</th><th>Wake</th><th>M</th><th>Chant</th><th>M</th>
                            <th>Read</th><th>M</th><th>Hear</th><th>M</th><th>Seva</th><th>M</th>
                            <th>Notes</th><th>M</th><th>Day Sleep</th><th>M</th><th>Total</th><th>%</th>
                            ${editThCol}
                        </tr></thead>
                        <tbody>${rowsHtml}</tbody></table>
                    </div>`;
                container.appendChild(div);
            });
        }, err => console.error('Snapshot error:', err));
    }); // end userDoc.get().then
}

// ═══════════════════════════════════════════════════════════
// 10. PROGRESS CHARTS
// ═══════════════════════════════════════════════════════════
let myChartInstance    = null;
let modalChartInstance = null;
let progressModalUserId   = null;
let progressModalUserName = null;

async function fetchChartData(userId, view) {
    const [snap, uDoc] = await Promise.all([
        db.collection('users').doc(userId).collection('sadhana').orderBy(firebase.firestore.FieldPath.documentId()).get(),
        db.collection('users').doc(userId).get()
    ]);
    const _chartLevel = uDoc.exists ? (uDoc.data().level || 'Senior Batch') : 'Senior Batch';
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
            if (i === 0 && !entry) continue;
            labels.push(ds.split('-').slice(1).reverse().join('/'));
            data.push(entry ? entry.score : nrPenalty(_chartLevel));
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
                tot += en ? en.score : nrPenalty(_chartLevel);
                curr.setDate(curr.getDate()+1);
            }
            labels.push(wi.label.split('_')[0].split(' to ')[0]);
            data.push(tot);
        }
        return { labels, data, label:'Weekly Score', max:1120, color:'#27ae60' };
    }
    if (view === 'monthly') {
        const monthMap = {};
        allEntries.forEach(en => { const ym = en.date.substring(0,7); monthMap[ym] = (monthMap[ym]||0) + en.score; });
        const sorted = Object.keys(monthMap).sort();
        const labels = sorted.map(ym => { const [y,m] = ym.split('-'); return `${new Date(y,m-1).toLocaleString('en-GB',{month:'short'})} ${y}`; });
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
// 11. SADHANA FORM
// ═══════════════════════════════════════════════════════════
document.getElementById('sadhana-form').onsubmit = async (e) => {
    e.preventDefault();
    const date  = document.getElementById('sadhana-date').value;
    const existing = await db.collection('users').doc(currentUser.uid).collection('sadhana').doc(date).get();
    if (existing.exists) { alert(`❌ Sadhna for ${date} already submitted! Contact admin for corrections.`); return; }
    const level = userProfile.level || 'Senior Batch';
    let slp     = document.getElementById('sleep-time').value;
    const wak   = document.getElementById('wakeup-time').value;
    const chn   = document.getElementById('chanting-time').value;
    const rMin  = parseInt(document.getElementById('reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('service-mins')?.value)||0;
    const nMin  = parseInt(document.getElementById('notes-mins')?.value)||0;
    const dsMin = parseInt(document.getElementById('day-sleep-minutes').value)||0;
    if (slp) {
        const [sh] = slp.split(':').map(Number);
        if (sh >= 4 && sh <= 20) {
            const goAhead = confirm(
                `⚠️ Bed Time Warning\n\nYou entered "${slp}" as bed time.\nThis looks like a daytime hour.\n\nDid you mean night time? e.g. 23:00 instead of 11:00?\n\nTap OK if "${slp}" is correct.\nTap Cancel to go back and fix it.`
            );
            if (!goAhead) return;
        }
    }
    const { sc, total, dayPercent } = calculateScores(slp, wak, chn, rMin, hMin, sMin, nMin, dsMin, level);
    await db.collection('users').doc(currentUser.uid).collection('sadhana').doc(date).set({
        sleepTime:slp, wakeupTime:wak, chantingTime:chn,
        readingMinutes:rMin, hearingMinutes:hMin, serviceMinutes:sMin,
        notesMinutes:nMin, daySleepMinutes:dsMin,
        scores:sc, totalScore:total, dayPercent,
        levelAtSubmission:level,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showSubmitSuccess(total, dayPercent);
};

function showSubmitSuccess(score, pct) {
    const overlay = document.getElementById('submit-success-overlay');
    if (!overlay) { switchTab('mysadhana'); switchSadhanaTab('reports'); return; }
    document.getElementById('ss-score').textContent = score;
    document.getElementById('ss-pct').textContent   = pct + '%';
    const msgs = [
        'Jai Shri Krishna! Keep up the devotion. 🌸',
        'Wonderful! Every sadhna brings you closer. 🙏',
        'Hare Krishna! Your efforts are counted. 🌺',
        'Well done! Guru is pleased with your practice. ✨',
        'Beautiful! Consistency is the key to progress. 🪷'
    ];
    document.getElementById('ss-msg').textContent = msgs[Math.floor(Math.random() * msgs.length)];
    const bar = document.getElementById('ss-bar');
    bar.style.width = '0';
    overlay.classList.add('visible');
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = Math.min(pct, 100) + '%'; }));
    setTimeout(() => {
        overlay.classList.remove('visible');
        bar.style.width = '0';
        switchTab('mysadhana');
        switchSadhanaTab('reports');
    }, 2800);
}

// ═══════════════════════════════════════════════════════════
// 12. ADMIN PANEL
// ═══════════════════════════════════════════════════════════
window.filterInactive = (minDays, btn) => {
    document.querySelectorAll('.inactive-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const body = document.getElementById('inactive-cards-body');
    if (body && window._buildInactiveCards) body.innerHTML = window._buildInactiveCards(minDays);
};

let adminPanelLoaded = false;

window.openAdminDrawer = () => {
    // Only category admins use the drawer — superAdmin has direct tabs
    if (isSuperAdmin()) return;
    document.getElementById('admin-drawer').classList.add('open');
    document.getElementById('admin-drawer-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    ['home-panel','mysadhana-panel','team-panel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const ap = document.getElementById('admin-panel');
    if (ap) ap.classList.add('active');
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
    document.querySelectorAll('.drawer-nav-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Sync admin-sub-nav for category admin context
    const subNavMap = { reports: 0, usermgmt: 1, inactive: 2, leaderboard: 3 };
    document.querySelectorAll('#admin-sub-nav .subtab-btn').forEach((b, i) =>
        b.classList.toggle('active', i === (subNavMap[section] ?? -1)));
    document.querySelectorAll('.admin-sub-panel').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    const panel = document.getElementById('admin-sub-' + section);
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
    closeAdminDrawer();
    if (section === 'leaderboard') loadLeaderboard(false);
    if (section === 'tasks')       loadSATasks();
    if (section === 'reports' && !adminPanelLoaded) { adminPanelLoaded = true; loadAdminPanel(); }
};

window.filterAdminUsers = () => {
    const query    = (document.getElementById('admin-search-input')?.value || '').toLowerCase().trim();
    const category = document.getElementById('admin-category-filter')?.value || '';
    const cards    = document.querySelectorAll('#admin-users-list .user-card');
    cards.forEach(card => {
        const name = (card.querySelector('.user-list-name')?.textContent || card.querySelector('.user-name')?.textContent || '').toLowerCase();
        const meta = (card.querySelector('.sa-user-meta')?.textContent || card.querySelector('.user-meta')?.textContent || '');
        const matchName = !query    || name.includes(query);
        const matchCat  = !category || meta.includes(category);
        card.style.display = (matchName && matchCat) ? '' : 'none';
    });
};

async function loadAdminPanel() {
    const tableBox     = document.getElementById('admin-comparative-reports-container');
    const usersList    = document.getElementById('admin-users-list');
    const inactiveCont = document.getElementById('admin-inactive-container');
    tableBox.innerHTML  = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    usersList.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    if (inactiveCont) inactiveCont.innerHTML = '';

    const weeks = [];
    for (let i=0;i<4;i++) {
        const d=new Date(); d.setDate(d.getDate()-i*7);
        weeks.push(getWeekInfo(d.toISOString().split('T')[0]));
    }
    weeks.reverse();

    const usersSnap = await db.collection('users').get();
    const cats      = visibleCategories();
    const filtered  = usersSnap.docs
        .filter(doc => cats.includes(doc.data().level||'Senior Batch'))
        .sort((a,b) => (a.data().name||'').localeCompare(b.data().name||''));

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
            <th class="comp-th">Chanting</th>
            ${weeks.map(w=>`<th class="comp-th">${w.label.split('_')[0]}</th>`).join('')}
        </tr></thead><tbody>`;

    usersList.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = `info-banner ${isSuperAdmin()?'banner-purple':'banner-blue'}`;
    banner.innerHTML = isSuperAdmin()
        ? '👑 <strong>Super Admin</strong> — All categories, full role management'
        : `🛡️ <strong>Category Admin</strong> — Managing: <strong>${userProfile.adminCategory}</strong>`;
    usersList.appendChild(banner);

    const catFilter = document.getElementById('admin-category-filter');
    if (catFilter) catFilter.style.display = isSuperAdmin() ? '' : 'none';
    const searchInput = document.getElementById('admin-search-input');
    if (searchInput) searchInput.value = '';
    if (catFilter) catFilter.value = '';

    const inactiveUsers = [];
    const userSadhanaCache = new Map();
    window._adminSadhanaCache = userSadhanaCache;
    window._adminCmpUserList = [];

    // Fetch all sadhana subcollections in parallel (was sequential — big speed gain)
    const allAdminSnaps = await Promise.all(filtered.map(uDoc => uDoc.ref.collection('sadhana').get()));

    filtered.forEach((uDoc, rowIdx) => {
        const u     = uDoc.data();
        const sSnap = allAdminSnaps[rowIdx];
        const ents  = sSnap.docs.map(d=>({date:d.id, score:d.data().totalScore||0, sleepTime:d.data().sleepTime||'', scores:d.data().scores||{}}));
        userSadhanaCache.set(uDoc.id, ents);

        const submittedDates = new Set(sSnap.docs.map(d => d.id).filter(d => d >= APP_START));
        let missedDays = 0;
        for (let i = 1; i <= 30; i++) {
            const ds = localDateStr(i);
            if (ds < APP_START) break;
            if (submittedDates.has(ds)) break;
            missedDays++;
        }
        if (missedDays >= 2) {
            const allDates = Array.from(submittedDates).sort((a,b) => b.localeCompare(a));
            const lastDate = allDates[0] || null;
            inactiveUsers.push({ id: uDoc.id, name: u.name, level: u.level, lastDate, missedDays });
        }

        const stripeBg = rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
        const lvlShort = (u.level||'SB').replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB');
        const cmpIdx = window._adminCmpUserList.length;
        window._adminCmpUserList.push({ uid: uDoc.id, name: u.name||'', level: lvlShort, chanting: u.chantingCategory||'N/A', rounds: u.exactRounds||'?', role: u.role||'user' });
        tHtml += `<tr style="background:${stripeBg}">
            <td class="comp-td comp-name" onclick="openAdminCmpUser(${cmpIdx})" style="cursor:pointer;" title="View ${(u.name||'').replace(/"/g,'&quot;')}">${u.name}</td>
            <td class="comp-td comp-meta">${lvlShort}</td>
            <td class="comp-td comp-meta">${u.chantingCategory||'N/A'}</td>`;
        const uJd2 = u.joinedDate || APP_START;
        weeks.forEach(w => {
            let tot=0; let curr=new Date(w.sunStr);
            const weekEnts=[];
            const todayComp = localDateStr(0);
            for (let i=0;i<7;i++) {
                const ds=curr.toISOString().split('T')[0];
                if (ds < APP_START || ds > todayComp || ds < uJd2) { curr.setDate(curr.getDate()+1); continue; }
                const en=ents.find(e=>e.date===ds);
                if (en) { tot += en.score; weekEnts.push({id:ds, sleepTime:en.sleepTime||'', score:en.score}); }
                else if (ds < todayComp) { tot += nrPenalty(u.level); }
                curr.setDate(curr.getDate()+1);
            }
            const fd = fairDenominator(w.sunStr, weekEnts, uJd2);
            const pct = Math.round((tot/fd)*100);
            const ps  = pctStyle(pct);
            const cellBg = ps.bg || stripeBg;
            const pf  = `<span class="pf-badge ${pct>=50?'pf-pass':'pf-fail'}" style="margin-left:4px;">${pct>=50?'P':'F'}</span>`;
            tHtml += `<td class="comp-td comp-pct" style="background:${cellBg};color:${ps.color};font-weight:${ps.bold?'700':'400'};" title="${tot}/${fd}">${ps.text}${pf}</td>`;
        });
        tHtml += '</tr>';

        // ── User list item (clickable → UAC sheet) ──
        const card = document.createElement('div');
        card.className = 'user-card';
        let badge = '';
        if (u.role==='superAdmin') badge = `<span class="role-badge" style="background:#7e22ce;color:white;">👑 SA</span>`;
        else if (u.role==='admin') badge = `<span class="role-badge" style="background:#d97706;color:white;">🛡️ Admin</span>`;
        const safe = (u.name||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        const roleStr = u.role || 'user';
        card.innerHTML = `
            <div class="user-list-item" onclick="openUAC('${uDoc.id}','${safe}','${lvlShort}','${u.chantingCategory||'N/A'}','${u.exactRounds||'?'}','${roleStr}')">
                <div>
                    <div class="user-list-name">${u.name} ${badge}</div>
                    <div class="sa-user-meta">${lvlShort} · ${u.chantingCategory||'N/A'} · ${u.exactRounds||'?'} rounds</div>
                </div>
                <span class="user-list-chevron">›</span>
            </div>`;
        usersList.appendChild(card);
    });

    // ── Inactive devotees ──
    inactiveUsers.sort((a,b) => (a.name||'').localeCompare(b.name||''));
    window._inactiveUsers = inactiveUsers;

    const inactiveSection = document.createElement('div');
    inactiveSection.className = 'inactive-section';

    const buildInactiveCards = (minDays) => {
        const filtered2 = minDays === 4
            ? inactiveUsers.filter(u => u.missedDays >= 4)
            : inactiveUsers.filter(u => u.missedDays === minDays);
        const label = minDays === 4 ? '4+ consecutive days' : `exactly ${minDays} days`;
        if (filtered2.length === 0) return `<div class="inactive-empty">✅ No devotees missing ${label}!</div>`;
        return filtered2.map(u => {
            const lastTxt = u.lastDate
                ? `Last entry: ${u.lastDate.split('-').slice(1).join(' ')}`
                : 'No entries yet';
            const safe = (u.name||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            const dot = u.missedDays >= 4 ? '🔴' : u.missedDays === 3 ? '🟠' : '🟡';
            return `<div class="inactive-card">
                <div class="inactive-card-left">
                    <span class="inactive-dot">${dot}</span>
                    <div>
                        <div class="inactive-name">${esc(u.name)}</div>
                        <div class="inactive-meta">${esc(u.level||'Senior Batch')} · ${lastTxt} · <strong>${u.missedDays} days missed</strong></div>
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

    window._buildInactiveCards = buildInactiveCards;
    if (inactiveCont) { inactiveCont.innerHTML = ''; inactiveCont.appendChild(inactiveSection); }

    const tabBadge = document.getElementById('inactive-tab-badge');
    if (tabBadge) tabBadge.textContent = count4plus > 0 ? count4plus : '';

    tableBox.innerHTML = tHtml + '</tbody></table>';
    // Save data for WCR re-rendering when perf filter changes
    window._wcrFilteredUsers = filtered.map(uDoc => {
        const u = uDoc.data();
        return { uid: uDoc.id, name: u.name||'', level: u.level||'', chanting: u.chantingCategory||'', rounds: u.exactRounds||'0', role: u.role||'user', joinedDate: u.joinedDate || APP_START };
    });
    window._wcrContainerId = 'admin-comparative-reports-container';
    // Build performers from loaded data
    computePerformers(filtered);
}

window.handleRoleDropdown = async (uid, sel) => {
    const val = sel.value; sel.value='';
    if (!val) return;
    let newRole, cat=null, msg='', shiftLevel=null;
    if (val==='superAdmin')              { newRole='superAdmin'; msg='👑 Make this user SUPER ADMIN?\nFull access to all categories.'; }
    else if (val.startsWith('shift:'))   { shiftLevel=val.slice(6); newRole='user'; cat=null; msg=`⭐ Shift this devotee to ${shiftLevel}?`; }
    else if (val.startsWith('cat:'))     { newRole='admin'; cat=val.slice(4); msg=`🛡️ Assign as Category Admin for:\n"${cat}"?`; }
    else if (val==='demote')             { newRole='user'; msg='🚫 Revoke all admin access?'; }
    else return;
    if (!confirm(msg)) return;
    if (!confirm('Final confirmation?')) return;
    const updateData = { role:newRole, adminCategory:cat };
    if (shiftLevel) updateData.level = shiftLevel;
    await db.collection('users').doc(uid).update(updateData);
    alert(shiftLevel ? `✅ Devotee shifted to ${shiftLevel}!` : '✅ Role updated!');
    if (shiftLevel) {
        if (window._sendRoleNotification) window._sendRoleNotification(uid, '', 'shift', shiftLevel);
    } else {
        if (window._sendRoleNotification) window._sendRoleNotification(uid, '', val, cat);
    }
    adminPanelLoaded = false;
    loadAdminPanel();
};

// ═══════════════════════════════════════════════════════════
// 13. SUPER ADMIN — EDIT SADHANA
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
    const d = docSnap.exists ? docSnap.data() : {
        sleepTime: 'NR', wakeupTime: 'NR', chantingTime: 'NR',
        readingMinutes: 0, hearingMinutes: 0, serviceMinutes: 0, notesMinutes: 0, daySleepMinutes: 0,
        totalScore: -35, dayPercent: -22
    };
    editModalOriginal = { ...d };
    const uSnap   = await db.collection('users').doc(userId).get();
    const uLevel  = uSnap.exists ? (uSnap.data().level || 'Senior Batch') : 'Senior Batch';
    document.getElementById('edit-user-level').value = uLevel;
    document.getElementById('edit-sleep-time').value      = d.sleepTime === 'NR' ? '' : (d.sleepTime      || '');
    document.getElementById('edit-wakeup-time').value     = d.wakeupTime === 'NR' ? '' : (d.wakeupTime     || '');
    document.getElementById('edit-chanting-time').value   = d.chantingTime === 'NR' ? '' : (d.chantingTime   || '');
    updateTimeHint('edit-sleep-time',    'edit-sleep-hint');
    updateTimeHint('edit-wakeup-time',   'edit-wakeup-hint');
    updateTimeHint('edit-chanting-time', 'edit-chanting-hint');
    document.getElementById('edit-reading-mins').value    = d.readingMinutes  || 0;
    document.getElementById('edit-hearing-mins').value    = d.hearingMinutes  || 0;
    document.getElementById('edit-service-mins').value    = d.serviceMinutes  || 0;
    document.getElementById('edit-notes-mins').value      = d.notesMinutes    || 0;
    document.getElementById('edit-day-sleep-mins').value  = d.daySleepMinutes || 0;
    document.getElementById('edit-reason').value          = '';
    const uData = uSnap.exists ? uSnap.data() : {};
    document.getElementById('edit-modal-title').textContent = `✏️ Edit Sadhna — ${uData.name||userId} · ${date}`;
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
    const now = new Date().toISOString();
    const editLog = {
        editedBy: userProfile.name, editedByUid: currentUser.uid, editedAt: now,
        reason: reason || 'No reason provided',
        original: {
            sleepTime: editModalOriginal.sleepTime||'NR', wakeupTime: editModalOriginal.wakeupTime||'NR',
            chantingTime: editModalOriginal.chantingTime||'NR',
            readingMinutes: editModalOriginal.readingMinutes||0, hearingMinutes: editModalOriginal.hearingMinutes||0,
            serviceMinutes: editModalOriginal.serviceMinutes||0, notesMinutes: editModalOriginal.notesMinutes||0,
            daySleepMinutes: editModalOriginal.daySleepMinutes||0,
            totalScore: editModalOriginal.totalScore||0, dayPercent: editModalOriginal.dayPercent||0
        }
    };
    try {
        const docRef = db.collection('users').doc(editModalUserId).collection('sadhana').doc(editModalDate);
        await docRef.set({
            sleepTime:slp, wakeupTime:wak, chantingTime:chn,
            readingMinutes:rMin, hearingMinutes:hMin, serviceMinutes:sMin,
            notesMinutes:nMin, daySleepMinutes:dsMin,
            scores:sc, totalScore:total, dayPercent,
            editedAt: firebase.firestore.FieldValue.serverTimestamp(),
            editedBy: userProfile.name
        }, { merge: true });
        await docRef.set({ editLog: firebase.firestore.FieldValue.arrayUnion(editLog) }, { merge: true });
        closeEditModal();
        alert(`✅ Sadhna updated!\nNew Score: ${total} (${dayPercent}%)`);
    } catch (err) {
        console.error('Edit save error:', err);
        alert('❌ Save failed: ' + err.message);
    }
};

window.showEditHistory = async (evt, date, userId) => {
    evt.stopPropagation();
    const docSnap = await db.collection('users').doc(userId).collection('sadhana').doc(date).get();
    if (!docSnap.exists) return;
    const cur = docSnap.data();
    const log = cur.editLog || [];
    if (log.length === 0) { alert('No edit history found.'); return; }
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
        let ts = 'Unknown time';
        if (entry.editedAt) {
            const d = typeof entry.editedAt === 'string' ? new Date(entry.editedAt) : entry.editedAt.toDate?.();
            if (d) ts = d.toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
        }
        html += `<div class="eh-entry">`;
        html += `<div class="eh-header">✏️ Edit ${i+1} &nbsp;|&nbsp; <span class="eh-who">${entry.editedBy||'Admin'}</span> &nbsp;|&nbsp; <span class="eh-when">${ts}</span></div>`;
        html += `<div class="eh-reason">📝 ${entry.reason || 'No reason provided'}</div>`;
        if (entry.original) {
            const o = entry.original;
            const changedFields = FIELDS.filter(f => String(o[f.oKey]??'—') !== String(cur[f.cKey]??'—'));
            if (changedFields.length === 0) {
                html += `<div class="eh-nochange">No field changes detected in this edit.</div>`;
            } else {
                html += `<table class="eh-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>`;
                const isTimeField = (key) => key === 'sleepTime' || key === 'wakeupTime' || key === 'chantingTime';
                changedFields.forEach(f => {
                    const disp = (v) => v == null ? '—' : (isTimeField(f.oKey) ? fmt12(String(v)) : v);
                    html += `<tr><td class="eh-field">${f.label}</td><td class="eh-before">${disp(o[f.oKey])}</td><td class="eh-after">${disp(cur[f.cKey])}</td></tr>`;
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
// 14. REJECT / REVOKE ENTRY
// ═══════════════════════════════════════════════════════════
let _rejectState = null;

window.openRejectModal = async (userId, date, isRevoke) => {
    if (!isAnyAdmin()) return;
    const docSnap = await db.collection('users').doc(userId).collection('sadhana').doc(date).get();
    if (!docSnap.exists) { alert('Entry not found.'); return; }
    const d = docSnap.data();
    _rejectState = { userId, date, isRevoke, data: d };

    const title      = document.getElementById('reject-modal-title');
    const body       = document.getElementById('reject-modal-body');
    const confirmBtn = document.getElementById('reject-confirm-btn');

    if (isRevoke) {
        title.textContent = '✅ Revoke Rejection';
        const origScore = d.originalScore ?? 0;
        const origPct   = d.originalPercent ?? 0;
        body.innerHTML = `
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;font-size:13px;line-height:1.7;">
                <div>📅 Date: <strong>${date.split('-').slice(1).reverse().join('/')}</strong></div>
                <div>Rejected by: <strong>${d.rejectedBy || 'Admin'}</strong></div>
                ${d.rejectionReason ? `<div>Reason: <em>${d.rejectionReason}</em></div>` : ''}
                <div style="margin-top:8px;color:#15803d;font-weight:600;">
                    ✅ Original score will be restored: ${origScore} / 160 (${origPct}%)
                </div>
            </div>`;
        confirmBtn.textContent = '✅ Revoke Rejection';
        confirmBtn.style.background = '#15803d';
    } else {
        title.textContent = '🚫 Reject Entry';
        const score = d.totalScore ?? 0;
        body.innerHTML = `
            <div style="background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:12px;font-size:13px;line-height:1.7;">
                <div>📅 Date: <strong>${date.split('-').slice(1).reverse().join('/')}</strong></div>
                <div>Current score: <strong>${score} / 160</strong></div>
                <div style="margin-top:8px;color:#dc2626;font-weight:600;">
                    ⚠️ Score will be overridden to −50 as a penalty.
                </div>
            </div>`;
        confirmBtn.textContent = '🚫 Reject Entry';
        confirmBtn.style.background = '#dc2626';
    }

    document.getElementById('reject-remarks').value = '';
    document.getElementById('reject-modal').classList.remove('hidden');
};

window.closeRejectModal = () => {
    document.getElementById('reject-modal').classList.add('hidden');
    _rejectState = null;
};

window.submitRejectAction = async () => {
    if (!_rejectState || !isAnyAdmin()) return;
    const { userId, date, isRevoke, data } = _rejectState;
    const remarks = document.getElementById('reject-remarks').value.trim();
    const docRef  = db.collection('users').doc(userId).collection('sadhana').doc(date);

    try {
        if (isRevoke) {
            if (!confirm(`Revoke rejection for ${date.split('-').slice(1).reverse().join('/')}?\nOriginal score will be restored.`)) return;
            await docRef.set({
                rejected:         false,
                revokedBy:        userProfile.name,
                revokedByUid:     currentUser.uid,
                revokedAt:        firebase.firestore.FieldValue.serverTimestamp(),
                revocationReason: remarks,
                totalScore:       data.originalScore  ?? 0,
                dayPercent:       data.originalPercent ?? 0
            }, { merge: true });
            closeRejectModal();
            alert('✅ Rejection revoked. Original score has been restored.');
        } else {
            if (!confirm(`Reject entry for ${date.split('-').slice(1).reverse().join('/')}?\nA penalty of −50 will be applied.`)) return;
            await docRef.set({
                rejected:         true,
                rejectedBy:       userProfile.name,
                rejectedByUid:    currentUser.uid,
                rejectedAt:       firebase.firestore.FieldValue.serverTimestamp(),
                rejectionReason:  remarks,
                originalScore:    data.totalScore  ?? 0,
                originalPercent:  data.dayPercent  ?? 0,
                totalScore:       -50,
                dayPercent:       -31
            }, { merge: true });
            closeRejectModal();
            alert('🚫 Entry rejected. Score has been set to −50.');
        }
    } catch (err) {
        console.error('Reject/revoke error:', err);
        alert('❌ Failed: ' + err.message);
    }
};

// ═══════════════════════════════════════════════════════════
// 14. DATE SELECT & PROFILE FORM
// ═══════════════════════════════════════════════════════════
function setupDateSelect() {
    const s = document.getElementById('sadhana-date');
    if (!s) return;
    s.innerHTML = '';
    for (let i=0;i<2;i++) {
        const ds = localDateStr(i);
        const opt = document.createElement('option');
        opt.value = ds;
        const parts = ds.split('-');
        opt.textContent = parts[2] + '/' + parts[1] + '/' + parts[0] + (i===0 ? ' (Today)' : ' (Yesterday)');
        s.appendChild(opt);
    }
    refreshFormFields();
}

function refreshFormFields() {
    const notesArea   = document.getElementById('notes-area');
    const serviceArea = document.getElementById('service-area');
    const isSB = userProfile && userProfile.level === 'Senior Batch';
    if (notesArea)   notesArea.classList.toggle('hidden', !isSB);
    if (serviceArea) serviceArea.classList.remove('hidden');
}

document.getElementById('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const data = {
        name:             document.getElementById('profile-name').value,
        level:            document.getElementById('profile-level').value,
        chantingCategory: document.getElementById('profile-chanting').value,
        exactRounds:      document.getElementById('profile-exact-rounds').value,
        role:             userProfile?.role || 'user'
    };
    if (window._profilePicDataUrl) data.photoURL = window._profilePicDataUrl;
    // Preserve existing joinedDate (only set manually via Firestore by Super Admin)
    if (userProfile?.joinedDate) data.joinedDate = userProfile.joinedDate;
    await db.collection('users').doc(currentUser.uid).set(data, { merge:true });
    alert('✅ Profile saved!');
    location.reload();
};

// ═══════════════════════════════════════════════════════════
// 15. PASSWORD MODAL
// ═══════════════════════════════════════════════════════════
window.openPasswordModal = () => {
    document.getElementById('pwd-current').value = '';
    document.getElementById('pwd-new').value     = '';
    document.getElementById('pwd-confirm').value = '';
    document.getElementById('password-modal').classList.remove('hidden');
};
window.closePasswordModal = () => {
    document.getElementById('password-modal').classList.add('hidden');
};
window.submitPasswordChange = async () => {
    const curPwd  = document.getElementById('pwd-current').value.trim();
    const newPwd  = document.getElementById('pwd-new').value.trim();
    const confPwd = document.getElementById('pwd-confirm').value.trim();
    if (!curPwd)           { alert('❌ Please enter your current password.'); return; }
    if (!newPwd)           { alert('❌ Please enter a new password.'); return; }
    if (newPwd.length < 6) { alert('❌ Password must be at least 6 characters.'); return; }
    if (newPwd !== confPwd){ alert('❌ Passwords do not match!'); return; }
    if (!confirm('🔑 Confirm password change?')) return;
    try {
        const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, curPwd);
        await currentUser.reauthenticateWithCredential(cred);
        await currentUser.updatePassword(newPwd);
        closePasswordModal();
        alert('✅ Password changed successfully!');
    } catch (err) {
        alert('❌ ' + friendlyAuthError(err));
    }
};

// ═══════════════════════════════════════════════════════════
// 16. MISC BINDINGS
// ═══════════════════════════════════════════════════════════
function friendlyAuthError(err) {
    const map = {
        'auth/invalid-email':            'The email address is not valid. Please check and try again.',
        'auth/user-disabled':            'This account has been disabled. Please contact your coordinator.',
        'auth/user-not-found':           'No account found with this email. Please check the email or sign up first.',
        'auth/wrong-password':           'Incorrect password. Please try again.',
        'auth/invalid-credential':       'Incorrect email or password. Please check and try again.',
        'auth/email-already-in-use':     'An account with this email already exists. Try logging in instead.',
        'auth/weak-password':            'Password is too weak. Please use at least 6 characters.',
        'auth/too-many-requests':        'Too many failed attempts. Please wait a few minutes and try again.',
        'auth/network-request-failed':   'No internet connection. Please check your network and try again.',
        'auth/requires-recent-login':    'For security, please log out and log back in before trying this.',
        'auth/operation-not-allowed':    'This sign-in method is not enabled. Please contact support.',
        'auth/invalid-action-code':      'This link has expired or already been used. Please request a new one.',
        'auth/expired-action-code':      'This link has expired. Please request a new password reset link.',
    };
    return map[err.code] || 'Something went wrong. Please try again later.';
}

document.getElementById('login-form').onsubmit = (e) => {
    e.preventDefault();
    auth.signInWithEmailAndPassword(
        document.getElementById('login-email').value,
        document.getElementById('login-password').value
    ).catch(err => alert('❌ ' + friendlyAuthError(err)));
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
    document.getElementById('profile-title').textContent    = 'Edit Profile';
    document.getElementById('profile-subtitle').textContent = 'Update your details';
    document.getElementById('profile-name').value           = userProfile.name             || '';
    document.getElementById('profile-level').value          = userProfile.level            || '';
    document.getElementById('profile-chanting').value       = userProfile.chantingCategory || '';
    document.getElementById('profile-exact-rounds').value   = userProfile.exactRounds      || '';
    document.getElementById('cancel-edit').classList.remove('hidden');
    window._profilePicDataUrl = null;
    // Show current photo in the profile pic preview
    const photoURL = userProfile.photoURL || null;
    const name     = userProfile.name || '';
    const preview  = document.getElementById('profile-pic-preview');
    const init     = document.getElementById('profile-pic-init');
    if (photoURL) {
        preview.src = photoURL; preview.style.display = '';
        if (init) init.style.display = 'none';
    } else {
        if (preview) preview.style.display = 'none';
        if (init) { init.textContent = (name[0] || '?').toUpperCase(); init.style.display = ''; }
    }
    showSection('profile');
};

// ═══════════════════════════════════════════════════════════
// 17. FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════
window.openForgotPassword = (e) => {
    e.preventDefault();
    const email = prompt('Enter your email address to reset password:');
    if (!email) return;
    if (!email.includes('@')) { alert('❌ Please enter a valid email address!'); return; }
    if (confirm(`Send password reset email to: ${email}?`)) {
        auth.sendPasswordResetEmail(email)
            .then(() => alert(`✅ Password reset email sent to ${email}!\n\nCheck your inbox and spam folder.`))
            .catch(error => alert('❌ ' + friendlyAuthError(error)));
    }
};

// ═══════════════════════════════════════════════════════════
// 18. PWA — Service Worker
// ═══════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => { console.log('SW registered:', reg.scope); window._swReg = reg; })
            .catch(err => console.log('SW registration failed:', err));
    });
}

// ═══════════════════════════════════════════════════════════
// 19. NOTIFICATIONS SYSTEM
// ═══════════════════════════════════════════════════════════
const VAPID_PUBLIC_KEY = 'BBIaVXF1wlqwE_41UCqmXQpi89u0tIt5UUHjibouttw0b_BE-Xt7EmTaNaP8JY0wYH279aiWlUVSQ2w6zbr00Tc';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

window.requestNotificationPermission = async () => {
    if (!('Notification' in window)) { alert('This browser does not support notifications.'); return; }
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

async function saveNotificationToken() {
    if (!currentUser) return;
    try {
        const reg = window._swReg || await navigator.serviceWorker.ready;
        if (!reg.pushManager) return;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            if (VAPID_PUBLIC_KEY.startsWith('BBIaVXF1')) return;
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
        }
        await db.collection('users').doc(currentUser.uid).update({
            pushSubscription: JSON.stringify(sub), notifEnabled: true, notifUpdatedAt: new Date().toISOString()
        });
    } catch (err) { console.warn('Push subscription failed:', err); }
}

function showToast(msg, type = 'info') {
    const existing = document.getElementById('sadhana-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'sadhana-toast';
    const bg = type === 'success' ? '#16a34a' : type === 'warn' ? '#d97706' : type === 'error' ? '#dc2626' : '#1A3C5E';
    toast.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:${bg};color:white;padding:12px 22px;border-radius:12px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.2);max-width:90vw;text-align:center;transition:opacity 0.4s;`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 3500);
}

async function sendInAppNotification(userId, title, body) {
    try {
        await db.collection('notifications').add({ userId, title, body, read: false, createdAt: new Date().toISOString() });
    } catch (err) { console.warn('Notification save failed:', err); }
}

async function loadUserNotifications() {
    if (!currentUser) return;
    try {
        const snap = await db.collection('notifications')
            .where('userId', '==', currentUser.uid)
            .where('read', '==', false)
            .orderBy('createdAt', 'desc')
            .limit(10).get();
        const count = snap.docs.length;
        const badge = document.getElementById('sidebar-notif-badge');
        if (badge) {
            if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
            else { badge.classList.add('hidden'); }
        }
        if (count > 0) {
            const latest = snap.docs[0].data();
            showToast(`${latest.title}: ${latest.body}`, 'info');
            snap.docs.forEach(d => d.ref.update({ read: true }));
        }
    } catch (err) { /* silent fail */ }
}

async function checkSadhanaReminder() {
    if (!currentUser || isSuperAdmin()) return;
    try {
        const today = localDateStr(0);
        const yesterday = localDateStr(1);
        const dayBefore = localDateStr(2);
        const snap = await db.collection('users').doc(currentUser.uid).collection('sadhana')
            .where(firebase.firestore.FieldPath.documentId(), 'in', [today, yesterday, dayBefore]).get();
        const submitted = new Set(snap.docs.map(d => d.id));
        const missedDays = [yesterday, dayBefore].filter(d => !submitted.has(d) && d >= APP_START);
        if (missedDays.length >= 2 && Notification.permission === 'granted') {
            new Notification('🙏 Sadhna Reminder', { body: `You haven't filled Sadhna for ${missedDays.length} days. Please submit now.`, icon: '' });
        }
        if (missedDays.length >= 2) showToast(`⚠️ Sadhna pending for ${missedDays.length} days — please fill now!`, 'warn');
    } catch (err) { console.warn('Reminder check failed:', err); }
}

window._sendRoleNotification = async (userId, userName, newRole, category) => {
    let msg = '';
    if (newRole === 'superAdmin') msg = 'You have been promoted to Super Admin!';
    else if (newRole === 'admin' && category) msg = `You have been made Admin — ${category.replace(' Co-ordinator','').replace(' Coordinator','')}`;
    else if (newRole === 'shift') msg = `You have been moved to ${category}.`;
    else if (newRole === 'user') msg = 'Your admin role has been updated.';
    if (msg) await sendInAppNotification(userId, '👑 Role Update', msg);
};

// ── Init notifications — only show gear btn for non-superAdmin ──
window._initNotifications = () => {
    loadUserNotifications();
    checkSadhanaReminder();
    // Admin gear btn removed — navigation now uses bottom nav
};

// ═══════════════════════════════════════════════════════════
// 20. USER SIDEBAR
// ═══════════════════════════════════════════════════════════
window.openUserSidebar = () => {
    document.getElementById('user-sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    if (typeof userProfile !== 'undefined' && userProfile) {
        const n = document.getElementById('sidebar-user-name');
        const r = document.getElementById('sidebar-user-role');
        if (n) n.textContent = userProfile.name || '';
        if (r) r.textContent = userProfile.role === 'superAdmin' ? 'Super Admin' : userProfile.role === 'admin' ? 'Admin - ' + (userProfile.level||'') : userProfile.level || '';
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
window.openUserGuide = () => { document.getElementById('user-guide-modal').classList.remove('hidden'); };
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
        list.innerHTML = snap.docs.map(d => { const n=d.data(); const u=!n.read; return '<div style="padding:10px 12px;border-radius:8px;margin-bottom:6px;background:'+(u?'#eff6ff':'#f9fafb')+';border-left:3px solid '+(u?'#3b82f6':'#e5e7eb')+'"><div style="font-weight:600;font-size:13px;">'+(n.title||'')+'</div><div style="font-size:12px;color:#555;margin-top:2px;">'+(n.body||'')+'</div><div style="font-size:10px;color:gray;margin-top:4px;">'+(n.createdAt||'').slice(0,10)+'</div></div>'; }).join('');
        snap.docs.forEach(d => { if (!d.data().read) d.ref.update({read:true}); });
        const badge = document.getElementById('sidebar-notif-badge');
        if (badge) badge.classList.add('hidden');
    } catch(e) { console.warn(e); }
};

// ═══════════════════════════════════════════════════════════
// BEST & WEAK PERFORMERS + USER WCR
// ═══════════════════════════════════════════════════════════

// ── Global state ──────────────────────────────────────────
let _perfTab      = 'weekly';
let _perfAllData  = [];   // full sorted array for current filter
let _perfYear     = null;
let _perfMonth    = null; // 0-indexed
let _perfWeekIdx  = 0;    // index into weeks of selected month
let _activeFilter = '';   // '', 'SB', 'IGF', 'IYF', 'ICF'

// ── Init year/month dropdowns ─────────────────────────────
function initPerfDropdowns() {
    const now     = new Date();
    const curYear = now.getFullYear();
    const curMon  = now.getMonth(); // 0-indexed

    // Build year options
    const startYear = parseInt(APP_START.split('-')[0]);
    let yearHtml = '';
    for (let y = curYear; y >= startYear; y--) {
        yearHtml += `<option value="${y}">${y}</option>`;
    }

    // Default: current month (1st–30/31st cycle)
    let defYear = curYear, defMon = curMon;

    // Populate both user-WCR and SA year dropdowns
    ['perf-year-sel', 'sa-perf-year-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = yearHtml; el.value = defYear; }
    });
    _perfYear = defYear;

    populateMonthDropdown(defYear, curYear, curMon);
    ['perf-month-sel', 'sa-perf-month-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = defMon;
    });
    _perfMonth = defMon;

    populateWeekDropdown();
}

function populateMonthDropdown(selYear, curYear, curMon) {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const maxMon  = (selYear === curYear) ? curMon : 11; // include current month
    const startMon = selYear === parseInt(APP_START.split('-')[0]) ? parseInt(APP_START.split('-')[1])-1 : 0;
    let html = '';
    for (let m = startMon; m <= Math.max(maxMon, 0); m++) {
        html += `<option value="${m}">${MONTHS[m]}</option>`;
    }
    const defVal = Math.max(maxMon, 0);
    ['perf-month-sel', 'sa-perf-month-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = html; el.value = defVal; }
    });
    _perfMonth = defVal;
}

function populateWeekDropdown() {
    const weeks = getWeeksInMonth(
        `${_perfYear}-${String(_perfMonth+1).padStart(2,'0')}-01`,
        new Date(_perfYear, _perfMonth+1, 0).toISOString().split('T')[0]
    );
    const fmt = d => `${String(d.getDate()).padStart(2,'0')} ${d.toLocaleString('en-GB',{month:'short'})}`;
    let html = '';
    weeks.forEach((sunStr, i) => {
        const sun = new Date(sunStr);
        const sat = new Date(sunStr); sat.setDate(sat.getDate()+6);
        html += `<option value="${i}">${fmt(sun)} – ${fmt(sat)}</option>`;
    });
    // Default to previous week (current week is incomplete, so prev week is more meaningful)
    const defVal = Math.max(weeks.length - 2, 0);
    ['perf-week-sel', 'sa-perf-week-sel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = html; el.value = defVal; }
    });
    _perfWeekIdx = defVal;
}

function _syncWCR() { rerenderWCRForMonth(_perfYear, _perfMonth); }

window.onPerfYearChange = () => {
    const now = new Date();
    _perfYear = parseInt(document.getElementById('perf-year-sel').value);
    populateMonthDropdown(_perfYear, now.getFullYear(), now.getMonth());
    _perfMonth = parseInt(document.getElementById('perf-month-sel').value);
    populateWeekDropdown();
    renderPerformersFromCache();
    _syncWCR();
};
window.onPerfMonthChange = () => {
    _perfMonth = parseInt(document.getElementById('perf-month-sel').value);
    populateWeekDropdown();
    renderPerformersFromCache();
    _syncWCR();
};
window.onPerfWeekChange = () => {
    _perfWeekIdx = parseInt(document.getElementById('perf-week-sel').value) || 0;
    renderPerformersFromCache();
};

// ── SA-panel performer dropdown handlers ──────────────────
window.onSAPerfYearChange = () => {
    const now = new Date();
    _perfYear = parseInt(document.getElementById('sa-perf-year-sel').value);
    populateMonthDropdown(_perfYear, now.getFullYear(), now.getMonth());
    _perfMonth = parseInt(document.getElementById('sa-perf-month-sel').value);
    populateWeekDropdown();
    renderPerformersFromCache();
    _syncWCR();
};
window.onSAPerfMonthChange = () => {
    _perfMonth = parseInt(document.getElementById('sa-perf-month-sel').value);
    populateWeekDropdown();
    renderPerformersFromCache();
    _syncWCR();
};
window.onSAPerfWeekChange = () => {
    _perfWeekIdx = parseInt(document.getElementById('sa-perf-week-sel').value) || 0;
    renderPerformersFromCache();
};
window.setSAPerfTab = (tab, btn) => {
    _perfTab = tab;
    document.querySelectorAll('.perf-tab-btn').forEach(b => {
        b.style.background = 'white'; b.style.color = '#555'; b.style.borderColor = '#ddd';
    });
    btn.style.background = '#1A3C5E'; btn.style.color = 'white'; btn.style.borderColor = '#1A3C5E';
    const weekSel = document.getElementById('sa-perf-week-sel');
    if (weekSel) weekSel.style.display = tab === 'weekly' ? '' : 'none';
    renderPerformersFromCache();
};

window.setPerfTab = (tab, btn) => {
    _perfTab = tab;
    document.querySelectorAll('.perf-tab-btn').forEach(b => {
        b.style.background = 'white'; b.style.color = '#555'; b.style.borderColor = '#ddd';
    });
    btn.style.background = '#1A3C5E'; btn.style.color = 'white'; btn.style.borderColor = '#1A3C5E';
    const weekSel = document.getElementById('perf-week-sel');
    if (weekSel) weekSel.style.display = tab === 'weekly' ? '' : 'none';
    renderPerformersFromCache();
};

// ── Compute performers from cached sadhana data ───────────
function computePerformers(filteredDocs) {
    _perfAllData = [];
    if (!filteredDocs || !filteredDocs.length) { renderPerformersFromCache(); return; }

    filteredDocs.forEach(uDoc => {
        const u    = uDoc.data();
        const ents = (window._adminSadhanaCache || new Map()).get(uDoc.id) || [];
        _perfAllData.push({ id: uDoc.id, name: u.name, level: u.level||'', ents, joinedDate: u.joinedDate || APP_START });
    });

    initPerfDropdowns();
    renderPerformersFromCache();
}

function getWeeksInMonth(monthStart, monthEnd) {
    const weeks = [];
    const end   = new Date(monthEnd);
    const cur   = new Date(monthStart);
    cur.setDate(cur.getDate() - cur.getDay()); // go to Sunday
    while (cur <= end) {
        weeks.push(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 7);
    }
    return weeks;
}

function getBestActivity(ents, fromDate, days) {
    const sums   = { sleep:0, wakeup:0, chanting:0, reading:0, hearing:0, service:0 };
    const labels = { sleep:'Bed Time', wakeup:'Wake Up', chanting:'Chanting', reading:'Reading', hearing:'Hearing', service:'Service' };
    let counted  = 0;
    for (let i = 0; i < days; i++) {
        const d  = new Date(fromDate); d.setDate(d.getDate() + i);
        const ds = d.toISOString().split('T')[0];
        const en = ents.find(e => e.date === ds);
        if (!en || !en.scores) continue;
        Object.keys(sums).forEach(k => { sums[k] += (en.scores[k] || 0); });
        counted++;
    }
    if (!counted) return 'N/A';
    return labels[Object.entries(sums).sort((a,b) => b[1]-a[1])[0][0]];
}

function renderPerformersFromCache() {
    if (!_perfAllData.length) {
        ['best-performers-chart','weak-performers-chart','sa-best-performers-chart','sa-weak-performers-chart'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<div class="perf-empty">No data yet</div>';
        });
        return;
    }

    // Apply active level filter
    let data = _perfAllData;
    if (_activeFilter) {
        data = data.filter(u => {
            const lvl = u.level;
            if (_activeFilter === 'SB')  return lvl === 'Senior Batch';
            if (_activeFilter === 'IGF') return lvl === 'IGF Co-ordinator';
            if (_activeFilter === 'IYF') return lvl === 'IYF Co-ordinator';
            if (_activeFilter === 'ICF') return lvl === 'ICF Coordinator';
            return true;
        });
    }

    const monthStart = `${_perfYear}-${String(_perfMonth+1).padStart(2,'0')}-01`;
    const monthEnd   = new Date(_perfYear, _perfMonth+1, 0).toISOString().split('T')[0];
    const weeks      = getWeeksInMonth(monthStart, monthEnd);

    const scores = [];

    data.forEach(({ name, level: perfLevel, ents, joinedDate }) => {
        let pct = 0;
        const pJd = joinedDate || APP_START;

        const todayP = localDateStr(0);
        if (_perfTab === 'weekly') {
            const weekSun = weeks[Math.min(_perfWeekIdx, weeks.length-1)] || weeks[0];
            if (!weekSun) return;
            let tot = 0; const wEnts = [];
            for (let i = 0; i < 7; i++) {
                const d  = new Date(weekSun); d.setDate(d.getDate() + i);
                const ds = d.toISOString().split('T')[0];
                if (ds < APP_START || ds > todayP || ds < pJd) continue;
                const en = ents.find(e => e.date === ds);
                if (en) { tot += en.score; wEnts.push({id:ds, sleepTime:en.sleepTime||''}); }
                else if (ds < todayP) { tot += nrPenalty(perfLevel); } // only penalize past days
            }
            const fd = fairDenominator(weekSun, wEnts, pJd);
            pct = fd > 0 ? Math.round((tot / fd) * 100) : 0;
            const bestAct = getBestActivity(ents, weekSun, 7);
            scores.push({ name, pct, bestAct });

        } else {
            // Monthly: average of weekly % for all weeks in month
            let sum = 0, count = 0;
            weeks.forEach(weekSun => {
                let tot = 0; const wEnts = [];
                for (let i = 0; i < 7; i++) {
                    const d  = new Date(weekSun); d.setDate(d.getDate() + i);
                    const ds = d.toISOString().split('T')[0];
                    if (ds < monthStart || ds > monthEnd || ds < APP_START || ds > todayP || ds < pJd) continue;
                    const en = ents.find(e => e.date === ds);
                    if (en) { tot += en.score; wEnts.push({id:ds, sleepTime:en.sleepTime||''}); }
                    else if (ds < todayP) { tot += nrPenalty(perfLevel); } // only penalize past days
                }
                const fd = fairDenominator(weekSun, wEnts, pJd);
                if (fd > 160) { sum += Math.round((tot/fd)*100); count++; }
            });
            pct = count > 0 ? Math.round(sum / count) : 0;
            const bestAct = getBestActivity(ents, monthStart, new Date(_perfYear, _perfMonth+1, 0).getDate());
            scores.push({ name, pct, bestAct });
        }
    });

    scores.sort((a,b) => b.pct - a.pct);
    const best = scores.slice(0, 3);
    const weak = [...scores].reverse().slice(0, 3);

    renderRing('best-performers-chart', best,
        ['#1d4ed8','#3b82f6','#93c5fd'], true);
    renderRing('weak-performers-chart', weak,
        ['#dc2626','#f97316','#fbbf24'], false);
    // Also render into SA panel charts
    renderRing('sa-best-performers-chart', best,
        ['#1d4ed8','#3b82f6','#93c5fd'], true);
    renderRing('sa-weak-performers-chart', weak,
        ['#dc2626','#f97316','#fbbf24'], false);

    // Highlight matching WCR column
    highlightWCRColumn();
}

function highlightWCRColumn() {
    // Remove existing highlights
    document.querySelectorAll('.col-highlight').forEach(el => el.classList.remove('col-highlight'));

    if (_perfTab !== 'weekly') return; // only highlight for weekly view

    const monthStart = `${_perfYear}-${String(_perfMonth+1).padStart(2,'0')}-01`;
    const monthEnd   = new Date(_perfYear, _perfMonth+1, 0).toISOString().split('T')[0];
    const weeks      = getWeeksInMonth(monthStart, monthEnd);
    const selectedSun = weeks[Math.min(_perfWeekIdx, weeks.length-1)];
    if (!selectedSun) return;

    // Find which column in the comp-table matches this week's sunStr
    ['comp-perf-table', 'admin-comparative-reports-container'].forEach(containerId => {
        const table = document.getElementById(containerId)?.querySelector?.('table') ||
                      document.getElementById(containerId);
        if (!table || !table.querySelector) return;
        const ths = table.querySelectorAll('th.comp-th');
        let matchCol = -1;
        ths.forEach((th, i) => {
            // The header text is like "01 Mar to 07 Mar"
            // Convert selectedSun to the same format to match
            const sun = new Date(selectedSun);
            const sat = new Date(selectedSun); sat.setDate(sat.getDate() + 6);
            const fmt = d => `${String(d.getDate()).padStart(2,'0')} ${d.toLocaleString('en-GB',{month:'short'})}`;
            const expected = `${fmt(sun)} to ${fmt(sat)}`;
            if (th.textContent.trim().includes(fmt(sun))) matchCol = i;
        });
        if (matchCol < 0) return;

        // Highlight the header
        ths[matchCol]?.classList.add('col-highlight');

        // Highlight all cells in that column
        table.querySelectorAll('tbody tr').forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds[matchCol]) tds[matchCol].classList.add('col-highlight');
        });
    });
}

function renderRing(containerId, data, colors, isBest) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!data.length) { el.innerHTML = '<div class="perf-empty">Not enough data</div>'; return; }

    const cx = 85, cy = 85, size = 170;
    const rings = [{r:68,sw:13},{r:50,sw:13},{r:32,sw:13}];

    let svg = `<svg viewBox="0 0 ${size} ${size}" class="perf-rings-svg">`;

    // Track rings (bg)
    rings.forEach(({r, sw}) => {
        const circ = 2 * Math.PI * r;
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f0f0f0"
            stroke-width="${sw}" stroke-dasharray="${circ}"/>`;
    });

    // Data rings
    data.forEach(({name, pct, bestAct}, i) => {
        if (i >= rings.length) return;
        const {r, sw} = rings[i];
        const circ  = 2 * Math.PI * r;
        const fillP = Math.max(Math.min(pct, 100), 0);
        const dash  = (fillP / 100) * circ;
        const safeN = (name||'').replace(/"/g,'&quot;');
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[i]}"
            stroke-width="${sw}" stroke-dasharray="${dash} ${circ-dash}"
            stroke-dashoffset="${circ*0.25}" stroke-linecap="round">
            <title>${name}: ${pct}% | Best: ${bestAct}</title>
        </circle>`;
    });

    // Center text
    const topPct = data[0]?.pct ?? 0;
    const topCol = isBest ? colors[0] : '#dc2626';
    svg += `<text x="${cx}" y="${cy-6}" text-anchor="middle" font-size="19"
        font-weight="800" fill="${topCol}">${topPct}%</text>`;
    svg += `<text x="${cx}" y="${cy+12}" text-anchor="middle" font-size="9"
        fill="#aaa">${isBest?'top score':'lowest'}</text>`;
    svg += '</svg>';

    // Legend
    let legend = '<div>';
    data.forEach(({name, pct, bestAct}, i) => {
        const pColor = pct >= 50 ? '#15803d' : pct >= 20 ? '#d97706' : '#dc2626';
        legend += `<div class="perf-legend-item">
            <div class="perf-legend-dot" style="background:${colors[i]};"></div>
            <div style="flex:1;min-width:0;">
                <div class="perf-legend-name" style="color:${colors[i]};">${name}</div>
                <div class="perf-legend-act">${bestAct}</div>
            </div>
            <div class="perf-legend-pct" style="color:${pColor};">${pct}%</div>
        </div>`;
    });
    legend += '</div>';

    el.innerHTML = svg + legend;
}

// ═══════════════════════════════════════════════════════════
// 21. PROFILE PICTURE
// ═══════════════════════════════════════════════════════════
window._profilePicDataUrl = null;

// Compress selected image to 200×200 JPEG, store as base64 for preview + save
window.handleProfilePicSelect = (input) => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX = 200;
            let w = img.width, h = img.height;
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else       { w = Math.round(w * MAX / h); h = MAX; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            window._profilePicDataUrl = dataUrl;
            // Update preview
            const preview = document.getElementById('profile-pic-preview');
            const init    = document.getElementById('profile-pic-init');
            if (preview) { preview.src = dataUrl; preview.style.display = ''; }
            if (init)    init.style.display = 'none';
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
};

// Update all avatar elements (header, sidebar, profile preview) from a photoURL or name initials
function updateAvatarDisplay(photoURL, name) {
    const initial = (name || '?')[0].toUpperCase();
    const pairs = [
        ['header-av-img', 'header-av-init'],
        ['sidebar-av-img', 'sidebar-av-init'],
    ];
    pairs.forEach(([imgId, initId]) => {
        const img  = document.getElementById(imgId);
        const init = document.getElementById(initId);
        if (!img || !init) return;
        if (photoURL) {
            img.src = photoURL; img.style.display = '';
            init.style.display = 'none';
        } else {
            img.style.display  = 'none';
            init.textContent   = initial;
            init.style.display = '';
        }
    });
    // Sidebar name/role are set elsewhere; just update the sidebar user name display
    const sName = document.getElementById('sidebar-user-name');
    if (sName && name) sName.textContent = name;
}

// Helper: build a small inline avatar HTML for use in leaderboard/performers
function avatarHtml(photoURL, name, size) {
    const sz = size || 32;
    const initial = (name || '?')[0].toUpperCase();
    if (photoURL) {
        return `<div class="av" style="width:${sz}px;height:${sz}px;flex-shrink:0;"><img src="${photoURL}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`;
    }
    return `<div class="av" style="width:${sz}px;height:${sz}px;flex-shrink:0;"><span class="av-init" style="font-size:${Math.round(sz*0.38)}px;">${initial}</span></div>`;
}

// ═══════════════════════════════════════════════════════════
// 22. LEADERBOARD
// ═══════════════════════════════════════════════════════════
let _lbLoading         = false;
let _lbRequestId       = 0;   // incremented on each load to cancel stale responses
let _lbCategoryFilter  = ''; // '' = all, or specific level string
let _lbMode            = 'current-week'; // 'daily' | 'current-week' | 'prev-week'

// Returns { dates[], weekStart Date, weekEnd Date } for offset 0=this week, 1=last week
function getWeekDates(weekOffset) {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sunday
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dayOfWeek - (weekOffset * 7));
    weekStart.setHours(0,0,0,0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    // Current week: cap at yesterday (today is still in progress)
    if (weekOffset === 0) {
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
        if (weekEnd > yesterday) weekEnd.setTime(yesterday.getTime());
    }
    const toStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dates = [];
    const cur = new Date(weekStart);
    while (cur <= weekEnd) { dates.push(toStr(cur)); cur.setDate(cur.getDate() + 1); }
    return { dates, weekStart, weekEnd };
}

// Sync leaderboard mode tabs and reload
window.setLbMode = (mode, btn) => {
    _lbMode = mode;
    const modeIdx = ['daily','current-week','prev-week'].indexOf(mode);
    ['lb-mode-tabs','sa-lb-mode-tabs'].forEach(id => {
        const tabs = document.querySelectorAll(`#${id} .chart-tab-btn`);
        tabs.forEach((b, i) => b.classList.toggle('active', i === modeIdx));
    });
    loadLeaderboard(true);
};

// SA category filter for leaderboard
window.setLbFilter = (cat, btn) => {
    _lbCategoryFilter = cat;
    document.querySelectorAll('.lb-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadLeaderboard(true);
};

window.loadLeaderboard = async (force) => {
    if (_lbLoading && !force) return;
    _lbLoading = true;
    const thisReqId = ++_lbRequestId;

    const isWeekly = _lbMode === 'current-week' || _lbMode === 'prev-week';

    // Decide which containers to update
    const containers = [];
    const userCont  = document.getElementById('leaderboard-container');
    const saCont    = document.getElementById('sa-leaderboard-container');
    const userLabel = document.getElementById('lb-date-label');
    const saLabel   = document.getElementById('sa-lb-date-label');

    if (userCont && !isSuperAdmin()) containers.push({ cont: userCont, label: userLabel });
    if (saCont   && isAnyAdmin())    containers.push({ cont: saCont,   label: saLabel   });
    if (!containers.length) { _lbLoading = false; return; }
    containers.forEach(({ cont }) => { cont.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>'; });

    try {
        const usersSnap = await db.collection('users').get();

        // Determine level(s) to show based on role
        let levelFilter;
        if (isSuperAdmin()) {
            levelFilter = _lbCategoryFilter ? [_lbCategoryFilter] : ['Senior Batch','IGF Co-ordinator','IYF Co-ordinator','ICF Coordinator'];
        } else if (isCategoryAdmin()) {
            levelFilter = [userProfile.adminCategory];
        } else {
            levelFilter = [userProfile.level || 'Senior Batch'];
        }

        const filtered = usersSnap.docs.filter(doc => levelFilter.includes(doc.data().level || 'Senior Batch'));
        const rows = [];
        let dateDisp = '';

        if (!isWeekly) {
            // ── Daily: show yesterday's snapshot ──
            const targetDate = localDateStr(1);
            dateDisp = new Date(targetDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long' });
            const daySnaps = await Promise.all(filtered.map(uDoc => uDoc.ref.collection('sadhana').doc(targetDate).get()));
            filtered.forEach((uDoc, i) => {
                const u = uDoc.data(), snap = daySnaps[i];
                if (!snap.exists) return;
                const d = snap.data();
                if (!d.sleepTime || d.sleepTime === 'NR') return;
                rows.push({
                    uid: uDoc.id, name: u.name || '—', photo: u.photoURL || null,
                    level:    (u.level || '').replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB'),
                    score:    d.totalScore ?? 0,
                    pct:      d.dayPercent ?? 0,
                    days:     null,
                    rejected: !!d.rejected
                });
            });
        } else {
            // ── Weekly: aggregate over date range ──
            const weekOffset = _lbMode === 'prev-week' ? 1 : 0;
            const { dates, weekStart, weekEnd } = getWeekDates(weekOffset);
            if (!dates.length) {
                // Early in the week (e.g. Sunday) — no completed days yet, show message
                const fmtD = d => d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
                dateDisp = `${fmtD(weekStart)} – ${fmtD(weekEnd)} (week just started)`;
                containers.forEach(({ cont, label }) => {
                    if (label) label.textContent = dateDisp;
                    cont.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Week just started — no completed days yet. Check back tomorrow!</p>';
                });
                _lbLoading = false; return;
            }
            const startStr = dates[0], endStr = dates[dates.length - 1];
            const fmtD = d => d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
            dateDisp = `${fmtD(weekStart)} – ${fmtD(weekEnd)}`;
            const weekSnaps = await Promise.all(filtered.map(uDoc =>
                uDoc.ref.collection('sadhana')
                    .where(firebase.firestore.FieldPath.documentId(), '>=', startStr)
                    .where(firebase.firestore.FieldPath.documentId(), '<=', endStr)
                    .get()
            ));
            filtered.forEach((uDoc, i) => {
                const u = uDoc.data();
                const validDocs = weekSnaps[i].docs.filter(d => {
                    const data = d.data();
                    return data.sleepTime && data.sleepTime !== 'NR';
                });
                if (validDocs.length === 0) return;
                const totalScore = validDocs.reduce((sum, d) => sum + (d.data().totalScore ?? 0), 0);
                const avgPct     = Math.round(validDocs.reduce((sum, d) => sum + (d.data().dayPercent ?? 0), 0) / validDocs.length);
                rows.push({
                    uid: uDoc.id, name: u.name || '—', photo: u.photoURL || null,
                    level:    (u.level || '').replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB'),
                    score:    totalScore,
                    pct:      avgPct,
                    days:     validDocs.length,
                    rejected: validDocs.some(d => d.data().rejected)
                });
            });
        }

        rows.sort((a, b) => b.score - a.score);
        const MEDALS = ['🥇','🥈','🥉'];

        // Cache user data for UAC clicks from leaderboard
        const _lbUserCache = {};
        filtered.forEach(uDoc => {
            const u = uDoc.data();
            const lvl = (u.level||'').replace(' Co-ordinator','').replace(' Coordinator','').replace('Senior Batch','SB');
            _lbUserCache[uDoc.id] = { name: u.name||'—', level: lvl, chanting: u.chantingCategory||'N/A', rounds: u.exactRounds||'?', role: u.role||'user' };
        });
        window._lbUserCache = _lbUserCache;

        // SA category filter bar
        const filterBar = isSuperAdmin() ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
            <button class="sa-lvl-btn lb-filter-btn${!_lbCategoryFilter?' active':''}" onclick="setLbFilter('',this)">All</button>
            <button class="sa-lvl-btn lb-filter-btn${_lbCategoryFilter==='Senior Batch'?' active':''}" onclick="setLbFilter('Senior Batch',this)">Senior Batch</button>
            <button class="sa-lvl-btn lb-filter-btn${_lbCategoryFilter==='IGF Co-ordinator'?' active':''}" onclick="setLbFilter('IGF Co-ordinator',this)">IGF</button>
            <button class="sa-lvl-btn lb-filter-btn${_lbCategoryFilter==='IYF Co-ordinator'?' active':''}" onclick="setLbFilter('IYF Co-ordinator',this)">IYF</button>
            <button class="sa-lvl-btn lb-filter-btn${_lbCategoryFilter==='ICF Coordinator'?' active':''}" onclick="setLbFilter('ICF Coordinator',this)">ICF</button>
        </div>` : '';

        const listHtml = rows.length === 0
            ? '<p style="color:#aaa;text-align:center;padding:20px;">No entries found for this period.</p>'
            : rows.map((r, i) => {
                const isSelf     = r.uid === currentUser.uid;
                const scoreColor = r.score >= (isWeekly ? 500 : 100) ? '#15803d' : r.score >= (isWeekly ? 300 : 60) ? '#d97706' : '#dc2626';
                const medal      = i < 3 ? MEDALS[i] : `<span style="font-size:13px;font-weight:700;color:#9ca3af;">#${i+1}</span>`;
                const subLine    = r.days !== null ? `avg ${r.pct}% · ${r.days}d` : `${r.pct}%`;
                const clickAttr  = isAnyAdmin() ? ` onclick="lbRowClick('${r.uid}')" style="cursor:pointer;"` : '';
                return `<div class="lb-row${isSelf ? ' lb-self' : ''}"${clickAttr}>
                    <div class="lb-rank">${medal}</div>
                    ${avatarHtml(r.photo, r.name, 34)}
                    <div class="lb-name">${r.name}<span style="font-size:10px;color:#9ca3af;margin-left:5px;">${r.level}</span></div>
                    <div class="lb-score-wrap">
                        <div class="lb-score" style="color:${scoreColor};">${r.rejected ? '🚫' : r.score}</div>
                        <div class="lb-pct">${r.rejected ? 'Rejected' : subLine}</div>
                    </div>
                </div>`;
            }).join('');

        // Podium for top 3 — both user and SA leaderboard
        ['lb-podium', 'sa-lb-podium'].forEach(podiumId => {
            const podiumEl = document.getElementById(podiumId);
            if (!podiumEl) return;
            if (rows.length < 2) { podiumEl.style.display = 'none'; return; }
            const top3 = rows.slice(0, Math.min(3, rows.length));
            const badges = ['','🥇','🥈','🥉'];
            // Visual order: 2nd | 1st (center, tallest) | 3rd
            const order = top3.length === 2
                ? [{ p: top3[1], rank: 2 }, { p: top3[0], rank: 1 }]
                : [{ p: top3[1], rank: 2 }, { p: top3[0], rank: 1 }, { p: top3[2], rank: 3 }];
            // Staggered reveal: 3rd → pause → 2nd → pause → 1st (dramatic buildup)
            const delays = order.length === 2 ? [0.4, 1.2] : [0.4, 1.6, 1.0];
            podiumEl.style.display = 'flex';
            podiumEl.innerHTML = order.map(({ p, rank }, di) => {
                const initials = (p.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
                const avatarInner = p.photo
                    ? `<img src="${p.photo}" alt="" onerror="this.outerHTML='${initials}'">`
                    : initials;
                return `<div class="lb-podium-item rank${rank} reveal" style="animation-delay:${delays[di]}s;">
                    <div class="lb-podium-badge">${badges[rank]}</div>
                    <div class="lb-podium-avatar rank${rank}">${avatarInner}</div>
                    <div class="lb-podium-name">${p.name}</div>
                    <div class="lb-podium-score">${p.score} pts</div>
                </div>`;
            }).join('');
            // Party popper for 1st place reveal
            const wrap = podiumEl.closest('.lb-podium-wrap');
            if (wrap) {
                const old = wrap.querySelector('.lb-confetti');
                if (old) old.remove();
                const confetti = document.createElement('div');
                confetti.className = 'lb-confetti';
                confetti.textContent = '🎉';
                wrap.appendChild(confetti);
                setTimeout(() => confetti.remove(), 4000);
            }
        });

        // If a newer request was fired, discard this stale result
        if (thisReqId !== _lbRequestId) { _lbLoading = false; return; }

        containers.forEach(({ cont, label }) => {
            if (label) label.textContent = `${dateDisp} · ${rows.length} submitted`;
            cont.innerHTML = filterBar + listHtml;
        });
    } catch (e) {
        if (thisReqId !== _lbRequestId) { _lbLoading = false; return; }
        containers.forEach(({ cont }) => { cont.innerHTML = `<p style="color:#dc2626;text-align:center;padding:20px;">Error loading leaderboard.</p>`; });
    }
    _lbLoading = false;
};

// ═══════════════════════════════════════════════════════════
// 23. TASKS
// ═══════════════════════════════════════════════════════════

// Open UAC from leaderboard row click
window.lbRowClick = (uid) => {
    const c = window._lbUserCache && window._lbUserCache[uid];
    if (!c) return;
    openUAC(uid, c.name, c.level, c.chanting, c.rounds, c.role);
};

// Scroll to tasks section (from header bell)
window.scrollToTasks = () => {
    switchTab('home');
    setTimeout(() => {
        const el = document.getElementById('tasks-container');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
};

// Regular user view — loads tasks applicable to their category
window.loadTasks = async () => {
    const cont = document.getElementById('tasks-container');
    if (!cont) return;
    cont.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    try {
        const snap  = await db.collection('tasks').orderBy('createdAt', 'desc').get();
        const level = userProfile.level || '';
        const tasks = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(t => t.targetCategory === 'all' || t.targetCategory === level);
        if (tasks.length === 0) {
            cont.innerHTML = '<p style="color:#aaa;text-align:center;padding:24px;">No tasks posted yet.</p>';
            return;
        }
        cont.innerHTML = tasks.map(t => buildTaskCard(t, false)).join('');
    } catch (e) {
        cont.innerHTML = '<p style="color:#dc2626;text-align:center;padding:20px;">Error loading tasks.</p>';
    }
};

// SA view — loads all tasks with delete button + completion status
window.loadSATasks = async () => {
    const cont = document.getElementById('sa-tasks-container');
    if (!cont) return;
    cont.innerHTML = '<p style="color:#aaa;text-align:center;padding:20px;">Loading…</p>';
    try {
        // Fetch tasks + all users in parallel
        const [taskSnap, usersSnap] = await Promise.all([
            db.collection('tasks').orderBy('createdAt', 'desc').get(),
            db.collection('users').get()
        ]);
        if (taskSnap.empty) {
            cont.innerHTML = '<p style="color:#aaa;text-align:center;padding:24px;">No tasks posted yet.</p>';
            return;
        }
        // Build user map {uid: {name, level}}
        const allUsers = {};
        usersSnap.forEach(d => {
            const u = d.data();
            if (u.role !== 'superAdmin') allUsers[d.id] = { name: u.name || d.id, level: u.level || '' };
        });
        cont.innerHTML = taskSnap.docs.map(d => buildTaskCard({ id: d.id, ...d.data() }, true, allUsers)).join('');
    } catch (e) {
        cont.innerHTML = '<p style="color:#dc2626;text-align:center;padding:20px;">Error loading tasks.</p>';
    }
};

function buildTaskCard(t, showDelete, allUsers) {
    const catLabel = t.targetCategory === 'all' ? '📢 All' : t.targetCategory;
    const dateStr  = t.createdAt ? new Date(t.createdAt.toDate ? t.createdAt.toDate() : t.createdAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '';
    const linkHtml = t.attachmentUrl
        ? `<a href="${t.attachmentUrl}" target="_blank" rel="noopener" class="task-link">🔗 ${t.attachmentUrl}</a>`
        : '';
    const delBtn = showDelete
        ? `<button class="task-del-btn" onclick="deleteTask('${t.id}')" title="Delete task">🗑</button>`
        : '';
    const completedBy = t.completedBy || [];
    const isDone = currentUser && completedBy.includes(currentUser.uid);

    // Done button for regular users
    const doneBtn = (!showDelete && currentUser)
        ? `<button class="task-done-btn${isDone ? ' completed' : ''}" id="done-${t.id}"
            onclick="markTaskDone('${t.id}')" ${isDone ? 'disabled' : ''}>
            ${isDone ? '✅ Done' : '☐ Mark Done'}
           </button>`
        : '';

    // SA: full completion status with names
    let statusHtml = '';
    if (showDelete && allUsers) {
        const targetUsers = Object.entries(allUsers)
            .filter(([, u]) => t.targetCategory === 'all' || u.level === t.targetCategory)
            .map(([uid, u]) => ({ uid, name: u.name }));
        const doneSet = new Set(completedBy);
        const doneUsers = targetUsers.filter(u => doneSet.has(u.uid));
        const pendingUsers = targetUsers.filter(u => !doneSet.has(u.uid));
        const total = targetUsers.length;
        const doneCount = doneUsers.length;
        const pendingCount = pendingUsers.length;
        const pct = total > 0 ? Math.round(doneCount * 100 / total) : 0;
        const pColor = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';

        const doneList = doneUsers.map(u => `<div class="task-user-row"><span class="tud">✅</span> ${u.name}</div>`).join('');
        const pendList = pendingUsers.map(u => `<div class="task-user-row"><span class="tup">⬜</span> ${u.name}</div>`).join('');

        statusHtml = `<div class="task-status-section">
            <button class="task-status-toggle" onclick="this.nextElementSibling.classList.toggle('open')">
                <span style="color:${pColor};font-weight:800;">${doneCount}/${total}</span> completed (${pct}%) · <span style="color:var(--danger);">${pendingCount} pending</span> ▾
            </button>
            <div class="task-status-detail">
                ${pendingCount > 0 ? `<div style="font-size:11px;font-weight:700;color:var(--danger);margin:6px 0 4px;">⬜ Pending (${pendingCount})</div>${pendList}
                <button class="task-remind-btn" onclick="remindPendingTask('${t.id}','${t.title.replace(/'/g,"\\'")}')">🔔 Send Reminder to Pending</button>` : ''}
                ${doneCount > 0 ? `<div style="font-size:11px;font-weight:700;color:var(--success);margin:8px 0 4px;">✅ Completed (${doneCount})</div>${doneList}` : ''}
            </div>
        </div>`;
    }

    return `<div class="task-card">
        ${delBtn}
        <div class="task-title">${t.title || '(No title)'}</div>
        ${t.body ? `<div class="task-body">${t.body}</div>` : ''}
        ${linkHtml}
        <div class="task-meta" style="margin-top:8px;">
            <span class="task-cat-badge">${catLabel}</span>
            Posted by ${t.createdByName || 'Admin'} · ${dateStr}
        </div>
        ${statusHtml}
        <div style="margin-top:8px;">${doneBtn}</div>
    </div>`;
}

window.markTaskDone = async (taskId) => {
    if (!currentUser) return;
    const btn = document.getElementById('done-' + taskId);
    if (btn) { btn.disabled = true; btn.textContent = '⏳…'; }
    try {
        await db.collection('tasks').doc(taskId).update({
            completedBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
        });
        if (btn) { btn.classList.add('completed'); btn.textContent = '✅ Done'; }
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = '☐ Mark Done'; }
        alert('Failed to mark task: ' + e.message);
    }
};

window.postTask = async () => {
    if (!isSuperAdmin()) return;
    const title = document.getElementById('task-title-input').value.trim();
    if (!title) { alert('Please enter a title for the task.'); return; }
    const body     = document.getElementById('task-body-input').value.trim();
    const url      = document.getElementById('task-url-input').value.trim();
    const category = document.getElementById('task-category-sel').value;
    try {
        await db.collection('tasks').add({
            title,
            body:           body  || '',
            attachmentUrl:  url   || '',
            targetCategory: category,
            createdByName:  userProfile.name || 'Super Admin',
            createdAt:      firebase.firestore.FieldValue.serverTimestamp()
        });
        document.getElementById('task-title-input').value = '';
        document.getElementById('task-body-input').value  = '';
        document.getElementById('task-url-input').value   = '';
        document.getElementById('task-category-sel').value = 'all';
        await loadSATasks();
        alert('✅ Task posted!');
    } catch (e) {
        alert('❌ Failed to post task: ' + e.message);
    }
};

window.remindPendingTask = async (taskId, taskTitle) => {
    if (!isSuperAdmin()) return;
    const btn = event.target;
    btn.disabled = true; btn.textContent = '⏳ Sending…';
    try {
        const taskDoc = await db.collection('tasks').doc(taskId).get();
        if (!taskDoc.exists) { alert('Task not found.'); return; }
        const t = taskDoc.data();
        const completedBy = new Set(t.completedBy || []);
        const usersSnap = await db.collection('users').get();
        const pending = [];
        usersSnap.forEach(d => {
            const u = d.data();
            if (u.role === 'superAdmin') return;
            if (t.targetCategory !== 'all' && u.level !== t.targetCategory) return;
            if (!completedBy.has(d.id)) pending.push(d.id);
        });
        const batch = db.batch();
        pending.forEach(uid => {
            const ref = db.collection('notifications').doc();
            batch.set(ref, {
                userId: uid,
                title: '🔔 Task Reminder',
                body: `Please complete: "${taskTitle}"`,
                read: false,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
        btn.textContent = `✅ Sent to ${pending.length}`;
        setTimeout(() => { btn.disabled = false; btn.textContent = '🔔 Send Reminder to Pending'; }, 3000);
    } catch (e) {
        btn.disabled = false; btn.textContent = '🔔 Send Reminder to Pending';
        alert('Failed: ' + e.message);
    }
};

window.deleteTask = async (taskId) => {
    if (!isSuperAdmin()) return;
    if (!confirm('Delete this task? This cannot be undone.')) return;
    try {
        await db.collection('tasks').doc(taskId).delete();
        await loadSATasks();
    } catch (e) {
        alert('❌ Failed to delete: ' + e.message);
    }
};

// ═══════════════════════════════════════════════════════════
// 24. ACTIVITY ANALYSIS
// ═══════════════════════════════════════════════════════════
let _aaUID = null, _aaName = null, _aaTab = 'current-week';
let _aaChartDonut = null, _aaChartBar = null;

window.uacActivity = () => {
    const uid = _uacUID, name = _uacName;
    closeUAC();
    openActivityAnalysis(uid, name);
};

window.openActivityAnalysis = (uid, name) => {
    _aaUID = uid; _aaName = name; _aaTab = 'current-week';
    document.getElementById('aa-user-name').textContent = name;
    document.getElementById('aa-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // Reset tab buttons to "This Week"
    document.querySelectorAll('.aa-tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    renderActivityAnalysis(uid, 'current-week');
};

window.closeActivityModal = () => {
    document.getElementById('aa-modal').classList.add('hidden');
    document.body.style.overflow = '';
    if (_aaChartDonut) { try { _aaChartDonut.destroy(); } catch(e){} _aaChartDonut = null; }
    if (_aaChartBar)   { try { _aaChartBar.destroy();   } catch(e){} _aaChartBar   = null; }
};

window.setAATab = (tab, btn) => {
    _aaTab = tab;
    document.querySelectorAll('.aa-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderActivityAnalysis(_aaUID, tab);
};

async function renderActivityAnalysis(uid, period) {
    const statusEl  = document.getElementById('aa-status');
    const donutWrap = document.getElementById('aa-donut-wrap');
    const barWrap   = document.getElementById('aa-bar-wrap');
    statusEl.textContent = 'Loading…';
    if (donutWrap) donutWrap.style.opacity = '0.3';
    if (barWrap)   barWrap.style.opacity   = '0.3';

    // Destroy previous charts
    if (_aaChartDonut) { try { _aaChartDonut.destroy(); } catch(e){} _aaChartDonut = null; }
    if (_aaChartBar)   { try { _aaChartBar.destroy();   } catch(e){} _aaChartBar   = null; }

    try {
        const weekOffset = period === 'prev-week' ? 1 : 0;
        const { dates, weekStart, weekEnd } = getWeekDates(weekOffset);
        const startStr = dates[0], endStr = dates[dates.length - 1];

        // Fetch entries and user profile in parallel
        const [saSnap, userSnap] = await Promise.all([
            db.collection('users').doc(uid).collection('sadhana')
                .where(firebase.firestore.FieldPath.documentId(), '>=', startStr)
                .where(firebase.firestore.FieldPath.documentId(), '<=', endStr)
                .get(),
            db.collection('users').doc(uid).get()
        ]);

        const level = userSnap.data()?.level || '';
        const isSB  = level === 'Senior Batch';

        const validDocs = saSnap.docs.filter(d => {
            const data = d.data();
            return data.sleepTime && data.sleepTime !== 'NR';
        });

        if (validDocs.length === 0) {
            statusEl.textContent = 'No entries found for this period.';
            if (donutWrap) donutWrap.style.opacity = '1';
            if (barWrap)   barWrap.style.opacity   = '1';
            return;
        }
        statusEl.textContent = '';

        // Activity definitions
        const actKeys   = ['sleep','wakeup','chanting','reading','hearing','service'];
        if (isSB) actKeys.push('notes');
        actKeys.push('daySleep');

        const actLabels = { sleep:'Sleep', wakeup:'Wake-up', chanting:'Chanting',
                            reading:'Reading', hearing:'Hearing', service:'Service',
                            notes:'Notes', daySleep:'Day Sleep' };
        const actMax    = { sleep:25, wakeup:25, chanting:25, reading:25, hearing:25,
                            service: isSB ? 10 : 25, notes:15, daySleep:10 };

        // Accumulate actual scores across the week
        const totals = {};
        actKeys.forEach(k => totals[k] = 0);
        validDocs.forEach(d => {
            const scores = d.data().scores || {};
            actKeys.forEach(k => { totals[k] += (scores[k] ?? 0); });
        });

        const n         = validDocs.length;
        // Actual weekly totals — same formula WCR uses
        const totalScore = validDocs.reduce((sum, d) => sum + (d.data().totalScore ?? 0), 0);
        const weekPct    = Math.round(totalScore * 100 / (n * 160));
        const weekScores = {};
        actKeys.forEach(k => { weekScores[k] = Math.round(totals[k] * 10) / 10; });

        const fmtD = d => d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
        document.getElementById('aa-period-label').textContent =
            `${fmtD(weekStart)} – ${fmtD(weekEnd)} · ${n} day${n>1?'s':''} · ${totalScore} pts`;

        if (donutWrap) donutWrap.style.opacity = '1';
        if (barWrap)   barWrap.style.opacity   = '1';

        // ── Donut chart (actual week %) ──
        const donutColor = weekPct >= 70 ? '#16a34a' : weekPct >= 50 ? '#d97706' : '#dc2626';
        const donutCanvas = document.getElementById('aa-donut-canvas');
        _aaChartDonut = new Chart(donutCanvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                datasets: [{
                    data: [weekPct, Math.max(0, 100 - weekPct)],
                    backgroundColor: [donutColor, '#e5e7eb'],
                    borderWidth: 0
                }]
            },
            options: {
                cutout: '74%',
                responsive: true,
                maintainAspectRatio: true,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                animation: { duration: 500 }
            },
            plugins: [{
                id: 'centerText',
                afterDraw(chart) {
                    const { ctx, chartArea: { left, top, width, height } } = chart;
                    const cx = left + width / 2, cy = top + height / 2;
                    ctx.save();
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.font = `bold ${Math.round(width * 0.2)}px Segoe UI`;
                    ctx.fillStyle = donutColor;
                    ctx.fillText(weekPct + '%', cx, cy - 7);
                    ctx.font = `${Math.round(width * 0.1)}px Segoe UI`;
                    ctx.fillStyle = '#6b7280';
                    ctx.fillText('week score', cx, cy + 12);
                    ctx.restore();
                }
            }]
        });

        // ── Horizontal bar chart (actual total pts per activity) ──
        const maxPossible = n * 25; // max any single activity can score per week
        const barColors = actKeys.map(k => {
            const maxK = actMax[k] * n;
            const pct  = maxK > 0 ? (weekScores[k] / maxK) * 100 : 0;
            return pct >= 75 ? '#16a34a' : pct >= 50 ? '#f59e0b' : '#ef4444';
        });

        const barCanvas = document.getElementById('aa-bar-canvas');
        _aaChartBar = new Chart(barCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: actKeys.map(k => actLabels[k]),
                datasets: [{
                    data:            actKeys.map(k => weekScores[k]),
                    backgroundColor: barColors,
                    borderRadius:    4,
                    barThickness:    14
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const k   = actKeys[ctx.dataIndex];
                                const maxK = actMax[k] * n;
                                const pctStr = maxK > 0 ? ` (${Math.round(weekScores[k]*100/maxK)}%)` : '';
                                return ` ${weekScores[k]} / ${maxK} pts${pctStr}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        min: Math.floor(-5 * n),
                        max: Math.ceil(25 * n),
                        grid: { color: '#f3f4f6' },
                        ticks: { font: { size: 10 } }
                    },
                    y: { ticks: { font: { size: 11 } } }
                }
            }
        });

    } catch (e) {
        statusEl.textContent = 'Error loading data.';
        console.error('Activity Analysis error:', e);
    }
}

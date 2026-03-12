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
    if (isSuperAdmin()) return ['Senior Batch','IGF & IYF Coordinator','ICF Coordinator'];
    if (isCategoryAdmin()) return [userProfile.adminCategory];
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
        id: date, totalScore: -35, dayPercent: -22,
        sleepTime:'NR', wakeupTime:'NR', chantingTime:'NR',
        readingMinutes:0, hearingMinutes:0, serviceMinutes:0, notesMinutes:0, daySleepMinutes:0,
        scores:{ sleep:-5, wakeup:-5, chanting:-5, reading:-5, hearing:-5, service:-5, notes:-5, daySleep:0 }
    };
}

function isPastDate(dateStr) {
    return dateStr < localDateStr(0);
}

// ─── SCORING ENGINE (shared between submit & edit) ───────
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

        const weeksData = {};
        snap.forEach(doc => {
            const wi = getWeekInfo(doc.id);
            if (!weeksData[wi.sunStr]) weeksData[wi.sunStr] = { label:wi.label, sunStr:wi.sunStr, days:{} };
            weeksData[wi.sunStr].days[doc.id] = doc.data();
        });

        const sortedWeeks = Object.keys(weeksData).sort((a,b) => b.localeCompare(a));
        const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const COLS = 19; // A to S

        // ── PROFILE HEADER (rows 0-6) ─────────────────────
        const today = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
        const profileRows = [
            ['SADHANA TRACKER — INDIVIDUAL REPORT', ...Array(COLS-1).fill('')],
            ['', ...Array(COLS-1).fill('')],
            ['Name',          uData.name            || userName, ...Array(COLS-2).fill('')],
            ['Position Level',uData.level           || 'N/A',    ...Array(COLS-2).fill('')],
            ['Chanting Level',uData.chantingCategory|| 'N/A',    ...Array(COLS-2).fill('')],
            ['Exact Rounds',  uData.exactRounds     || 'N/A',    ...Array(COLS-2).fill('')],
            ['Downloaded On', today,                              ...Array(COLS-2).fill('')],
            ['', ...Array(COLS-1).fill('')],  // spacer
        ];

        const dataArray = [...profileRows];
        const PROFILE_ROWS = profileRows.length; // = 8

        // Track row positions for styling
        const styleMap = {}; // rowIndex → 'weekHeader' | 'colHeader' | 'total' | 'summary' | 'data' | 'nr'

        sortedWeeks.forEach((sunStr, wi) => {
            const week   = weeksData[sunStr];
            const wRow   = dataArray.length; // week header row

            dataArray.push([`WEEK: ${week.label}`,...Array(COLS-1).fill('')]);
            styleMap[wRow] = 'weekHeader';

            const chRow  = dataArray.length; // column header row
            dataArray.push(['Date','Bed','M','Wake','M','Chant','M','Read(m)','M','Hear(m)','M','Seva(m)','M','Notes(m)','M','DaySleep(m)','M','Total','%']);
            styleMap[chRow] = 'colHeader';

            let T = { sl:0,wu:0,ch:0,rd:0,hr:0,sv:0,nt:0,ds:0, rdm:0,hrm:0,svm:0,ntm:0,dsm:0, tot:0 };
            const wStart = new Date(week.sunStr);

            for (let i = 0; i < 7; i++) {
                const cd  = new Date(wStart); cd.setDate(cd.getDate()+i);
                const ds  = cd.toISOString().split('T')[0];
                const lbl = `${DAY[i]} ${String(cd.getDate()).padStart(2,'0')}`;
                const e   = week.days[ds] || getNRData(ds);
                const dRow = dataArray.length;

                T.sl+=e.scores?.sleep??0; T.wu+=e.scores?.wakeup??0; T.ch+=e.scores?.chanting??0;
                T.rd+=e.scores?.reading??0; T.hr+=e.scores?.hearing??0; T.sv+=e.scores?.service??0;
                T.nt+=e.scores?.notes??0;  T.ds+=e.scores?.daySleep??0;
                T.rdm+=e.readingMinutes||0; T.hrm+=e.hearingMinutes||0;
                T.svm+=e.serviceMinutes||0; T.ntm+=e.notesMinutes||0;
                T.dsm+=e.daySleepMinutes||0; T.tot+=e.totalScore??0;

                dataArray.push([
                    lbl,
                    e.sleepTime||'NR',    e.scores?.sleep??0,
                    e.wakeupTime||'NR',   e.scores?.wakeup??0,
                    e.chantingTime||'NR', e.scores?.chanting??0,
                    e.readingMinutes||0,  e.scores?.reading??0,
                    e.hearingMinutes||0,  e.scores?.hearing??0,
                    e.serviceMinutes||0,  e.scores?.service??0,
                    e.notesMinutes||0,    e.scores?.notes??0,
                    e.daySleepMinutes||0, e.scores?.daySleep??0,
                    e.totalScore??0, (e.dayPercent??0)+'%'
                ]);
                styleMap[dRow] = (e.sleepTime === 'NR') ? 'nr' : 'data';
            }

            const fd      = fairDenominator(week.sunStr, Object.entries(week.days).map(([id,d])=>({id,sleepTime:d.sleepTime||''})));
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

        // ── BUILD WORKSHEET ───────────────────────────────
        const ws = XLSX.utils.aoa_to_sheet(dataArray);

        // Column widths
        ws['!cols'] = [10,8,4,8,4,8,4,9,4,9,4,9,4,9,4,11,4,8,6].map(w=>({wch:w}));

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
        const cats = visibleCategories();
        const userData = [];
        // Use Map: sunStr → label  (sunStr = YYYY-MM-DD, sorts correctly)
        const weekMap = new Map();

        for (const uDoc of usersSnap.docs) {
            const u = uDoc.data();
            if (!cats.includes(u.level||'Senior Batch')) continue;
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

        const rows = [['User Name','Position Level','Chanting Category',...allWeeks.map(w=>w.label.replace('_',' '))]];

        userData.forEach(({user,entries}) => {
            const row = [user.name, user.level||'Senior Batch', user.chantingCategory||'Level-1'];
            allWeeks.forEach(({ sunStr }) => {
                let tot = 0; const masterWeekEnts = [];
                const wSun = new Date(sunStr);
                for (let i=0;i<7;i++) {
                    const c  = new Date(wSun); c.setDate(c.getDate()+i);
                    const ds = c.toISOString().split('T')[0];
                    const en = entries.find(e=>e.date===ds);
                    tot += en ? en.score : -35;
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

            if (!userProfile.level) {
                document.getElementById('profile-title').textContent    = 'Complete Your Profile';
                document.getElementById('profile-subtitle').textContent = 'Please fill in your details to continue';
                document.getElementById('profile-name').value           = userProfile.name || '';
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
    const roleLabel = isSuperAdmin() ? '👑 Super Admin'
                    : isCategoryAdmin() ? `🛡️ Admin — ${userProfile.adminCategory}`
                    : (userProfile.level || 'Senior Batch');
    document.getElementById('user-display-name').textContent = userProfile.name;
    document.getElementById('user-role-display').textContent = roleLabel;
    showSection('dashboard');

    if (isSuperAdmin()) {
        // Show SA tabs, hide user tabs + gear btn
        document.getElementById('user-nav-tabs').style.display = 'none';
        document.getElementById('sa-nav-tabs').style.display   = '';
        document.getElementById('admin-menu-btn').classList.add('hidden');
        // Add class to body for CSS filter visibility
        document.body.classList.add('super-admin-view');
        // Load admin panel with WCR active
        switchTab('admin');
        setTimeout(() => {
            selectAdminSection('reports', document.querySelector('.sa-tab-btn.active'));
            loadAdminPanel();
        }, 50);
    } else {
        document.getElementById('user-nav-tabs').style.display = '';
        document.getElementById('sa-nav-tabs').style.display   = 'none';
        document.body.classList.remove('super-admin-view');
        if (isAnyAdmin()) {
            document.getElementById('admin-menu-btn').classList.remove('hidden');
        }
        switchTab('sadhana');
        setupDateSelect();
        refreshFormFields();
    }
    if (window._initNotifications) window._initNotifications();
}

// ═══════════════════════════════════════════════════════════
// 6. NAVIGATION
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════
// SUPER ADMIN — section switch + filters
// ═══════════════════════════════════════
window.switchSASection = (section, btn) => {
    // Update tab buttons
    document.querySelectorAll('.sa-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Use existing selectAdminSection to show correct sub-panel
    selectAdminSection(section, btn || document.querySelector('.sa-tab-btn'));
};

window.applyLevelFilter = (panel, level, btn) => {
    // Update filter buttons
    const filterBar = document.getElementById('filter-' + panel);
    if (filterBar) filterBar.querySelectorAll('.sa-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    if (panel === 'reports') {
        // Filter comparative table rows
        const rows = document.querySelectorAll('#comp-perf-table tbody tr');
        rows.forEach(row => {
            const lvlCell = row.querySelector('td:nth-child(2)');
            if (!lvlCell) return;
            const lvlText = lvlCell.textContent.trim();
            if (!level) { row.style.display = ''; return; }
            // Match abbreviated level text
            const match =
                (level === 'Senior Batch'         && lvlText === 'SB') ||
                (level === 'IGF & IYF Coordinator' && lvlText === 'IGF & IYF') ||
                (level === 'ICF Coordinator'       && lvlText === 'ICF');
            row.style.display = match ? '' : 'none';
        });
    }

    if (panel === 'usermgmt') {
        // Filter user cards by level
        const cards = document.querySelectorAll('#admin-users-list .user-card, #admin-users-list .admin-user-card');
        cards.forEach(card => {
            const meta = card.querySelector('.user-meta')?.textContent || '';
            if (!level) { card.style.display = ''; return; }
            const match =
                (level === 'Senior Batch'          && meta.includes('Senior Batch')) ||
                (level === 'IGF & IYF Coordinator' && meta.includes('IGF')) ||
                (level === 'ICF Coordinator'        && meta.includes('ICF'));
            card.style.display = match ? '' : 'none';
        });
    }

    if (panel === 'inactive') {
        // Filter inactive cards
        const cards = document.querySelectorAll('#admin-inactive-container .admin-user-card, #admin-inactive-container .inactive-card');
        cards.forEach(card => {
            const meta = card.querySelector('.inactive-meta, .user-meta')?.textContent || '';
            if (!level) { card.style.display = ''; return; }
            const match =
                (level === 'Senior Batch'          && meta.includes('SB')) ||
                (level === 'IGF & IYF Coordinator' && meta.includes('IGF')) ||
                (level === 'ICF Coordinator'        && meta.includes('ICF'));
            card.style.display = match ? '' : 'none';
        });
    }
};

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

// Fair denominator: 160 × days elapsed in week (past days + today if submitted)
function fairDenominator(sunStr, weekData) {
    // Count days from week start (Sunday) up to today
    // Skip pre-APP_START days, skip future days
    // Today counted only if submitted
    const today = localDateStr(0);
    let days = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(sunStr); d.setDate(d.getDate() + i);
        const ds = d.toISOString().split('T')[0];
        if (ds < APP_START) continue;          // skip pre-app days
        if (ds > today) break;                 // future day — stop
        if (ds === today) {
            // count today only if submitted (not NR)
            const submitted = weekData && weekData.find(e => e.id === ds && e.sleepTime !== 'NR');
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
                        const nr=getNRData(ds); wk.data.push(nr); wk.total+=nr.totalScore;
                    }
                    curr.setDate(curr.getDate()+1);
                }
            });

            container.innerHTML = '';
            weeksList.forEach(wi => {
                const wk     = weeks[wi.label];
                const wkFD   = fairDenominator(wi.sunStr, wk.data);
                const wkPct  = Math.round((wk.total / wkFD) * 100);
                const wkColor = wk.total < 0 ? '#dc2626' : wkPct < 30 ? '#d97706' : '#16a34a';
                const div    = document.createElement('div'); div.className='week-card';
                const bodyId = containerId.replace(/[^a-zA-Z0-9]/g,'') + '-wb-' + wi.sunStr;

                // Score cell styling — matches comparative table rules
                const scoreStyle = (v) => {
                    if (v < 0)  return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v < 10) return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v >= 20) return 'color:#15803d;font-weight:600;';
                    return 'color:#1a252f;';
                };
                const scoreVal = (v) => v < 0 ? `(${v})` : `${v}`;

                // Total score cell styling
                const totalStyle = (v) => {
                    if (v < 0)   return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v < 32)  return 'background:#FFFDE7;color:#b91c1c;font-weight:700;';
                    if (v >= 112) return 'color:#15803d;font-weight:700;';
                    return 'font-weight:600;color:#1a252f;';
                };
                const totalVal = (v) => v < 0 ? `(${v})` : `${v}`;

                // Build table rows — include edit button for super admin in modal
                const rowsHtml = wk.data.sort((a,b)=>b.id.localeCompare(a.id)).map((e, ri) => {
                    const isNR     = e.sleepTime === 'NR';
                    const stripeBg = ri % 2 === 0 ? '#ffffff' : '#f8fafc';
                    const rowBg    = isNR ? '#fff5f5' : stripeBg;
                    const editedBadge = e.editedAt
                        ? `<span class="edited-badge" onclick="showEditHistory(event,'${e.id}','${userId}')" title="View edit history">✏️</span>`
                        : '';
                    const editBtn = isSuperAdmin()
                        ? `<button onclick="openEditModal('${userId}','${e.id}')" class="btn-edit-cell" title="Edit this entry">Edit</button>`
                        : '';

                    const sc = e.scores || {};
                    const mkS = (v) => `<td style="${scoreStyle(v)}">${scoreVal(v)}</td>`;

                    return `<tr style="background:${rowBg};">
                        <td style="font-weight:600;">${e.id.split('-').slice(1).reverse().join('/')}${editedBadge}</td>
                        <td style="${isNR?'color:#b91c1c;font-weight:700;':''}">${e.sleepTime||'NR'}</td>${mkS(sc.sleep??0)}
                        <td style="${isNR?'color:#b91c1c;':''}">${e.wakeupTime||'NR'}</td>${mkS(sc.wakeup??0)}
                        <td>${e.chantingTime||'NR'}</td>${mkS(sc.chanting??0)}
                        <td>${e.readingMinutes||0}m</td>${mkS(sc.reading??0)}
                        <td>${e.hearingMinutes||0}m</td>${mkS(sc.hearing??0)}
                        <td>${e.serviceMinutes||0}m</td>${mkS(sc.service??0)}
                        <td>${e.notesMinutes||0}m</td>${mkS(sc.notes??0)}
                        <td>${e.daySleepMinutes||0}m</td>${mkS(sc.daySleep??0)}
                        <td style="${totalStyle(e.totalScore??0)}">${totalVal(e.totalScore??0)}</td>
                        <td>${e.dayPercent??0}%</td>
                        ${isSuperAdmin() ? `<td style="padding:2px 4px;">${editBtn}</td>` : ''}
                    </tr>`;
                }).join('');

                // Extra header col for edit button
                const editThCol = isSuperAdmin() ? '<th></th>' : '';

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
                            <th>Date</th><th>Bed</th><th>M</th><th>Wake</th><th>M</th><th>Chant</th><th>M</th>
                            <th>Read</th><th>M</th><th>Hear</th><th>M</th><th>Seva</th><th>M</th>
                            <th>Notes</th><th>M</th><th>Day Sleep</th><th>M</th><th>Total</th><th>%</th>
                            ${editThCol}
                        </tr></thead>
                        <tbody>${rowsHtml}</tbody></table>
                    </div>`;
                container.appendChild(div);
            });
        }, err => console.error('Snapshot error:', err));
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
                tot += en ? en.score : -35;
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
    const date  = document.getElementById('sadhana-date').value;
    const existing = await db.collection('users').doc(currentUser.uid).collection('sadhana').doc(date).get();
    if (existing.exists) { alert(`❌ Sadhana for ${date} already submitted! Contact admin for corrections.`); return; }

    const level = userProfile.level || 'Senior Batch';
    let slp     = document.getElementById('sleep-time').value;
    const wak   = document.getElementById('wakeup-time').value;
    const chn   = document.getElementById('chanting-time').value;
    const rMin  = parseInt(document.getElementById('reading-mins').value)||0;
    const hMin  = parseInt(document.getElementById('hearing-mins').value)||0;
    const sMin  = parseInt(document.getElementById('service-mins')?.value)||0;
    const nMin  = parseInt(document.getElementById('notes-mins')?.value)||0;
    const dsMin = parseInt(document.getElementById('day-sleep-minutes').value)||0;

    // ── Sleep time sanity check ──────────────────────────
    // If sleep time is between 04:00–20:00 it's likely a mistake (meant to enter night time)
    if (slp) {
        const [sh] = slp.split(':').map(Number);
        if (sh >= 4 && sh <= 20) {
            const goAhead = confirm(
                `⚠️ Bed Time Warning\n\n` +
                `You entered "${slp}" as bed time.\n` +
                `This looks like a daytime hour.\n\n` +
                `Did you mean night time? e.g. 23:00 instead of 11:00?\n\n` +
                `Tap OK if "${slp}" is correct.\n` +
                `Tap Cancel to go back and fix it.`
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
    alert(`✅ Submitted! Score: ${total} (${dayPercent}%)`);
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
    if (isSuperAdmin()) return; // superAdmin uses direct tabs, no drawer
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
    const cats      = visibleCategories();
    const filtered  = usersSnap.docs
        .filter(doc => cats.includes(doc.data().level||'Senior Batch'))
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
            <td class="comp-td comp-meta">${(u.level||'SB').replace(' Coordinator','').replace('Senior Batch','SB')}</td>
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
        if (u.role==='superAdmin') badge=`<span class="role-badge" style="background:#7e22ce;color:white;">👑 Super Admin</span>`;
        else if (u.role==='admin') badge=`<span class="role-badge" style="background:#d97706;color:white;">🛡️ ${u.adminCategory||''}</span>`;

        const safe = (u.name||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");

        let roleDropdown = '';
        if (isSuperAdmin()) {
            let opts = '<option value="" disabled selected>Change Role…</option>';
            if (u.role==='superAdmin') {
                opts += '<option value="demote">🚫 Revoke Super Admin</option>';
            } else if (u.role==='admin') {
                opts += `<option value="superAdmin">👑 Make Super Admin</option>
                    <option value="sb">⭐ Shift to Senior Batch</option>
                    <option value="cat:Senior Batch">🛡️ Make Admin — Senior Batch</option>
                    <option value="cat:IGF & IYF Coordinator">🛡️ Make Admin — IGF & IYF</option>
                    <option value="cat:ICF Coordinator">🛡️ Make Admin — ICF</option>
                    <option value="demote">🚫 Revoke Admin</option>`;
            } else {
                opts += `<option value="superAdmin">👑 Make Super Admin</option>
                    <option value="sb">⭐ Shift to Senior Batch</option>
                    <option value="cat:Senior Batch">🛡️ Make Admin — Senior Batch</option>
                    <option value="cat:IGF & IYF Coordinator">🛡️ Make Admin — IGF & IYF</option>
                    <option value="cat:ICF Coordinator">🛡️ Make Admin — ICF</option>`;
            }
            roleDropdown = `<select onchange="handleRoleDropdown('${uDoc.id}',this)"
                style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-size:12px;height:34px;background:white;cursor:pointer;flex:1;min-width:150px;max-width:200px;margin:0;">
                ${opts}</select>`;
        }

        card.innerHTML = `
            <div class="user-card-top">
                <span class="user-name">${u.name}</span>${badge}
                <div class="user-meta">${u.level||'Senior Batch'} · ${u.chantingCategory||'N/A'} · ${u.exactRounds||'?'} rounds</div>
            </div>
            <div class="user-actions">
                <button onclick="openUserModal('${uDoc.id}','${safe}')" class="btn-primary btn-sm">History</button>
                <button onclick="downloadUserExcel('${uDoc.id}','${safe}')" class="btn-success btn-sm">Excel</button>
                <button onclick="openProgressModal('${uDoc.id}','${safe}')" class="btn-purple btn-sm">Progress</button>
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
                        <div class="inactive-meta">${u.level||'Senior Batch'} · ${lastTxt} · <strong>${u.missedDays} days missed</strong></div>
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

window.handleRoleDropdown = async (uid, sel) => {
    const val = sel.value; sel.value='';
    if (!val) return;
    let newRole, cat=null, msg='';
    if (val==='superAdmin')          { newRole='superAdmin'; msg='👑 Make this user SUPER ADMIN?\nFull access to all categories.'; }
    else if (val==='sb')             { newRole='user'; cat=null; msg='⭐ Shift this devotee to SENIOR BATCH?\nThey will be moved out of their current batch.'; }
    else if (val.startsWith('cat:')) { newRole='admin'; cat=val.slice(4); msg=`🛡️ Assign as Category Admin for:\n"${cat}"?`; }
    else if (val==='demote')         { newRole='user';  msg='🚫 Revoke all admin access?'; }
    else return;
    if (!confirm(msg)) return;
    if (!confirm('Final confirmation?')) return;
    const updateData = { role:newRole, adminCategory:cat };
    if (val === 'sb') updateData.level = 'Senior Batch';
    await db.collection('users').doc(uid).update(updateData);
    alert(val === 'sb' ? '✅ Devotee shifted to Senior Batch!' : '✅ Role updated!');
    if (window._sendRoleNotification) window._sendRoleNotification(uid, '', val, cat);
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


// Show/hide Notes Revision based on Senior Batch level
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
    await db.collection('users').doc(currentUser.uid).set(data, { merge:true });
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
    document.getElementById('profile-title').textContent    = 'Edit Profile';
    document.getElementById('profile-subtitle').textContent = 'Update your details';
    document.getElementById('profile-name').value           = userProfile.name             || '';
    document.getElementById('profile-level').value          = userProfile.level            || '';
    document.getElementById('profile-chanting').value       = userProfile.chantingCategory || '';
    document.getElementById('profile-exact-rounds').value   = userProfile.exactRounds      || '';
    document.getElementById('cancel-edit').classList.remove('hidden');
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
        list.innerHTML = snap.docs.map(d => { const n=d.data(); const u=!n.read; return '<div style="padding:10px 12px;border-radius:8px;margin-bottom:6px;background:'+(u?'#eff6ff':'#f9fafb')+';border-left:3px solid '+(u?'#3b82f6':'#e5e7eb')+';"><div style="font-weight:600;font-size:13px;">'+( n.title||'')+'</div><div style="font-size:12px;color:#555;margin-top:2px;">'+(n.body||'')+'</div><div style="font-size:10px;color:gray;margin-top:4px;">'+(n.createdAt||'').slice(0,10)+'</div></div>'; }).join('');
        snap.docs.forEach(d => { if (!d.data().read) d.ref.update({read:true}); });
        const badge = document.getElementById('sidebar-notif-badge');
        if (badge) badge.classList.add('hidden');
    } catch(e) { console.warn(e); }
};

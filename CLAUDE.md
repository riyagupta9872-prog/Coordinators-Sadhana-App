# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Sadhana Tracker** is a Progressive Web App (PWA) for tracking daily spiritual practices (sadhana) for Krishna Parayan devotees at three coordinator levels: Senior Batch, IGF & IYF Coordinators, and ICF Coordinators.

## Running the App

There is no build system. This is a static vanilla JS/HTML app served directly. To develop:

- Open `index.html` in a browser, or serve with any static file server:
  ```
  npx serve .
  python -m http.server 8080
  ```
- No compilation, bundling, or test runner.

## Architecture

### Files

- [index.html](index.html) — Full single-page app UI (~72KB). All CSS is embedded. Contains all modals, forms, and layout for every role.
- [app.js](app.js) — Core application logic (~100KB, ~1929 lines). All Firebase interactions, scoring, UI rendering, and event handlers live here.
- [signup.html](signup.html) — Separate registration page. Creates Firebase Auth user + Firestore profile.
- [sw.js](sw.js) — Service Worker: pre-caches static assets, network-first fetch strategy, push notification handling, background sync (`sadhana-reminder` tag). Never caches Firestore API calls.
- [manifest.json](manifest.json) — PWA manifest.

### app.js Structure

The file is divided into ~20 logical sections (not modules). Key ones:

| Section | Lines | Purpose |
|---|---|---|
| Firebase Setup | 1–20 | Firebase config and initialization |
| Role Helpers | 21–32 | `isSuperAdmin()`, `isCategoryAdmin()`, `visibleCategories()` |
| Scoring Engine | 69–94 | `calculateScores()` — evaluates daily sadhana, returns score out of 160 |
| Excel Download | 99–338 | `downloadUserExcel()`, `downloadMasterReport()` using XLSX library |
| Auth | 339–371 | Login, logout, password reset/change |
| Dashboard Init | 373–418 | `initDashboard()` — entry point post-login, loads profile, sets up Firestore listeners |
| Super Admin | 523–632 | User management, role assignment, inactivity tracking |
| Reports Table | 634–755 | `loadReports()`, `fairDenominator()` — historical sadhana data display |
| Progress Charts | 757–883 | Chart.js rendering with week/month/all views |
| Edit Sadhana | 1186–1341 | Admin-only modal to edit past entries, recalculates scores |
| Performance Analytics | 1638–1926 | Best/weak performer ranking, ring charts, category breakdowns |

### Role System

Three roles stored in Firestore `users/{userId}.role`:
- `superAdmin` — sees all users across all levels and categories
- `admin` (Category Admin) — sees only users in their `adminCategory`
- `user` — sees only their own data

### Firestore Data Model

```
users/{userId}
  name, email, level, chantingCategory, exactRounds, role, adminCategory, notificationToken
  sadhana/{dateStr (YYYY-MM-DD)}
    sleepTime, wakeupTime, chantingTime (HH:MM strings)
    readingMinutes, hearingMinutes, serviceMinutes, notesMinutes, daySleepMinutes (numbers)
    totalScore, dayPercent, scores (computed by calculateScores())
```

### Scoring Algorithm (`calculateScores()`)

Max score: **160 points**. Components:

| Component | Max Points | Notes |
|---|---|---|
| Sleep time | 25 | Earlier is better |
| Wake-up time | 25 | Earlier is better |
| Chanting | 25 | More minutes = higher score |
| Reading | 25 | Senior Batch threshold: 40 min; others: 30 min |
| Hearing | 25 | Same thresholds as reading |
| Service | 25 (others) / 10 (SB) | Senior Batch gets lower weight |
| Notes | 15 | Senior Batch only (20+ min threshold) |
| Day sleep | 10 | Bonus if ≤60 minutes |

### External Libraries (CDN, no npm)

- **Firebase 8.10.1** — Auth, Firestore, Messaging (loaded via gstatic CDN)
- **Chart.js 4.4.0** — progress charts
- **XLSX 0.18.5** — Excel export

### PWA / Service Worker

Cache version is hardcoded in [sw.js](sw.js) (`CACHE_NAME = 'sadhana-tracker-v1'`). The app is deployed at path `/Coordinators-Sadhana-Tracker/` — asset paths in sw.js use this prefix. When adding new static assets, update `CACHE_NAME` and the pre-cache list in the `install` handler.

## Key Conventions

- UI events use `window.*` functions (e.g., `window.downloadUserExcel`) assigned in app.js and called from `onclick` attributes in index.html.
- Date keys in Firestore use `YYYY-MM-DD` format via `localDateStr()`.
- "Not Reported" days use `getNRData()` which creates a placeholder with 0 scores.
- `fairDenominator()` excludes Not Reported days when calculating score percentages to avoid penalizing missed entries unfairly.
- Firebase config is embedded directly in `app.js` and `signup.html` (no `.env` file).
- `t2m(timeStr, isSleep)` converts `HH:MM` strings to minutes for scoring; sleep times past midnight (00:00–03:00) are treated as 24:00–27:00.
- `activeListener` holds the current Firestore real-time subscription and is torn down/replaced on navigation to avoid stale listeners.

# Bryntum facts (verified 2026-10-17)

All quotes are verbatim. Local copies of fetched pages live in the session research folder (not committed).

## 1. Sponsor page — what the prize wants
Source: https://paypalaihackathon.devpost.com/details/bryntum (fetched 2026-10-17)

- "This prize goes to the project that puts Gantt, Scheduler, and/or Calendar to the best use, whether that's the cleanest timeline, the smartest resource booking, or an agent that drives the schedule itself."
- "**Agency delivery board (Gantt):** multi-client project timelines with payment tranches marked as dependencies, so a late PayPal payment visibly blocks the next phase"
- "**Agent-driven rescheduler (Gantt + Scheduler + Calendar):** an agent watches PayPal payment events and automatically moves or flags milestones, bookings, or events when a payment fails, succeeds late, or gets refunded"
- "**Start building with a 45-day trial:** https://bryntum.com/download … npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial"
- "For any trial issues or hackathon questions: Connect with the Bryntum team via the PayPal Discord"

## 2. Trial licence terms
### 2a. Download page — https://bryntum.com/download/ (fetched 2026-10-17)
- "Please complete and submit the form and we will send you a link to download your 45-day trial"
- "Full functionality for 45 days"

### 2b. EULA — https://bryntum.com/legal/Bryntum%20EULA.pdf (linked as an iframe from https://bryntum.com/products/license/; PDF footer "Bryntum EULA web v40 20260909"; clause 13 is on PDF page 18 of 25)
- 13.2(a): "the Licensor instead grants the Licensee and its Affiliates a revocable, non-exclusive, non-transferable and non-sublicensable licence to install, load, launch, access, run, execute, operate, and archive the Software Materials … solely for the Licensee's and its Affiliates' internal evaluation and review purposes to determine whether to enter into a paid licence of the Software and not for any other purpose;"
- 13.2(b)(i): "for a period of sixty (60) days, consisting of a trial period of thirty (30) days and a further period of thirty (30) days during which the parties can agree to enter into a Licence Quote"
- 13.2(d): "the Licensee acknowledges that the Software may place watermarks on output (including any software that incorporates any part of the Software), have limited functionality, function for a limited period of time, or limit the functionality or time of functioning of any output."
- 13.3(a): "provided for internal evaluation and review purposes only;"
- Preamble: "BY CLICKING ON THE “I ACCEPT” BUTTON BELOW OR BY DOWNLOADING, INSTALLING OR USING OUR SOFTWARE, YOU CONFIRM THAT YOU ACCEPT AND AGREE TO BE BOUND BY THESE TERMS"

### 2c. Docs
- https://bryntum.com/products/gantt/docs-llm/guide/Gantt/build-production.md line 3: "Bryntum offers trial distributions for you to experience our products and build your own demos."
- https://bryntum.com/products/gantt/docs-llm/guide/Gantt/npm/repository/public-repository-access.md lines 3–6: "Bryntum trial packages and framework wrappers are available on the public npm registry (**npmjs.com**). **No login or authorization required** - install directly using standard npm commands without any registry configuration or authentication."
- Installed package README `node_modules/@bryntum/gantt/README.md`:
  - :71 "This is a **trial package** with limited functionality."
  - :118 "**Trial bundles are not minified** and contain a watermark; that is expected, not a bug."
  - :47 "**Note:** Trial packages do not include minified bundles, source maps, or source files."
- `npm view @bryntum/gantt-trial` → `license = 'Commercial'`, version 7.3.7 published 2026-09-24T07:47:54Z.

### 2d. Interpretation for this hackathon (our reading, not legal advice)
- The **sponsor itself** tells entrants to build with the trial, and the docs say trials are for "build your own demos". This is the best evidence that a hackathon demo/judging build on the trial is the intended path.
- The EULA's literal wording ("internal evaluation … not for any other purpose") is stricter, and the trial length is inconsistent (45 days on the download page vs 30+30 days in EULA 13.2(b)(i)). → Listed under UNVERIFIED; action: ask the Bryntum team in the PayPal Discord for a one-line written OK.
- Safe practice we follow: **never commit Bryntum code** to our public repo. `package.json` only references the public npm alias; judges install it themselves. Our MIT licence covers our code only (stated in README).

## 3. Observed trial behaviour (our experiments)
- Watermark: the screenshots show faint diagonal "Bryntum" / "Trial Ve…" text in the empty Gantt area (`artifacts/screenshots/gantt-plan.png`, bottom of the timeline). No other trial banner, popup or nag dialog appeared.
- No network calls: during both page loads, Playwright logged **zero** requests to hosts other than 127.0.0.1 (`artifacts/logs/screenshot-report.json` → `externalRequests: []`).
- Install hook: `@bryntum/gantt-trial-lib` runs an obfuscated `postinstall` that rewrites `%LICENSE%` placeholders in the package's `.js` files with a per-install UUID (seen in `node_modules/@bryntum/gantt-trial-lib/build.js` after install). How (or whether) that UUID drives expiry could not be determined (bundle is obfuscated) → UNVERIFIED.
- Clock probe (`scripts/trial-clock-probe.ts`, log `artifacts/logs/trial-clock-probe.json`): with the browser clock faked by Playwright to 2026-10-17, 2026-11-09, 2026-11-30, 2026-12-31 and 2027-03-01, the Gantt rendered all 14 task bars, the engine check stayed 12/12, and no "expired" text or popup appeared (`artifacts/screenshots/trial-probe-clock-2027-03-01.png`). A browser-clock-only time bomb is therefore **not** observed; other mechanisms remain UNVERIFIED.
- Public evidence that an expiry exists: https://github.com/bryntum/support/issues/9220 (2024-05-20) "No data is loaded and trial expired dialog is being shown." (for a Salesforce demo; not the npm package).

## 4. `npm install` works here (proof)
```
$ npm install --no-audit --no-fund @bryntum/gantt@npm:@bryntum/gantt-trial@7.3.7 @bryntum/scheduler@npm:@bryntum/scheduler-trial@7.3.7 @bryntum/calendar@npm:@bryntum/calendar-trial@7.3.7
added 6 packages in 6s
EXIT=0
$ du -sh node_modules/@bryntum/*
 37M calendar   50M gantt   35M scheduler   (+ 16K each *-trial-lib)
```

## 5. Gantt API we rely on (cited from `node_modules/@bryntum/gantt/gantt.d.ts`, v7.3.7, 511,691 lines)
| Need | API | d.ts line |
|---|---|---|
| Project/engine | `export class ProjectModel extends Model` | 164460 |
| Wait for engine after a change | `commitAsync(): Promise<void>;` ("Project changes … are automatically committed on a buffer to the underlying graph based calculation engine. The engine performs it calculations async.") | 165180–165185 |
| Engine finished event | `onDataReady: ((event: { source: ProjectModel, isInitialCommit: boolean, records: Set<any> }) => void)` ("Fired when the engine has finished its calculations and the results has been written back to the records.") | 164950–164957 (event at 164957) |
| Data change event | `onChange: ((event: { source: ProjectModel, store: Store, action: 'remove'\|'removeAll'\|'add'\|…` | 164938 |
| Conflicts / cycles | `onSchedulingConflict`, `onCycle` | 165073, 164948 |
| Undo/redo (for "apply → undo") | `stm: CoreStateTrackingManager` | 164824 |
| Task model | `export class TaskModel extends TimeSpan` | 165968 |
| Constraint types | `constraintType: 'finishnoearlierthan'\|'finishnolaterthan'\|'mustfinishon'\|'muststarton'\|'startnoearlierthan'\|'startnolaterthan'\|'assoonaspossible'\|'aslateaspossible'\|null` | 166036 |
| Programmatic move (used in spike) | `setConstraint(constraintType: …, constraintDate?: Date): Promise<void>;` | 166467 |
| Programmatic move | `setStartDate(date: Date, keepDuration?: boolean): Promise<void>;` / `setDuration(...)` | 166509 / 166473 |
| Milestones | `convertToMilestone(): Promise<void>;` ("Converts this task to a milestone (start date will match the end date).") and `readonly isMilestone: boolean` (TimeSpan) | 166386, 300990 |
| Shift | `shift(amount: number, unit: DurationUnitShort): Promise<any>;` | 298729/301425 |
| Block without deleting | `inactive: boolean` ("stops taking part in the project scheduling") | 166166 |
| Deadline marker | `deadlineDate: string\|Date` | 166050 |
| Ghost of old plan | `baselines: BaselineConfig[]\|Store` (task) + feature `baselines?` | 166010, 174236 |
| Dependency model | `export class DependencyModel` with `fromTask` / `toTask` | 163037, 163045, 163053 |
| Dependency type & lag | `type: number`, `lag: number` (DependencyBaseModel) | 298101, 298081 |
| Dependency type enum | `StartToStart` (0), `StartToEnd` (1), `EndToStart` (2) "Finish-to-Start (`2`): The successor event cannot start before the predecessor finishes", `EndToEnd` (3) | 2919–2936 |
| Custom bar styling | `taskRenderer?: (context: { taskRecord: TaskModel, renderData: { cls, style, wrapperCls, iconCls } }, indicators) => …` | 175363 |
| Features used | `labels?`, `projectLines?`, `taskTooltip?`, `timeRanges?` | 174270, 174283, 174310, 174313 |

Online docs index: https://bryntum.com/products/gantt/docs/llms.txt (lists ProjectModel, DependencyModel, constraint columns, etc.).

**Verified in our spike:** after `task.setConstraint('startnoearlierthan', date)` + `project.commitAsync()`, the Bryntum engine's dates for all 12 tasks equal the dates computed by our own forward-pass scheduler (`artifacts/logs/screenshot-report.json` → `previewCheck: { checked: 12, mismatches: [] }`).

## 6. Views available for the Scheduler/Calendar part of the prize
- The **Gantt trial bundle itself** also exports `export class SchedulerPro extends SchedulerProBase` (gantt.d.ts:444417), `export class ResourceHistogram extends TimelineHistogram` (:426638), `export class ResourceUtilization extends ResourceHistogram` (:433403) and `export class Scheduler extends SchedulerBase` (:316309) — so a team-capacity view can come from the same package as the Gantt.
- `@bryntum/scheduler` (trial): `export class Scheduler extends SchedulerBase` (scheduler.d.ts:220592). `@bryntum/calendar` (trial): `export class Calendar extends Panel` (calendar.d.ts:17315).
- Sharing one `ProjectModel` between the Gantt and a SchedulerPro/ResourceHistogram (so a slipped phase moves the people's bookings too) is the plan for Phase B, but it has **not been tried yet** → UNVERIFIED.

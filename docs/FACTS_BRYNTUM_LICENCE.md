# Is a Bryntum trial OK for this hackathon and for judging? (checked 2026-10-25)

Short answer: **the hackathon itself tells entrants to build with the Bryntum trial, but no page we found says in
so many words that judges may run a trial build, and Bryntum's EULA trial clause is written for "internal
evaluation" only.** We found no Bryntum hackathon licence. Open questions are listed at the end; the action is to
ask the Bryntum team on the PayPal Discord (the channel the sponsor page names) for a one-line written OK.

This is our reading of public text, not legal advice. All quotes are verbatim. Pages were fetched with `curl` on
2026-10-25 ~20:18 UTC (`web_fetch` got HTTP 403 from Devpost; `curl` with a browser user agent got HTTP 200).
Raw copies are in the session research folder, not committed.

## 1. PayPal AI Hackathon (Devpost)

### 1a. Bryntum sponsor prize page — https://paypalaihackathon.devpost.com/details/bryntum
- "This prize goes to the project that puts Gantt, Scheduler, and/or Calendar to the best use, whether that's the
  cleanest timeline, the smartest resource booking, or an agent that drives the schedule itself."
- "Start building with a 45-day trial: https://bryntum.com/download"
- "npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial"
- "For any trial issues or hackathon questions:" / "Connect with the Bryntum team via the PayPal Discord!"

→ The sponsor's own prize page points entrants at the **trial** and at the public npm trial package. It does not
mention a hackathon licence, a licence key, or judging.

### 1b. Official rules — https://paypalaihackathon.devpost.com/rules
- Sponsor tools list: "Select Sponsor Tools you may include:" … "Bryntum" …
- Prize: "Best Use of Bryntum" … "All Eligible Submissions that use any Bryntum tools"
- "Use of the developer tools will be subject to the license agreement related thereto."
- "Third Party Integrations: If a Project integrates any third-party SDK, APIs and/or data, Entrant must be
  authorized to use them in accordance with any terms and conditions or licensing requirements of the tool."
- "The repository must be public and open source by including an open source license file."
- "The Entrant must make the Project available free of charge and without any restriction, for testing, evaluation
  and use by the Sponsor, Administrator and Judges until the Judging Period ends."
- "Judging Period: Tuesday Dec 1, 2026 (2:00 pm Pacific Time) – Tuesday Dec 15, 2026 (8:00 am Pacific Time)"
- "If at any time prior to the deadline, an Entrant or prospective Entrant believes that any term in the Official
  Rules is or may be ambiguous, they must submit a written request for clarification."

### 1c. Resources page — https://paypalaihackathon.devpost.com/resources
- Lists "Bryntum" under "Sponsor Resources". No licence wording.

## 2. Bryntum's own pages

### 2a. Download page — https://bryntum.com/download/
- "Please complete and submit the form and we will send you a link to download your 45-day trial"
- "Full functionality for 45 days"
- The form asks for "Name*", "Company*", "Work email*". (We did not submit it; we use the public npm trial
  packages the sponsor page names.)

### 2b. EULA — https://bryntum.com/legal/Bryntum%20EULA.pdf
The licence page https://bryntum.com/products/license/ embeds it (`src="/legal/Bryntum EULA.pdf"`). PDF footer:
"Bryntum EULA web v40 20260909" (same version as on 2026-10-17).
- 13.2(a): "the Licensor instead grants the Licensee and its Affiliates a revocable, non-exclusive,
  non-transferable and non-sublicensable licence to install, load, launch, access, run, execute, operate, and
  archive the Software Materials (as made available on the Quote Date) solely for the Licensee's and its
  Affiliates' internal evaluation and review purposes to determine whether to enter into a paid licence of the
  Software and not for any other purpose;"
- 13.2(b)(i): "for a period of sixty (60) days, consisting of a trial period of thirty (30) days and a further
  period of thirty (30) days during which the parties can agree to enter into a Licence Quote; or"
- 13.2(d): "the Licensee acknowledges that the Software may place watermarks on output (including any software
  that incorporates any part of the Software), have limited functionality, function for a limited period of time,
  or limit the functionality or time of functioning of any output."
- 13.3(a): "provided for internal evaluation and review purposes only;"

### 2c. Docs and the npm package
- https://bryntum.com/products/gantt/docs-llm/guide/Gantt/build-production.md: "Bryntum offers trial
  distributions for you to experience our products and build your own demos."
- `node_modules/@bryntum/gantt/README.md:71` "This is a **trial package** with limited functionality."
- `node_modules/@bryntum/gantt/README.md:118` "**Trial bundles are not minified** and contain a watermark; that
  is expected, not a bug."
- `npm view @bryntum/gantt-trial license` → `Commercial` (docs/FACTS_BRYNTUM.md §2c).

### 2d. Hackathon licence?
- Searched the fetched download, licence and store pages for "hackathon", "open source", "non-commercial",
  "startup", "unfunded": **no match** on any of them (the store page renders prices with JavaScript, so its
  text may be incomplete in a `curl` copy).
- A web search found no Bryntum page offering a hackathon or open-source licence. A search-engine summary
  mentioned a small-business option, but we could not find that text on a Bryntum page → not relied on.
- **Result: no Bryntum hackathon licence found.**

## 3. What this means for Tranche
| Question | What the text says | Our status |
|---|---|---|
| May entrants build with the trial? | Sponsor page: "Start building with a 45-day trial" + the npm trial command | **Yes, per the sponsor page.** |
| Is the trial OK for public judging? | Rules require free, unrestricted access for judges until 15 Dec 2026; EULA 13.2(a)/13.3(a) say "internal evaluation and review purposes only" | **Unclear.** No page says judges may run a trial build. |
| Watermark | EULA 13.2(d) "may place watermarks on output"; README:118 trial bundles "contain a watermark" | Kept visible; the e2e test asserts it on both views. |
| Does the trial stop working before judging ends? | Download page "45 days" vs EULA "thirty (30) days" + 30 days | **Unknown.** Our browser-clock probe up to 2027-03-01 saw no expiry (docs/FACTS_BRYNTUM.md §3), but other mechanisms are not ruled out. Judges install a fresh trial from npm, so their own install date applies. |
| Is Bryntum code in our MIT repo? | Rules: repo must be open source | **No.** Only the npm alias is in `package.json`; `node_modules/` is gitignored. README states MIT covers our code only. |

## 4. Open questions (UNVERIFIED) → ask on the PayPal Discord
1. "May hackathon judges run our public repo, which installs `@bryntum/*-trial` from npm, during the judging
   period (until 15 Dec 2026)?"
2. "Does the trial package stop working after a fixed time, and if so is it counted from `npm install`?"
3. "Is there a hackathon licence key we should use instead of the trial?"

No answer has been obtained yet; the user has to post these (we never use accounts other than yuxinshiu63, and
the Discord is outside this tool's reach).

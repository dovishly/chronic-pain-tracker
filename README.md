# Logbook

<<<<<<< HEAD
My symptoms change hour to hour, so I'm building a logbook that keeps up.

I couldn't find an app that did **everything** I needed it to do, so now here comes another one made for the frustrated "complex cases" who are hurting, yet somehow still expected to prove it's real. I'm tired, and I'm tired of getting ten minutes with a doctor and being told to come back in six months, in case the joint pain I've had for ten years magically goes away.

Every app I've tried makes me build an "entry" for everything. Right now I'm dozing off and it's getting harder to write this, but to log that I'd have to rate my mood first, as if I have the energy for that a dozen times a day.

Logbook is **one tap**.

- **Pain starts?** Tap *Pain*. It records until you tap it again. Rate the severity **in one tap** while it runs, and change it as it gets better or worse.
- **Took a rescue dose? Ate a snack? Fainted?** Tap it once and it's on the timeline.

Each tap lands on the timeline by itself the moment it happens. It changes all day, the same way I do.

Because every tap is its own timestamped record, the data is ready to analyze: how often something happens, how long it lasts, and what came right before it. Export it to a spreadsheet anytime.
=======
A personal tracker that runs as a Home Screen app on your phone. You choose what to track. It works offline and syncs to your own private database.

- **Today:** start/stop buttons for things that come and go (tap when it starts, tap again when it stops), one-tap moments, and the day's timeline: everything you logged, newest first, with each episode drawn as a bar alongside. Tap any entry to change its time or note.
- **Check in:** ratings, numbers, choices and notes. Every question is optional.
- **Settings:** add, rename, recolor, reorder and archive trackers. Connect sync. Export your data.

Nothing personal lives in this code. Your tracker names and entries are stored on your device and in your own Supabase project, never on GitHub.

---

## What you'll set up

1. **Supabase** (free): your private database. About 15 minutes.
2. **GitHub Pages** (free): hosts the app's files. About 10 minutes.
3. **Your iPhone:** add the app to your Home Screen and sign in. About 5 minutes.

Menu names below match the Supabase and GitHub websites as of late 2026. If something has moved, look for the closest match.

---

## 1. Supabase

### Create the project
1. Go to [supabase.com](https://supabase.com), sign up, and click **New project**.
2. Name it something generic, like `logbook`. Choose a strong database password and save it in your password manager. Pick the region nearest you.
3. Wait a minute or two for the project to finish setting up.

### Lock sign-ups and add yourself
1. Open **Authentication → Users**. Click **Add user → Create new user**, enter your email and a strong password, and tick **Auto Confirm User**. Save the password in your password manager: it's how you sign in to the app.
2. Open **Authentication → Sign In / Providers**. Make sure **Email** is enabled, and turn **off** "Allow new users to sign up." Now nobody else can create an account in your project.

### If you forget the password
The app can also sign you in with an emailed link: tap **Email me a link instead**. Supabase sends only a couple of these an hour. **Don't tap the link in the email**: it would sign in Safari instead of your Home Screen app, and it only works once. Press and hold it, tap **Copy**, and paste it into the app.

Optional: if your project lets you edit its emails (new free projects can't unless you add your own email provider under **Authentication → Emails → SMTP Settings**), you can make the email show a code to type instead. Choose the **Magic Link** template and replace the body with:
```html
<h2>Your Logbook sign-in code</h2>
<p style="font-size:24px;letter-spacing:4px"><b>{{ .Token }}</b></p>
<p>This code expires soon. If you didn't ask for it, ignore this email.</p>
```
The app accepts either the link or the code.

### Copy your connection details
1. Open **Project Settings → API Keys** (or **Settings → API**).
2. Copy the **Project URL** (it looks like `https://abcdefgh.supabase.co`).
3. Copy the **anon public** key, or the **publishable** key (starts with `sb_publishable_`). Either works.
   - **Never** use the `service_role` or **secret** key in the app. It bypasses all security.

The anon or publishable key is safe to put in the app. It only identifies your project; the security rules in `schema.sql` decide what anyone can see, and they allow only your signed-in account to read or write your rows.

---

## 2. GitHub Pages

GitHub builds the app from this code and publishes it each time you push a change.

1. Sign in at [github.com](https://github.com) and click **New repository**. Name it something generic, like `logbook`. It needs to be **Public** for free Pages hosting, which is fine because it holds only the app code.
2. Put this folder's contents in the repository with [GitHub Desktop](https://desktop.github.com) or `git push`. Don't use **Upload files** on the website: it skips the hidden `.github` folder that does the publishing. (`node_modules` and `dist` are listed in `.gitignore` and are never uploaded.)
3. Open **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. The "Test and deploy" run builds the app, runs the tests, and publishes it; it takes a few minutes. If it ran before step 3 and failed, click it and choose **Re-run all jobs**.
5. When it finishes, **Settings → Pages** shows your site address, like `https://yourname.github.io/logbook/`.

---

## 3. iPhone

1. Open your site address in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. **From now on, open Logbook from the Home Screen icon**, not from Safari. The Home Screen app keeps its own storage, and iOS keeps it safe from cleanup.
4. In the app, go to **Settings**:
   - Edit the starter trackers into your own: rename, change type, add new ones, archive the ones you don't need.
   - Under **Sync**, paste your Project URL and key, tap **Connect**, enter your email and password, and tap **Sign in**.
   - The first time, Sync says your project needs Logbook's tables. Tap **Copy setup SQL**, then **Open SQL Editor** (sign in to Supabase if asked), paste into the new query, and click **Run**. You should see "Success." Back in the app, tap **Sync now**. The analysis views use the time zone of the device you copy from. This step is easier on a computer: open your site there, connect and sign in the same way.

You stay signed in, and the app syncs every minute, whenever you open it, and shortly after every tap. Taps made offline wait on the phone and upload when you're back online.

**Using a second device?** Do the same steps there. If it has no entries of its own, it simply loads your account's data. If it does, the app asks before replacing anything.

---

## Your data

### Export for analysis
**Settings → Export for analysis** gives one `.zip` file (e.g. `logbook-2026-10-03.zip`). Open it to get a folder of five CSV files, ready for Excel, Numbers, or Claude (you can also hand Claude the `.zip` as it is). On iPhone the share sheet opens: choose **Save to Files**, then tap the file in Files to unzip it. Times are in the phone's time zone: the `datetime`, `start` and `end` columns look like `2026-10-03 12:35:26`, which spreadsheets read as a date and time. Columns ending in `_utc` hold the exact time in UTC.

| File | One row per | Use it for |
|---|---|---|
| `daily` | calendar day | Correlating across days, e.g. mood against sleep, headache minutes against coffee. Every day from your first entry to today is included, even empty ones. |
| `checkins` | check-in | Correlating answers given together. One column per question; each choice option gets its own 1/0 column. `during` names any episodes running at the time. |
| `episodes` | start/stop episode | When things started and ended, how long they lasted, how severe they got, and what happened in between: `timeline` lists everything logged while it ran, e.g. `10:00 started · 10:30 Moderate · 11:30 Coffee · 12:00 ended`. |
| `entries` | entry | The full log in order, with a `datetime` for every tap and answer. `during` names other episodes running at the time, so you can filter for everything logged during a headache. |
| `trackers` | tracker | What each tracker is: its type, group, levels (`1=Awful; 2=Bad; …`), unit and options. |

The files share ids and dates, so they join: `date` lines up across `daily`, `checkins` and `entries`; `episode_id` links an episode to its start, end and level entries; `checkin_id` links a check-in to its answers; `tracker_id` links everything to `trackers`.

**`daily` columns**, per tracker type:

| Type | Columns | Notes |
|---|---|---|
| Rating | `Mood (avg)` | Average of the day's answers |
| Number | `Water (total)`, `Water (avg)` | |
| Choices | `Activities: Exercise`, one per option | Times picked that day. Blank if the question wasn't answered that day. |
| Note | `Journal (text)` | The day's answers, joined with ` \| ` |
| Start / stop | `Headache (episodes)`, `Headache (minutes)`, `Headache (max level)` | Episodes started that day, minutes running that day (an episode across midnight counts toward both days), and the highest severity logged. |
| One-tap moment | `Coffee (count)` | |

Blank means "no answer"; 0 means "none". An episode that's still running counts up to now, and appears in `episodes` with status `ongoing`. Archived trackers are included when they have history.

### Export backup
**Settings → Export backup** saves everything as one JSON file. Do this now and then and keep it somewhere safe. Don't rely on the free plan's backups.

### Start over
**Settings → Start over** goes back to the starter trackers with no entries.
- **Reset this phone** erases everything on the phone, including your sign-in. What's already synced stays in Supabase; connect and sign in again to get it back.
- **Reset everywhere** (when signed in) deletes every tracker and entry in Supabase too, and your other phones follow at their next sync. It can't be undone, so export a backup first.

### In Supabase
**Table Editor** shows the raw tables. In the **SQL Editor**, three views give the same figures as the export:

- `entries_readable`: the `entries` file, including `datetime` and `during`.
- `episodes_readable`: the `episodes` file, including `start`, `end` and `timeline`.
- `daily_summary`: one row per day **per tracker** that has anything that day (columns `answers`, `value_avg`, `value_total`, `value_min`, `value_max`, `answer_text`, `episodes`, `episode_minutes`, `max_level`, `moments`), so you can filter and compare trackers in SQL.

For example, mood next to headache minutes, day by day:

```sql
select d.date, mood.value_avg as mood, coalesce(head.episode_minutes, 0) as headache_minutes
from (select distinct date from daily_summary) d
left join daily_summary mood on mood.date = d.date and mood.tracker = 'Mood'
left join daily_summary head on head.date = d.date and head.tracker = 'Headache'
order by d.date;
```

### How entries are stored
Underneath, every tap and answer is one row in `entries`; the tables above are built from it.

| kind | Meaning | Values |
|---|---|---|
| `start` / `end` | a start/stop tracker began or stopped | none |
| `level` | severity set while something was running | `value` = level, `text` = its label |
| `moment` | a one-tap moment | none |
| `answer` | a check-in answer | a rating (`value` + label in `text`), a number (`value`), one chosen option per row (`text`), or a note (`text`) |

Answers saved together share a `checkin_id`. Deleted entries are kept with `deleted = true` so deletions sync across devices. The exports and views leave them out.

---

## Good to know

- **Free-tier pause:** Supabase pauses free projects after about a week of no use. Daily logging keeps it awake. If it ever pauses, open the project in Supabase and click **Restore**; nothing is lost, and the app keeps saving on the phone meanwhile.
- **Email limits:** the free plan sends only a few sign-in emails per hour. You'll rarely need one, since you stay signed in.
- **Changing a tracker:** renaming is always safe. The type locks once a tracker has entries; archive it and make a new one instead. Archived trackers keep their history. **Delete** (in the tracker's editor, or next to an archived tracker) removes a tracker and all its entries on every device, for good.
- **Updating the app:** push the change to `main`. GitHub tests it and publishes it only if the tests pass (watch the **Actions** tab). If the update changed `schema.sql`, Sync says your project needs Logbook's tables: copy the setup SQL and run it again as when you set up, then tap **Sync now**. Your entries stay on the phone in the meantime.

## Working on the code

You need Node.js. Run these in this folder.

### Every day

| Command | What it does |
|---|---|
| `npm install` | Installs what the app needs. Once, and again after pulling changes that touch `package.json`. |
| `npm run dev` | Runs the app at the address it prints. Saving a file updates the page by itself. In its terminal: `r` + Enter restarts it, `o` + Enter opens the browser, `q` + Enter quits. Restart after `npm install`. |
| `npm run typecheck` | Checks the code for type errors without building. |
| `npm run build` | Builds the published version into `dist/` (GitHub does this for you on every push). |
| `npm run preview` | Serves the built `dist/` locally, to check the published version before pushing. |

### Tests

The tests need Python packages once: `pip install pytest playwright pgserver "psycopg[binary]" && python -m playwright install chromium`.

| Command | What it does |
|---|---|
| `npm test` | Builds, then runs everything below. GitHub runs this on every push and only publishes if it passes. |
| `npm run test:e2e` | Builds, then drives the app in a hidden browser against a fake Supabase. |
| `npm run test:schema` | Checks `schema.sql` in a throwaway database: security rules and the analysis views. |

### Testing with a local Supabase

A complete Supabase on your Mac, so you can try sign-in and sync without touching your real project. It needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) running and the Supabase CLI (`brew install supabase/tap/supabase`).

| Command | What it does |
|---|---|
| `npm run db:start` | Starts it (the first time downloads it, a few minutes) and loads `schema.sql` into a new database. Your local data is kept between starts. |
| `npm run db:stop` | Stops it. Data is kept for next time. |
| `npm run db:user -- you@example.com` | Adds a user you can sign in as (password `logbook-local`, or give one after the email), and prints the project URL and key to paste into the app. |
| `npm run db:apply` | Applies your latest `schema.sql` and keeps the data. Use this after changing `schema.sql`. |
| `npm run db:reset` | Wipes the local database and loads `schema.sql` fresh. Add your user again afterwards. |

To try it: `npm run db:start`, `npm run db:user -- me@example.com`, `npm run dev`, then in the app go to **Settings → Sync**, paste the URL and key, and sign in with that email and `logbook-local`.

- **Sign-in emails** (for **Email me a link instead**) don't really go out: read them at `http://127.0.0.1:54324`, where they show a code. Any address works, since nothing is really sent.
- **Studio**, the local database dashboard, is at `http://127.0.0.1:54323`: tables, the SQL Editor, users.
- The app accepts `http://` project URLs only for addresses on your Mac or home network, and only when it runs locally (`npm run dev`), not from GitHub Pages.
- To try it from your phone on the same Wi-Fi: `npm run dev -- --host`, open the Network address it prints, and use `http://<your Mac's IP>:54321` as the project URL.

### What updates by itself

- **Code and styles** while `npm run dev` runs: yes, on save.
- **The local database** after changing `schema.sql`: no, run `npm run db:apply`.
- **The app on your phone**: when you push to `main` and the tests pass; the phone picks it up the second time you open the app.

## Troubleshooting

| What you see | What to do |
|---|---|
| "That email isn't a user in this project" | Add yourself under Authentication → Users (step 1, "Lock sign-ups"). |
| Tapped the link and the app is still signed out | The link signed in Safari instead, and it only works once. Tap **Send a new email**, then press and hold the new link, **Copy**, and paste it into the app. |
| "Your Supabase project needs Logbook's tables" | In **Settings → Sync**, tap **Copy setup SQL**, run it in the Supabase SQL Editor (it's safe to run again), then tap **Sync now**. |
| "Sync problem" | Tap the status pill to see the message. Check the URL and key in Settings, and that the project isn't paused. |
| "Offline · 3 waiting" | Those entries are saved on the phone and upload automatically when you're back online. |
| "Email rate limit exceeded" | Supabase sends only a couple of sign-in emails an hour. Sign in with your password, or wait an hour. |
| Signed out after a long time away | Sign in again. Your entries on the phone are still there. |
>>>>>>> app

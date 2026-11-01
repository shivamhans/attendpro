# AttendPro — Smart Attendance Tracker

AttendPro is a responsive, browser-based attendance tracker designed to help students record school attendance, understand their official and actual attendance percentages, and plan leave while keeping track of a 75% attendance target.

## Features

- **Account access:** sign up, sign in, sign out, and password recovery through Supabase Auth.
- **Daily attendance calendar:** record Present, Absent, Holiday, or Medical Leave, with full-day and half-day durations where applicable.
- **Attendance dashboard:** view working days, present days, half days, absences, holidays, medical leave, and attendance progress.
- **Smart leave predictor:** estimate safe leave allowance or the number of attended days needed to recover to the target.
- **Statistics and charts:** review attendance trends and monthly breakdowns, with official and actual attendance views.
- **Historical attendance import:** use the guided import workflow to enter previous attendance figures and preserve a reported historical summary.
- **Edit and remove records:** update logged attendance and recalculate statistics.
- **Light and dark themes:** theme preference is saved in browser local storage.
- **Responsive interface:** designed for desktop and mobile screens, with accessible labels and status feedback.

## Attendance rules

AttendPro's calculation engine uses a 75% official attendance target by default. Its documented policy is:

| Record | Working-day contribution | Actual attendance | Official attendance |
| --- | ---: | ---: | ---: |
| Present — full day | 1.0 | 1.0 | 1.0 |
| Present — half day | 0.5 | 0.5 | 0.5 |
| Absent — full day | 1.0 | 0.0 | 0.0 |
| Absent — half day | 0.5 | 0.0 | 0.0 |
| Medical leave — full day | 1.0 | 0.0 | 1.0 |
| Medical leave — half day | 0.5 | 0.0 | 0.5 |
| Holiday | excluded | excluded | excluded |

Sundays and second Saturdays are treated as non-working days by the application and are derived from the date. Official attendance credits medical leave as present, while actual attendance does not. Confirm that these rules match your institution's policy before relying on the calculations.

## Tech stack

- HTML5
- CSS3 (responsive styling and light/dark themes)
- Vanilla JavaScript
- [Supabase](https://supabase.com/) for authentication and PostgreSQL data storage
- [Chart.js](https://www.chartjs.org/) for charts
- [Phosphor Icons](https://phosphoricons.com/) for interface icons
- [Google Fonts — Inter](https://fonts.google.com/specimen/Inter)
- [Vercel](https://vercel.com/) deployment configuration

No Node.js build step or package installation is required for the current static frontend. Third-party browser libraries are loaded from CDNs.

## Project structure

```text
attendpro/
├── index.html          # App views, dashboard, calendar, statistics, and modals
├── style.css           # Main application styles and theme system
├── import.css          # Styles for historical attendance import wizard
├── script.js           # Authentication, attendance CRUD, calculations, UI rendering
├── import.js           # Historical attendance import and reset workflow
├── supabase_setup.sql  # Database tables, constraints, indexes, and RLS policies
├── vercel.json         # Deployment security headers
└── README.md
```

## Setup

### 1. Create a Supabase project

Create a project in the [Supabase Dashboard](https://supabase.com/dashboard). The application uses Supabase Auth and the PostgreSQL tables `public.attendance` and `public.historical_summary`.

### 2. Configure the database

1. Open your Supabase project's **SQL Editor**.
2. Review `supabase_setup.sql` and run it against the project.
3. In **Authentication → URL Configuration**, set the site URL and allowed redirect URLs for your local development URL and deployed site.
4. Confirm email/password authentication is enabled as desired.

The SQL setup enables row-level security (RLS) and policies that scope attendance and historical summary records to `auth.uid()`. Review the SQL and policies before using the app with real data. The script includes migration statements for existing attendance tables; back up important data before applying schema changes to an existing production database.

### 3. Configure the frontend

`script.js` currently initializes the Supabase client from constants near the top of the file (`SUPABASE_URL` and `SUPABASE_KEY`). Replace these with your own project's URL and **publishable/anon key** if you are deploying to a different Supabase project. Keep only a publishable client key in browser code; **never put a Supabase service-role key or other server secret in frontend files**.

For a more maintainable setup, consider moving project-specific values into a small configuration file that is excluded from commits if appropriate, while remembering that browser-delivered client configuration is visible to users and must be protected by RLS.

### 4. Run locally

Because this is a static site, you can serve the project directory with any local static HTTP server. For example, with Python installed:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000> in your browser. Run the command from the directory containing `index.html`. Using a local server is preferable to opening the HTML file directly, particularly for authentication redirect flows.

### 5. Deploy to Vercel

1. Push the project to a Git repository.
2. Import the repository into [Vercel](https://vercel.com/).
3. Deploy it as a static site; no build command is needed for the current file structure.
4. Add the deployed URL to Supabase's allowed redirect URLs and site URL settings.
5. Test sign-up, sign-in, password recovery, attendance creation/edit/delete, historical import, and chart rendering on the deployed URL.

The included `vercel.json` configures response security headers. Confirm the final headers and authentication redirects after deployment.

## Data and privacy

- Authentication is provided by Supabase Auth.
- Attendance data is stored in Supabase, not solely in the browser.
- RLS policies in `supabase_setup.sql` are intended to isolate each user's records.
- The theme preference is stored in local storage in the browser.
- Do not commit service-role keys, passwords, or other secrets.
- Before production use, verify RLS policies, allowed redirect URLs, database backups, and the application's data handling against your own requirements.

## Troubleshooting

- **Sign-in or sign-up fails:** check the Supabase URL/key in `script.js`, Auth provider settings, email confirmation settings, and browser console/network errors.
- **Password recovery link does not return to the app:** verify Supabase Site URL and redirect allow-list settings.
- **Attendance cannot be saved or loaded:** check that the SQL setup has been applied, the user is authenticated, RLS is enabled with the intended policies, and the browser console shows no database errors.
- **Charts do not appear:** confirm the Chart.js CDN can load and inspect the browser console for errors.
- **Styles or icons are missing:** check network access to the external font, icon, and JavaScript CDNs.

## Contributing

Issues and pull requests are welcome. Please include steps to reproduce bugs and describe the expected behaviour. Test authentication, attendance calculations, calendar interactions, and historical import flows when changing related code.

## License

No license file was included in the project files inspected for this README. Unless a license is added, assume the project is not licensed for reuse or redistribution by others.

---

Built by **Shivam Hans**.

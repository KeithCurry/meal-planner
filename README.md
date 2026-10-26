# Household Meal Planner

A static site (GitHub Pages) backed by Supabase. Features: recipe library with search and tags, a weekly planner with servings per meal, and a grocery list that scales ingredients and combines duplicates.

## 1. Supabase setup (free tier)

1. Create a project at supabase.com.
2. Open **SQL Editor**, paste the contents of `schema.sql`, and run it.
3. **Authentication > Sign In / Providers**: keep Email enabled. Turn off **Allow new users to sign up** so only accounts you create can log in.
4. **Authentication > Users > Add user**: create your account with your email and your household members' emails.
5. **Authentication > URL Configuration**: set **Site URL** to your GitHub Pages address, for example `https://yourname.github.io/meal-planner/`.
6. **Project Settings > API**: copy the Project URL and the `anon public` key into `config.js`.

## 2. GitHub Pages

1. Create a repository (for example `meal-planner`) and push these files to it.
2. **Settings > Pages**: set Source to *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open the Pages URL once it's live. Sign in with your email to receive a link.

## Notes

- The anon key is meant to be public. Row Level Security in `schema.sql` means each signed-in user can only read and write their own rows.
- Grocery checkboxes are stored in the browser, per week, so they won't sync between devices.
- Use the app for personal, household use only.

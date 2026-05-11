# CycleCoach AI — Setup Guide

## Project structure
```
cyclecoach/
  server.js          ← backend: receives Garmin webhooks, serves the app
  package.json       ← project config and dependencies
  .env               ← your secret keys (never share this file)
  public/
    index.html       ← the mobile app
    manifest.json    ← makes it installable on your phone
    sw.js            ← service worker (offline support)
```

## Step-by-step setup (see full guide in Claude chat)
1. npm install
2. Create .env from .env.example
3. Set up Supabase database
4. Deploy to Railway/Render (backend) + Vercel (frontend)
5. Register Garmin Health API
6. Install on phone via Add to Home Screen

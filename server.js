// ─────────────────────────────────────────────────────────────
// CycleCoach AI — Backend Server
// Handles: Strava OAuth, Strava webhook, ride API, file serving
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const path       = require('path');
const express    = require('express');
const cors       = require('cors');
const https      = require('https');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// Visit /ping to confirm the server is alive
// ─────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', message: 'CycleCoach is running 🚴' });
});

// Serve the app on root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ─────────────────────────────────────────────────────────────
// STRAVA OAUTH — Step 1: redirect user to Strava login
//
// How it works:
// 1. User visits /strava/connect in their browser
// 2. They get sent to Strava's login page
// 3. After they approve, Strava redirects back to /strava/callback
// 4. We exchange the code for tokens and save them
// ─────────────────────────────────────────────────────────────
app.get('/strava/connect', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.STRAVA_CLIENT_ID,
    redirect_uri:  process.env.APP_URL + '/strava/callback',
    response_type: 'code',
    scope:         'activity:read_all',
    approval_prompt: 'auto',
  });
  res.redirect('https://www.strava.com/oauth/authorize?' + params.toString());
});


// ─────────────────────────────────────────────────────────────
// STRAVA OAUTH — Step 2: handle the callback after user approves
// ─────────────────────────────────────────────────────────────
app.get('/strava/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`
      <h2>❌ Strava connection failed</h2>
      <p>${error}</p>
      <a href="/">Back to app</a>
    `);
  }

  try {
    // Exchange the temporary code for real access tokens
    const tokens = await stravaPost('/oauth/token', {
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
    });

    if (!tokens.access_token) throw new Error('No access token received');

    // Save tokens to database so we can refresh them later
    await supabase.from('strava_tokens').upsert({
      athlete_id:    tokens.athlete.id.toString(),
      athlete_name:  tokens.athlete.firstname + ' ' + tokens.athlete.lastname,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    tokens.expires_at,
    }, { onConflict: 'athlete_id' });

    console.log(`✅ Strava connected for: ${tokens.athlete.firstname}`);

    // Kick off a background sync of their recent rides
    syncRecentRides(tokens.athlete.id.toString(), tokens.access_token);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; text-align: center; padding: 60px 20px; background: #f5f5f7; }
          .card { background: white; border-radius: 16px; padding: 40px 24px; max-width: 320px; margin: 0 auto; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
          h2 { color: #0a0a0a; margin-bottom: 8px; }
          p { color: #666; margin-bottom: 24px; line-height: 1.6; }
          a { display: inline-block; background: #1a73e8; color: white; padding: 12px 28px; border-radius: 100px; text-decoration: none; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size:48px;margin-bottom:16px">🎉</div>
          <h2>Strava connected!</h2>
          <p>Hey ${tokens.athlete.firstname}! Your rides are syncing now. Future rides will appear automatically within 2 minutes of finishing.</p>
          <a href="/">Open CycleCoach</a>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('Strava OAuth error:', err.message);
    res.status(500).send(`
      <h2>❌ Something went wrong</h2>
      <p>${err.message}</p>
      <a href="/">Back to app</a>
    `);
  }
});


// ─────────────────────────────────────────────────────────────
// STRAVA WEBHOOK — Verification (Strava checks this once when
// you register the webhook in the Strava developer dashboard)
// ─────────────────────────────────────────────────────────────
app.get('/strava/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Strava sends your verify token back — confirm it matches
  if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
    console.log('✅ Strava webhook verified');
    res.json({ 'hub.challenge': challenge });
  } else {
    console.error('❌ Strava webhook verification failed');
    res.status(403).json({ error: 'Forbidden' });
  }
});


// ─────────────────────────────────────────────────────────────
// STRAVA WEBHOOK — New activity received
//
// Strava calls this every time you finish a ride and it syncs.
// This is the core of the auto-sync feature.
// ─────────────────────────────────────────────────────────────
app.post('/strava/webhook', async (req, res) => {
  // Respond immediately — Strava expects a fast response
  res.status(200).json({ received: true });

  const event = req.body;
  console.log('📡 Strava event:', event.object_type, event.aspect_type, event.object_id);

  // We only care about new or updated activities (not deletions)
  if (event.object_type !== 'activity') return;
  if (event.aspect_type !== 'create' && event.aspect_type !== 'update') return;

  try {
    const athleteId = event.owner_id.toString();

    // Get stored tokens for this athlete
    const { data: tokenRow } = await supabase
      .from('strava_tokens')
      .select('*')
      .eq('athlete_id', athleteId)
      .single();

    if (!tokenRow) {
      console.error('No tokens found for athlete:', athleteId);
      return;
    }

    // Make sure the access token is still valid, refresh if needed
    const accessToken = await getValidToken(tokenRow);

    // Fetch full activity details from Strava
    const activity = await stravaGet(`/activities/${event.object_id}`, accessToken);

    // Only process cycling activities
    const cyclingTypes = ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide', 'EBikeRide'];
    if (!cyclingTypes.includes(activity.type)) {
      console.log(`Skipping non-cycling activity: ${activity.type}`);
      return;
    }

    const ftp = await getAthletesFTP(athleteId);
    const ride = stravaActivityToRide(activity, ftp);

    // Save to database — upsert handles duplicates gracefully
    const { error } = await supabase
      .from('rides')
      .upsert(ride, { onConflict: 'strava_id' });

    if (error) {
      console.error('DB error saving ride:', error.message);
    } else {
      console.log(`✅ Saved: "${ride.name}" — ${ride.dist}km, ${ride.avg_power}W, TSS ${ride.tss}`);
    }

  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});


// ─────────────────────────────────────────────────────────────
// SYNC STATUS — check if Strava is connected
// ─────────────────────────────────────────────────────────────
app.get('/api/strava/status', async (req, res) => {
  const { data } = await supabase
    .from('strava_tokens')
    .select('athlete_name, athlete_id')
    .limit(1)
    .single();

  res.json({
    connected: !!data,
    athlete:   data?.athlete_name || null,
  });
});


// ─────────────────────────────────────────────────────────────
// MANUAL SYNC — fetch the last 30 rides from Strava right now
// Useful if the user just connected and wants all their rides
// ─────────────────────────────────────────────────────────────
app.post('/api/strava/sync', async (req, res) => {
  try {
    const { data: tokenRow } = await supabase
      .from('strava_tokens')
      .select('*')
      .limit(1)
      .single();

    if (!tokenRow) return res.status(400).json({ error: 'Strava not connected' });

    const accessToken = await getValidToken(tokenRow);
    const count = await syncRecentRides(tokenRow.athlete_id, accessToken, 30);

    res.json({ synced: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// RIDES API
// ─────────────────────────────────────────────────────────────
app.get('/api/rides', async (req, res) => {
  const { data, error } = await supabase
    .from('rides')
    .select('*')
    .order('date', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/rides/missed', async (req, res) => {
  const { date, name, reason } = req.body;
  const { data, error } = await supabase
    .from('rides')
    .insert({ name: name || 'Planned session', date, completed: false, missed_reason: reason });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


// ─────────────────────────────────────────────────────────────
// FTP API
// ─────────────────────────────────────────────────────────────
app.post('/api/ftp', async (req, res) => {
  const { ftp, date } = req.body;
  const { error } = await supabase
    .from('ftp_history')
    .insert({ ftp, date: date || new Date().toISOString().split('T')[0] });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ saved: true });
});

app.get('/api/ftp', async (req, res) => {
  const { data, error } = await supabase
    .from('ftp_history')
    .select('*')
    .order('date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────

// Convert a Strava activity object into our ride format
function stravaActivityToRide(a, ftp) {
  const avgPower = a.average_watts   || null;
  const np       = a.weighted_average_watts || (avgPower ? Math.round(avgPower * 1.05) : null);
  const tss      = calcTSS(np || avgPower, a.moving_time, ftp);

  return {
    strava_id:  a.id.toString(),
    name:       a.name || 'Cycling ride',
    date:       a.start_date_local?.split('T')[0],
    dur:        Math.round((a.moving_time || 0) / 60),          // minutes
    dist:       Math.round((a.distance || 0) / 100) / 10,       // km
    elev:       Math.round(a.total_elevation_gain || 0),        // metres
    avg_power:  avgPower,
    np:         np,
    max_power:  a.max_watts || null,
    avg_hr:     a.average_heartrate || null,
    max_hr:     a.max_heartrate     || null,
    cad:        a.average_cadence   || null,
    tss:        tss,
    completed:  true,
    strava_url: `https://www.strava.com/activities/${a.id}`,
  };
}

// Calculate TSS from normalised power, duration, and FTP
function calcTSS(power, durationSeconds, ftp) {
  if (!power || !durationSeconds || !ftp) return null;
  const hours = durationSeconds / 3600;
  const IF    = power / ftp;
  return Math.round(IF * IF * hours * 100);
}

// Get the athlete's current FTP from our database
async function getAthletesFTP(athleteId) {
  const { data } = await supabase
    .from('ftp_history')
    .select('ftp')
    .order('date', { ascending: false })
    .limit(1)
    .single();
  return data?.ftp || null;
}

// Sync recent rides from Strava (called on first connect)
async function syncRecentRides(athleteId, accessToken, limit = 10) {
  try {
    const activities = await stravaGet(
      `/athlete/activities?per_page=${limit}&page=1`,
      accessToken
    );

    const cyclingTypes = ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide', 'EBikeRide'];
    const rides = activities
      .filter(a => cyclingTypes.includes(a.type))
      .map(a => stravaActivityToRide(a, null));

    if (rides.length) {
      await supabase.from('rides').upsert(rides, { onConflict: 'strava_id' });
      console.log(`✅ Synced ${rides.length} recent rides`);
    }
    return rides.length;
  } catch (err) {
    console.error('Sync error:', err.message);
    return 0;
  }
}

// Check if token is expired and refresh if needed
async function getValidToken(tokenRow) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const isExpired  = tokenRow.expires_at <= nowSeconds + 300; // refresh 5 min early

  if (!isExpired) return tokenRow.access_token;

  console.log('🔄 Refreshing Strava token...');

  const refreshed = await stravaPost('/oauth/token', {
    client_id:     process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: tokenRow.refresh_token,
    grant_type:    'refresh_token',
  });

  // Save the new token
  await supabase
    .from('strava_tokens')
    .update({
      access_token:  refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at:    refreshed.expires_at,
    })
    .eq('athlete_id', tokenRow.athlete_id);

  return refreshed.access_token;
}

// Make a GET request to the Strava API
function stravaGet(endpoint, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.strava.com',
      path:     '/api/v3' + endpoint,
      method:   'GET',
      headers:  { Authorization: 'Bearer ' + accessToken },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.errors) reject(new Error(data.message || 'Strava API error'));
          else resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Make a POST request to the Strava API
function stravaPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options  = {
      hostname: 'www.strava.com',
      path:     endpoint,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}


// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚴 CycleCoach running on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Connect: http://localhost:${PORT}/strava/connect\n`);
});
